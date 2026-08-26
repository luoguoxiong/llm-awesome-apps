/**
 * starter_ai_agents/ai_data_analysis_agent/src/server.ts
 *
 * 原生 http 服务(后端零运行时框架依赖):
 *   - GET  /                → 生产:dist/frontend/index.html(React 构建产物)
 *   - GET  /<static>        → dist/frontend 静态资源 + SPA fallback
 *   - GET  /api/config      → 默认模型/模型目录(JSON)
 *   - POST /api/dataset     → 上传数据集(raw body + ?name= 文件名,CSV/Excel → 解析 + 内存缓存)
 *   - POST /api/chat        → SSE 流式:多轮数据分析问答(summary/query 两工具 + echarts 约定)
 *
 * 开发态前端由 Vite(5173)提供,/api 经 Vite 代理到本服务(3006):
 *   pnpm --filter ai-data-analysis-agent dev
 * 生产态单端口:先 build(vite build + tsc),再 serve:
 *   pnpm --filter ai-data-analysis-agent serve
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveModelChoice } from './config.js';
import { parseDataset, getDataset, MAX_UPLOAD_BYTES, type DatasetInfo } from './dataset.js';
import { createRuntimeRegistry, streamChat, type ChatProgress } from './runtime.js';

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

/** 前端提交的模型选择 */
interface PickedModel {
  provider?: string;
  modelId?: string;
  apiKey?: string;
}

async function main() {
  const config = loadConfig();

  // Runtime 注册表:按 (模型, 数据集) 维度按需构建并缓存(带 summary/query 两工具)
  const registry = createRuntimeRegistry();

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
        });
      }

      // ── POST /api/dataset(上传解析 CSV/Excel)──────────────────
      if (req.method === 'POST' && url.pathname === '/api/dataset') {
        return handleUpload(req, res, url);
      }

      // ── POST /api/chat (SSE 流式) ────────────────────────────
      if (req.method === 'POST' && url.pathname === '/api/chat') {
        return handleChat(req, res, { registry, config });
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
      '║   📊  AI Data Analysis Agent (aipack)          ║',
      '╠══════════════════════════════════════════════════╣',
      `║  分析模型: ${pad(`${config.provider}/${config.modelId}`, 39)}║`,
      `║  Key 就绪: ${pad(config.llmReady ? '✅' : '❌', 39)}║`,
      `║  查询工具: ${pad('summary + query_data', 39)}║`,
      `║  可视化:   ${pad('echarts option 约定', 39)}║`,
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

// ─── POST /api/dataset:上传解析 ─────────────────────────────────

async function handleUpload(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const name = url.searchParams.get('name') || 'dataset.csv';

  // 读 raw body(二进制),限制大小
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_UPLOAD_BYTES) {
      tooLarge = true;
      req.destroy();
      break;
    }
    chunks.push(chunk as Buffer);
  }
  if (tooLarge) {
    return json(res, 413, { error: `文件过大(上限 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)` });
  }
  const buf = Buffer.concat(chunks);
  if (buf.length === 0) {
    return json(res, 400, { error: '请求体为空,请选择要上传的文件' });
  }

  try {
    const info: DatasetInfo = parseDataset(name, buf);
    console.log(`[dataset] 已解析 ${name}:${info.rowCount} 行 × ${info.columns.length} 列(id=${info.id})`);
    return json(res, 200, info);
  } catch (err) {
    console.warn(`[dataset] 解析 ${name} 失败:`, (err as Error).message);
    return json(res, 400, { error: `解析失败:${(err as Error).message}` });
  }
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
      | { message?: string; datasetId?: string; sessionId?: string; model?: PickedModel }
      | null;
  if (!body || typeof body.message !== 'string' || !body.message.trim()) {
    return json(res, 400, { error: '缺少 message 参数' });
  }
  const message = body.message.trim();

  // 数据集校验:必须先上传
  const datasetId = typeof body.datasetId === 'string' ? body.datasetId : '';
  const dataset = datasetId ? getDataset(datasetId) : undefined;
  if (!dataset) {
    return json(res, 400, { error: '请先上传数据集(刷新页面或重新上传后需重新提问)' });
  }

  // 会话 ID:前端未提供则服务端生成(单轮模式)
  const sessionId = (typeof body.sessionId === 'string' && body.sessionId.trim()) || randomUUID();

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
    runtime = ctx.registry.get(choice.provider, choice.modelId, choice.apiKey, dataset);
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
    res.end('404 Not Found\n\n(开发态请访问 http://localhost:5173;生产态请先执行 pnpm --filter ai-data-analysis-agent build)');
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
