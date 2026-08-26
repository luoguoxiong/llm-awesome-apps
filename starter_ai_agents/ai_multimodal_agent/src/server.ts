/**
 * starter_ai_agents/ai_multimodal_agent/src/server.ts
 *
 * 原生 http 服务(后端零运行时框架依赖):
 *   - GET  /                → 生产:dist/frontend/index.html(React 构建产物)
 *   - GET  /<static>        → dist/frontend 静态资源 + SPA fallback
 *   - GET  /api/config      → 默认模型/多模态模型目录/搜索后端(JSON)
 *   - POST /api/analyze     → SSE 流式:多模态分析(图片/视频帧 + 问题 + web 搜索)
 *
 * 开发态前端由 Vite(5173)提供,/api 经 Vite 代理到本服务(3003):
 *   pnpm --filter ai-multimodal-agent dev
 * 生产态单端口:先 build(vite build + tsc),再 serve:
 *   pnpm --filter ai-multimodal-agent serve
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveModelChoice, type ModelChoice } from './config.js';
import { createRuntimeRegistry, streamAnalysis, type AnalysisProgress } from './runtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 前端构建产物目录:开发态(src/)与生产态(dist/)都解析到 approot/dist/frontend
const PUBLIC_DIR = path.resolve(__dirname, '../dist/frontend');

/** 请求体上限:图片/视频帧 base64 较大(约 25MB,足以容纳 ~10 帧 1280px JPEG) */
const MAX_BODY_BYTES = 25_000_000;
/** 单次请求最多图片数(视频抽帧上限) */
const MAX_MEDIA_COUNT = 10;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** 前端提交的模型选择 */
interface PickedModel {
  provider?: string;
  modelId?: string;
  apiKey?: string;
}

async function main() {
  const config = loadConfig();

  // Runtime 注册表:按用户选择的模型按需构建并缓存(带 search_web 工具)
  const registry = createRuntimeRegistry(config.serpapiKey);

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
          searchBackend: config.searchBackend,
        });
      }

      // ── POST /api/analyze (SSE 流式) ──────────────────────────
      if (req.method === 'POST' && url.pathname === '/api/analyze') {
        return handleAnalyze(req, res, { registry, config });
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
      '║   🧬  Multimodal AI Agent (aipack)             ║',
      '╠══════════════════════════════════════════════════╣',
      `║  分析模型: ${pad(`${config.provider}/${config.modelId}`, 39)}║`,
      `║  Key 就绪: ${pad(config.llmReady ? '✅' : '❌', 39)}║`,
      `║  搜索后端: ${pad(config.searchBackend, 39)}║`,
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

// ─── SSE:/api/analyze ────────────────────────────────────────────

async function handleAnalyze(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: {
    registry: ReturnType<typeof createRuntimeRegistry>;
    config: ReturnType<typeof loadConfig>;
  },
) {
  const body =
    (await readJson(req).catch(() => null)) as
      | { question?: string; media?: unknown; model?: PickedModel }
      | null;
  if (!body || typeof body.question !== 'string' || !body.question.trim()) {
    return json(res, 400, { error: '缺少 question 参数' });
  }
  const question = body.question.trim();

  // ── 校验 media:必须是 data:image/* base64 数组,1~10 张 ──
  if (!Array.isArray(body.media) || body.media.length === 0) {
    return json(res, 400, { error: '缺少 media 参数(至少 1 张图片 data URI)' });
  }
  if (body.media.length > MAX_MEDIA_COUNT) {
    return json(res, 400, { error: `图片数量超限(最多 ${MAX_MEDIA_COUNT} 张,请减少视频抽帧数)` });
  }
  const media: string[] = [];
  for (const item of body.media) {
    if (typeof item !== 'string' || !/^data:image\/[a-z0-9.+-]+;base64,/i.test(item)) {
      return json(res, 400, { error: 'media 数组元素必须是 data:image/*;base64 格式的 data URI' });
    }
    media.push(item);
  }

  // ── 解析模型选择(缺省回退默认模型)────────────────────────────
  const { choice, error } = resolveModelChoice(body.model, {
    provider: ctx.config.provider,
    modelId: ctx.config.modelId,
  });
  if (error) {
    return json(res, 400, { error: `分析模型:${error}` });
  }

  let runtime;
  try {
    runtime = ctx.registry.get(choice.provider, choice.modelId, choice.apiKey);
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

  // 客户端断开 → 中止
  const ac = new AbortController();
  req.on('close', () => ac.abort());

  const onProgress = (p: AnalysisProgress) => {
    if (p.type === 'tool_start' || p.type === 'tool_end') {
      send('stage', { stage: p.type, toolName: p.toolName });
    } else if (p.type === 'start' || p.type === 'done') {
      send('stage', { stage: p.type });
    } else if (p.type === 'delta') {
      send('delta', { kind: p.kind, delta: p.delta });
    } else if (p.type === 'error') {
      send('error', { message: p.message });
    }
  };

  try {
    await streamAnalysis({ question, media }, runtime, onProgress, ac.signal);
  } catch (err) {
    const msg = (err as Error).message === 'aborted' ? '客户端已断开' : (err as Error).message;
    if (msg !== '客户端已断开') {
      send('error', { message: msg });
      console.error('[/api/analyze] 失败:', err);
    }
  } finally {
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
    res.end('404 Not Found\n\n(开发态请访问 http://localhost:5173;生产态请先执行 pnpm --filter ai-multimodal-agent build)');
  }
}

// ─── 工具:JSON 读取/响应 ───────────────────────────────────────────

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > MAX_BODY_BYTES) reject(new Error('body too large')), req.destroy();
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
