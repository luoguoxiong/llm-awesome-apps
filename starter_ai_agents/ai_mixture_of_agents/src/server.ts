/**
 * starter_ai_agents/ai_mixture_of_agents/src/server.ts
 *
 * 原生 http 服务(后端零运行时框架依赖):
 *   - GET  /               → 生产:dist/frontend/index.html(React 构建产物)
 *   - GET  /<static>       → dist/frontend 静态资源 + SPA fallback
 *   - GET  /api/config     → 模型目录 + 默认聚合模型 + 默认参考模型(JSON)
 *   - POST /api/mixture    → SSE 流式 MoA:参考模型逐路并行流式 → 聚合回答流式
 *
 * 开发态前端由 Vite(5173)提供,/api 经 Vite 代理到本服务(3008):
 *   pnpm --filter ai-mixture-of-agents dev
 * 生产态单端口:先 build(vite build + tsc),再 serve:
 *   pnpm --filter ai-mixture-of-agents serve
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveModelSpec, type ModelSpec } from './config.js';
import { runMixture } from './mixture.js';

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

/** 前端提交的模型选择(单个) */
interface PickedModel {
  provider?: string;
  modelId?: string;
  apiKey?: string;
}

interface MixtureRequestBody {
  prompt?: string;
  references?: PickedModel[];
  aggregator?: PickedModel;
}

const MAX_REFERENCES = 6;

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
          defaultReferences: config.defaultReferences,
          maxReferences: MAX_REFERENCES,
        });
      }

      // ── POST /api/mixture (SSE 流式 MoA) ──────────────────────
      if (req.method === 'POST' && url.pathname === '/api/mixture') {
        return handleMixture(req, res);
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
      '║   🧩  AI Mixture-of-Agents (aipack)            ║',
      '╠══════════════════════════════════════════════════╣',
      `║  聚合模型: ${pad(`${config.provider}/${config.modelId}`, 39)}║`,
      `║  Key 就绪: ${pad(config.llmReady ? '✅' : '❌', 39)}║`,
      `║  参考模型: ${pad('前端多选(最多 6 个,跨 provider)', 39)}║`,
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

// ─── SSE:POST /api/mixture ──────────────────────────────────────

async function handleMixture(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = (await readJson(req).catch(() => null)) as MixtureRequestBody | null;
  if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
    return json(res, 400, { error: '缺少 prompt 参数(问题)' });
  }
  const prompt = body.prompt.trim().slice(0, 4000);

  // ── 校验参考模型(1..MAX_REFERENCES 个)────────────────────────
  if (!Array.isArray(body.references) || body.references.length === 0) {
    return json(res, 400, { error: '请至少选择 1 个参考模型' });
  }
  if (body.references.length > MAX_REFERENCES) {
    return json(res, 400, { error: `参考模型最多 ${MAX_REFERENCES} 个` });
  }
  const refs: ModelSpec[] = [];
  const refKeys = new Set<string>();
  for (const picked of body.references) {
    const { spec, error } = resolveModelSpec(picked);
    if (error) {
      return json(res, 400, { error: `参考模型不可用 → ${error}` });
    }
    if (refKeys.has(spec.modelKey)) {
      return json(res, 400, { error: `参考模型重复:${spec.modelKey}` });
    }
    refKeys.add(spec.modelKey);
    refs.push(spec);
  }

  // ── 校验聚合模型 ─────────────────────────────────────────────
  const { spec: aggregator, error: aggError } = resolveModelSpec(body.aggregator);
  if (aggError) {
    return json(res, 400, { error: `聚合模型不可用 → ${aggError}` });
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

  send('stage', { stage: 'start', references: refs.map((r) => r.modelKey), aggregator: aggregator.modelKey });

  // 客户端断开 → 中止
  const ac = new AbortController();
  req.on('close', () => ac.abort());

  try {
    await runMixture(
      prompt,
      refs,
      aggregator,
      {
        onRefStart: (modelKey) => send('stage', { stage: 'ref_start', modelKey }),
        onRefDelta: (modelKey, delta) => send('ref_delta', { modelKey, delta }),
        onRefEnd: (modelKey, error) => send('stage', { stage: 'ref_end', modelKey, error: error ?? undefined }),
        onAggregateStart: (failedRefs) =>
          send('stage', {
            stage: 'aggregate_start',
            failed: failedRefs.map((f) => f.modelKey),
          }),
        onDelta: (kind, delta) => send('delta', { kind, delta }),
      },
      ac.signal,
    );
    send('stage', { stage: 'done' });
  } catch (err) {
    const msg = (err as Error).message === 'aborted' ? '客户端已断开' : (err as Error).message;
    if (msg !== '客户端已断开') {
      send('error', { message: msg });
      console.error('[/api/mixture] 失败:', err);
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
    res.end('404 Not Found\n\n(开发态请访问 http://localhost:5173;生产态请先执行 pnpm --filter ai-mixture-of-agents build)');
  }
}

// ─── 工具:JSON 读取/响应 ───────────────────────────────────────────

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 100_000) reject(new Error('body too large')), req.destroy();
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
