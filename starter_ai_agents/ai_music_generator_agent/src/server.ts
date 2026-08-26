/**
 * starter_ai_agents/ai_music_generator_agent/src/server.ts
 *
 * 原生 http 服务(后端零运行时框架依赖):
 *   - GET  /                → 生产:dist/frontend/index.html(React 构建产物)
 *   - GET  /<static>        → dist/frontend 静态资源 + SPA fallback
 *   - GET  /api/config      → 默认模型/模型目录/ModelsLab 就绪状态(JSON)
 *   - POST /api/session/new → 开启新会话(返回新 sessionId;旧会话由内存淘汰)
 *   - POST /api/chat        → SSE 流式:音乐生成对话(generate_music 工具)
 *   - GET  /api/audio       → 音频代理(仅代理本服务生成的 MP3;支持 Range/下载)
 *
 * 开发态前端由 Vite(5173)提供,/api 经 Vite 代理到本服务(3011):
 *   pnpm --filter ai-music-generator-agent dev
 * 生产态单端口:先 build(vite build + tsc),再 serve:
 *   pnpm --filter ai-music-generator-agent serve
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveModelChoice } from './config.js';
import { createRuntimeRegistry, streamChat, type ChatProgress } from './runtime.js';
import { findGenerationByUrl } from './tools/modelslab.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 前端构建产物目录:开发态(src/)与生产态(dist/)都解析到 approot/dist/frontend
const PUBLIC_DIR = path.resolve(__dirname, '../dist/frontend');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** 前端提交的模型选择(LLM Key + ModelsLab Key) */
interface PickedModel {
  provider?: string;
  modelId?: string;
  apiKey?: string;
  modelslabKey?: string;
}

async function main() {
  const config = loadConfig();

  // Runtime 注册表:按用户选择的模型按需构建并缓存(带 generate_music 工具)
  const registry = createRuntimeRegistry(config.modelslabKey);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);

      // ── GET /api/config ───────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/config') {
        return json(res, 200, {
          provider: config.provider,
          model: config.modelId,
          llmReady: config.llmReady,
          defaultModel: { provider: config.provider, modelId: config.modelId },
          models: config.models,
          musicReady: config.musicReady,
        });
      }

      // ── POST /api/session/new(开启新会话)─────────────────────
      if (req.method === 'POST' && url.pathname === '/api/session/new') {
        return json(res, 200, { sessionId: randomUUID() });
      }

      // ── POST /api/chat (SSE 流式) ────────────────────────────
      if (req.method === 'POST' && url.pathname === '/api/chat') {
        return handleChat(req, res, { registry, config });
      }

      // ── GET /api/audio(音频代理:播放/下载)───────────────────
      if (req.method === 'GET' && url.pathname === '/api/audio') {
        return handleAudioProxy(req, res, url);
      }

      // ── 静态资源(生产态;开发态由 Vite 提供)──────────────────────
      if (req.method === 'GET') {
        return serveStatic(url.pathname, res);
      }

      return json(res, 405, { error: 'Method Not Allowed' });
    } catch (err) {
      console.error('[server] 未捕获错误:', err);
      return json(res, 500, { error: 'Internal Server Error', message: (err as Error).message });
    }
  });

  server.listen(config.port, () => {
    const banner = [
      '',
      '╔══════════════════════════════════════════════════╗',
      '║   🎵  AI Music Generator Agent (aipack)        ║',
      '╠══════════════════════════════════════════════════╣',
      `║  编排模型: ${pad(`${config.provider}/${config.modelId}`, 39)}║`,
      `║  LLM Key:  ${pad(config.llmReady ? '✅' : '❌', 39)}║`,
      `║  ModelsLab: ${pad(config.musicReady ? '✅ env 已配置' : '⚠️ 待前端输入 Key', 39)}║`,
      `║  生成端点: ${pad('modelslab v6/voice/music_gen', 39)}║`,
      `║  API:      ${pad(`http://localhost:${config.port}/api`, 39)}║`,
      `║  前端:     ${pad('dev → http://localhost:5173', 39)}║`,
      '╚══════════════════════════════════════════════════╝',
      '',
    ].join('\n');
    console.log(banner);
  });

  // 优雅退出
  const shutdown = async (sig: string) => {
    console.log(`\n[${sig}] 正在关闭...`);
    server.close();
    await registry.closeAll();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function pad(s: string, n: number): string {
  // 中文字符按 2 宽度计算
  let width = 0;
  for (const ch of s) width += ch.charCodeAt(0) > 0x7f ? 2 : 1;
  const need = Math.max(0, n - width);
  return s + ' '.repeat(need);
}

// ─── SSE:/api/chat ───────────────────────────────────────────────

async function handleChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: {
    registry: ReturnType<typeof createRuntimeRegistry>;
    config: ReturnType<typeof loadConfig>;
  },
) {
  const body =
    (await readJson(req).catch(() => null)) as
      | { message?: string; sessionId?: string; model?: PickedModel }
      | null;
  if (!body || typeof body.message !== 'string' || !body.message.trim()) {
    return json(res, 400, { error: '缺少 message 参数' });
  }
  const message = body.message.trim();
  // 会话 ID:前端未提供则服务端生成(单轮模式)
  const sessionId = (typeof body.sessionId === 'string' && body.sessionId.trim()) || randomUUID();

  // ── 解析模型选择(缺省回退默认模型)────────────────────────────
  const { choice, error } = resolveModelChoice(body.model, {
    provider: ctx.config.provider,
    modelId: ctx.config.modelId,
  });
  if (error) {
    return json(res, 400, { error: `编排模型:${error}` });
  }

  // ModelsLab Key:前端用户输入优先,回退服务器 env(未配置时工具返回可读错误)
  const modelslabKey =
    (typeof body.model?.modelslabKey === 'string' && body.model.modelslabKey.trim()) || ctx.config.modelslabKey;

  let runtime;
  try {
    runtime = ctx.registry.get(choice.provider, choice.modelId, choice.apiKey, modelslabKey);
  } catch (e) {
    return json(res, 400, { error: (e as Error).message });
  }

  // SSE 头(禁用代理缓冲,保证流式)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // 会话 ID 随首个事件下发,前端持久化以维持多轮
  send('stage', { stage: 'session', sessionId });

  // 客户端断开 → 中止
  const ac = new AbortController();
  req.on('close', () => ac.abort());

  const onProgress = (p: ChatProgress) => {
    if (p.type === 'tool_start' || p.type === 'tool_end') {
      send('stage', { stage: p.type, toolName: p.toolName });
    } else if (p.type === 'start' || p.type === 'done') {
      send('stage', { stage: p.type });
    } else if (p.type === 'delta') {
      send('delta', { kind: p.kind, delta: p.delta });
    } else if (p.type === 'music' && p.music) {
      send('music', {
        url: p.music.url,
        prompt: p.music.prompt,
        durationSec: p.music.durationSec,
      });
    } else if (p.type === 'error') {
      send('error', { message: p.message });
    }
  };

  try {
    await streamChat({ message, sessionId }, runtime, onProgress, ac.signal);
  } catch (err) {
    const msg = (err as Error).message === 'aborted' ? '客户端已断开' : (err as Error).message;
    if (msg !== '客户端已断开') {
      send('error', { message: msg });
      console.error('[/api/chat] 失败:', err);
    }
  } finally {
    res.end();
  }
}

// ─── /api/audio:音频代理(白名单 + Range + 下载)────────────────────

async function handleAudioProxy(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const target = url.searchParams.get('url') || '';
  const download = url.searchParams.get('download') === '1';

  // 白名单:仅代理本服务 generate_music 工具产出的 URL(防 SSRF)
  const generation = findGenerationByUrl(target);
  if (!generation) {
    return json(res, 403, { error: '拒绝代理:该 URL 不是本服务生成的音频' });
  }

  try {
    // 透传 Range 头以支持播放器拖动进度;upstream 306/206 状态与关键响应头原样回传
    const headers: Record<string, string> = { Accept: '*/*' };
    if (typeof req.headers.range === 'string' && req.headers.range) headers.Range = req.headers.range;

    const upstream = await fetch(generation.url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(60_000),
    });
    if (!upstream.ok || !upstream.body) {
      return json(res, 502, { error: `音频源返回 HTTP ${upstream.status}` });
    }

    const outHeaders: Record<string, string> = {};
    const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
    for (const h of passthrough) {
      const v = upstream.headers.get(h);
      if (v) outHeaders[h] = v;
    }
    if (!outHeaders['content-type']) outHeaders['content-type'] = 'audio/mpeg';
    if (download) {
      const name = `music-${new Date(generation.createdAt).toISOString().replace(/[-:T]/g, '').slice(0, 14)}.mp3`;
      outHeaders['content-disposition'] = `attachment; filename="${name}"`;
    }
    res.writeHead(upstream.status, outHeaders);

    // 流式转发(ReadableStream → ServerResponse)
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) return json(res, 502, { error: `音频代理失败:${(err as Error).message}` });
    res.end();
  }
}

// ─── 静态资源(生产态:dist/frontend,SPA fallback)────────────────────

async function serveStatic(pathname: string, res: http.ServerResponse) {
  // 安全:禁止路径穿越
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(PUBLIC_DIR, safe);
  if (filePath === PUBLIC_DIR || filePath === PUBLIC_DIR + '/') filePath = path.join(PUBLIC_DIR, 'index.html');

  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    // 文件不存在 → 回退 index.html(SPA):开发态 dist/frontend 不存在时也走此路径
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    // 生产构建未产出或开发态:返回简短提示(开发态应访问 Vite 5173)
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found\n\n(开发态请访问 http://localhost:5173;生产态请先执行 pnpm --filter ai-music-generator-agent build)');
  }
}

// ─── 工具:JSON 读取/响应 ───────────────────────────────────────────

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1_000_000) reject(new Error('body too large')), req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
