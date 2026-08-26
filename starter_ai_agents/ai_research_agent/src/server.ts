/**
 * starter_ai_agents/ai_research_agent/src/server.ts
 *
 * 原生 http 服务(后端零运行时框架依赖):
 *   - GET  /               → 生产:dist/frontend/index.html(React 构建产物)
 *   - GET  /<static>       → dist/frontend 静态资源 + SPA fallback
 *   - GET  /api/config     → 默认模型/模型目录/搜索后端(JSON)
 *   - POST /api/research   → SSE 流式研究:计划 → 搜索/HN/深读(事实实时推送)→ 报告逐字输出
 *
 * 开发态前端由 Vite(5173)提供,/api 经 Vite 代理到本服务(3007):
 *   pnpm --filter ai-research-agent dev
 * 生产态单端口:先 build(vite build + tsc),再 serve:
 *   pnpm --filter ai-research-agent serve
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, buildModel, resolveModelChoice } from './config.js';
import { createSearchTool } from './tools/search.js';
import { createFetchUrlTool } from './tools/fetchUrl.js';
import { createHackerNewsTool } from './tools/hackernews.js';
import { createFactsStore, type FactEntry } from './tools/facts.js';
import { createResearchRuntime, streamResearch, type ResearchProgress } from './runtime.js';

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

      // ── POST /api/research (SSE 流式研究) ─────────────────────
      if (req.method === 'POST' && url.pathname === '/api/research') {
        return handleResearch(req, res, config);
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
      '║   🔍  AI Research Agent (aipack)               ║',
      '╠══════════════════════════════════════════════════╣',
      `║  研究模型: ${pad(`${config.provider}/${config.modelId}`, 39)}║`,
      `║  Key 就绪: ${pad(config.llmReady ? '✅' : '❌', 39)}║`,
      `║  搜索后端: ${pad(config.searchBackend, 39)}║`,
      `║  工具:     ${pad('search/hn/fetch/facts', 39)}║`,
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

// ─── SSE:POST /api/research ─────────────────────────────────────

async function handleResearch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  const body =
    (await readJson(req).catch(() => null)) as
      | { topic?: string; model?: PickedModel }
      | null;
  if (!body || typeof body.topic !== 'string' || !body.topic.trim()) {
    return json(res, 400, { error: '缺少 topic 参数(研究主题)' });
  }
  const topic = body.topic.trim().slice(0, 500);

  // ── 解析模型选择(缺省回退默认模型)────────────────────────────
  const { choice, error } = resolveModelChoice(body.model, {
    provider: config.provider,
    modelId: config.modelId,
  });
  if (error) {
    return json(res, 400, { error: `研究模型:${error}` });
  }

  let runtime;
  try {
    const { model, streamFn } = buildModel(choice.provider, choice.modelId, choice.apiKey);
    // 每次研究独立的 FactsStore:save_important_fact 实时推送到 SSE fact 事件
    const store = createFactsStore((f: FactEntry) => send('fact', f));
    runtime = createResearchRuntime(model, streamFn, [
      createSearchTool(config.serpapiKey),
      createHackerNewsTool(),
      createFetchUrlTool(),
      store.tool,
    ]);
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

  send('stage', { stage: 'start', topic });

  // 客户端断开 → 中止
  const ac = new AbortController();
  req.on('close', () => ac.abort());

  const onProgress = (p: ResearchProgress) => {
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
    await streamResearch({ topic }, runtime, onProgress, ac.signal);
  } catch (err) {
    const msg = (err as Error).message === 'aborted' ? '客户端已断开' : (err as Error).message;
    if (msg !== '客户端已断开') {
      send('error', { message: msg });
      console.error('[/api/research] 失败:', err);
    }
  } finally {
    try {
      await runtime.close();
    } catch {
      // 忽略关闭错误
    }
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
    res.end('404 Not Found\n\n(开发态请访问 http://localhost:5173;生产态请先执行 pnpm --filter ai-research-agent build)');
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
