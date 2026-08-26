/**
 * starter_ai_agents/ai_breakup_recovery_agent/src/server.ts
 *
 * 原生 http 服务(后端零运行时框架依赖):
 *   - GET  /               → 生产:dist/frontend/index.html(React 构建产物)
 *   - GET  /<static>       → dist/frontend 静态资源 + SPA fallback
 *   - GET  /api/config      → 默认模型/模型目录(含多模态标记)/搜索后端(JSON)
 *   - POST /api/recovery    → SSE 流式陪伴:共情 → 告别信 → 7 天计划 → 毒舌真相,
 *                             四段依次流式输出(delta 事件携带 agent 标识)
 *
 * 开发态前端由 Vite(5173)提供,/api 经 Vite 代理到本服务(3008):
 *   pnpm --filter ai-breakup-recovery-agent dev
 * 生产态单端口:先 build(vite build + tsc),再 serve:
 *   pnpm --filter ai-breakup-recovery-agent serve
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, buildModel, resolveModelChoice } from './config.js';
import { streamRecoveryTeam, type RecoveryProgress } from './runtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 前端构建产物目录:开发态(src/)与生产态(dist/)都解析到 approot/dist/frontend
const PUBLIC_DIR = path.resolve(__dirname, '../dist/frontend');

/** 请求体上限:聊天截图 base64 较大(约 15MB,足以容纳 ~8 张压缩截图) */
const MAX_BODY_BYTES = 15_000_000;
/** 单次请求最多截图数 */
const MAX_MEDIA_COUNT = 8;
/** 感受文字长度上限 */
const MAX_STORY_CHARS = 4000;

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

/** 前端提交的模型选择 */
interface PickedModel {
  provider?: string;
  modelId?: string;
  apiKey?: string;
}

async function main() {
  const config = loadConfig();

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

      // ── POST /api/recovery (SSE 流式陪伴) ─────────────────────
      if (req.method === 'POST' && url.pathname === '/api/recovery') {
        return handleRecovery(req, res, config);
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
      '║   💔  Breakup Recovery Squad (aipack)          ║',
      '╠══════════════════════════════════════════════════╣',
      `║  陪伴模型: ${pad(`${config.provider}/${config.modelId}`, 39)}║`,
      `║  Key 就绪: ${pad(config.llmReady ? '✅' : '❌', 39)}║`,
      `║  搜索后端: ${pad(config.searchBackend, 39)}║`,
      `║  团队:     ${pad('共情/告别/计划/毒舌', 39)}║`,
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

// ─── SSE:POST /api/recovery ─────────────────────────────────────

async function handleRecovery(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  const body =
    (await readJson(req).catch(() => null)) as
      | { story?: unknown; media?: unknown; model?: PickedModel }
      | null;
  if (!body) {
    return json(res, 400, { error: '请求体解析失败(可能超过大小限制)' });
  }

  // ── 校验 story / media(两者至少一项)──────────────────────────
  const story = typeof body.story === 'string' ? body.story.trim().slice(0, MAX_STORY_CHARS) : '';
  const mediaRaw = Array.isArray(body.media) ? body.media : [];
  if (!story && mediaRaw.length === 0) {
    return json(res, 400, { error: '请先分享你的感受,或上传聊天截图(至少一项)' });
  }
  if (mediaRaw.length > MAX_MEDIA_COUNT) {
    return json(res, 400, { error: `截图数量超限(最多 ${MAX_MEDIA_COUNT} 张)` });
  }
  const media: string[] = [];
  for (const item of mediaRaw) {
    if (typeof item !== 'string' || !/^data:image\/[a-z0-9.+-]+;base64,/i.test(item)) {
      return json(res, 400, { error: 'media 数组元素必须是 data:image/*;base64 格式的 data URI' });
    }
    media.push(item);
  }

  // ── 解析模型选择(缺省回退默认模型)────────────────────────────
  const { choice, error } = resolveModelChoice(body.model, {
    provider: config.provider,
    modelId: config.modelId,
  });
  if (error) {
    return json(res, 400, { error: `陪伴模型:${error}` });
  }

  let model;
  let streamFn;
  try {
    ({ model, streamFn } = buildModel(choice.provider, choice.modelId, choice.apiKey));
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

  send('stage', { stage: 'start' });

  // 客户端断开 → 中止
  const ac = new AbortController();
  req.on('close', () => ac.abort());

  const onProgress = (p: RecoveryProgress) => {
    if (p.type === 'delta') {
      send('delta', { agent: p.agent, kind: p.kind, delta: p.delta });
    } else if (p.type === 'error') {
      send('error', { message: p.message });
    } else {
      // start / agent_start / agent_end / tool_start / tool_end / done
      send('stage', { stage: p.type, agent: p.agent, toolName: p.toolName });
    }
  };

  try {
    await streamRecoveryTeam({ story, media }, model, streamFn, config.serpapiKey, onProgress, ac.signal);
  } catch (err) {
    const msg = (err as Error).message === 'aborted' ? '客户端已断开' : (err as Error).message;
    if (msg !== '客户端已断开') {
      send('error', { message: msg });
      console.error('[/api/recovery] 失败:', err);
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
    res.end('404 Not Found\n\n(开发态请访问 http://localhost:5173;生产态请先执行 pnpm --filter ai-breakup-recovery-agent build)');
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
