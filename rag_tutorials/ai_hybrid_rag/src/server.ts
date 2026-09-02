/**
 * rag_tutorials/ai_hybrid_rag/src/server.ts
 *
 * 原生 http 服务（后端零运行时框架依赖）：
 *   - GET  /                 → 生产：dist/frontend/index.html（React 构建产物）
 *   - GET  /<static>         → dist/frontend 静态资源 + SPA fallback
 *   - GET  /api/config       → 默认模型/模型目录/索引统计/检索参数（JSON）
 *   - POST /api/ingest       → 摄取文档 { name, content } 或 { url }（URL 服务端抓取）
 *   - GET  /api/documents    → 索引统计（来源列表 + 块数）
 *   - DELETE /api/documents  → 删除来源（?name=xxx）或清空全部索引
 *   - POST /api/chat         → SSE 流式：search → grade → answer（RAG/兜底）
 *
 * 开发态前端由 Vite（5173）提供，/api 经 Vite 代理到本服务（3013）：
 *   pnpm --filter ai-hybrid-rag dev
 * 生产态单端口：先 build（vite build + tsc），再 serve：
 *   pnpm --filter ai-hybrid-rag serve
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveModelChoice } from './config.js';
import { HybridStore } from './hybrid.js';
import { createRuntimeRegistry, type RuntimeRegistry } from './runtime.js';
import { fetchUrlContent, isHttpUrl } from './fetchUrl.js';
import { answerQuestion, type ChatEvent, type ChatTurn } from './pipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 前端构建产物目录：开发态（src/）与生产态（dist/）都解析到 approot/dist/frontend
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

/** JSON 请求体上限（粘贴文本/URL 摄取）：20MB */
const MAX_BODY = 20 * 1024 * 1024;

/** 多轮对话历史（内存态；与源应用 Streamlit session_state 等价） */
const chatHistories = new Map<string, ChatTurn[]>();

/** 历史条数上限（user+assistant 合计），超出丢弃最早 */
const MAX_HISTORY = 20;

async function main() {
  const config = loadConfig();

  // 混合检索索引（自动从磁盘加载）+ Runtime 注册表（按用户选择模型按需构建）
  const store = new HybridStore({ dir: config.vectorDbDir });
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
          stats: store.stats(),
          params: {
            candidateK: config.candidateK,
            contextK: config.contextK,
            rrfK: config.rrfK,
            gradeEnabled: config.gradeEnabled,
          },
        });
      }

      // ── POST /api/ingest（摄取文本/URL）────────────────────────
      if (req.method === 'POST' && url.pathname === '/api/ingest') {
        return handleIngest(req, res, { store, firecrawlKey: config.firecrawlKey });
      }

      // ── GET /api/documents（索引统计）──────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/documents') {
        return json(res, 200, store.stats());
      }

      // ── DELETE /api/documents（删除来源/清空）──────────────────
      if (req.method === 'DELETE' && url.pathname === '/api/documents') {
        const name = url.searchParams.get('name');
        const removed = name ? store.removeSource(name) : store.clear();
        store.save();
        return json(res, 200, { removed, stats: store.stats() });
      }

      // ── POST /api/chat (SSE 流式) ─────────────────────────────
      if (req.method === 'POST' && url.pathname === '/api/chat') {
        return handleChat(req, res, {
          registry,
          store,
          params: {
            candidateK: config.candidateK,
            contextK: config.contextK,
            rrfK: config.rrfK,
            gradeEnabled: config.gradeEnabled,
          },
          fallback: { provider: config.provider, modelId: config.modelId },
        });
      }

      // ── 静态资源（生产态；开发态由 Vite 提供）──────────────────────
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
      '║   🔍  AI Hybrid Search RAG (aipack)            ║',
      '╠══════════════════════════════════════════════════╣',
      `║  问答模型: ${pad(`${config.provider}/${config.modelId}`, 39)}║`,
      `║  Key 就绪: ${pad(config.llmReady ? '✅' : '❌', 39)}║`,
      `║  检索:     ${pad('BM25 + TF-IDF → RRF 融合', 39)}║`,
      `║  重排:     ${pad(config.gradeEnabled ? 'LLM 相关性评估' : '关闭（融合名次）', 39)}║`,
      `║  索引:     ${pad(`${store.stats().totalChunks} 块`, 39)}║`,
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
    store.save();
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

// ─── POST /api/ingest：摄取文本 / URL ─────────────────────────────

interface IngestBody {
  name?: unknown;
  content?: unknown;
  url?: unknown;
}

async function handleIngest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: { store: HybridStore; firecrawlKey?: string },
): Promise<void> {
  const body = (await readJson(req).catch(() => null)) as IngestBody | null;
  if (!body) {
    return json(res, 400, { error: '请求体不是合法 JSON' });
  }

  let name: string;
  let content: string;

  if (typeof body.url === 'string' && body.url.trim()) {
    // URL 摄取：服务端抓取正文（Firecrawl 可选 → 原生 fetch）
    const url = body.url.trim();
    if (!isHttpUrl(url)) {
      return json(res, 400, { error: 'URL 非法（仅支持 http/https）' });
    }
    let doc;
    try {
      doc = await fetchUrlContent(url, ctx.firecrawlKey);
    } catch (err) {
      console.warn(`[ingest] 抓取 ${url} 失败:`, (err as Error).message);
      return json(res, 400, { error: `抓取失败：${(err as Error).message}` });
    }
    if (!doc.content.trim()) {
      return json(res, 400, { error: '抓取到的正文为空（可能是动态渲染页面）' });
    }
    name = doc.title || url;
    content = doc.content;
  } else if (typeof body.content === 'string' && body.content.trim()) {
    // 文本摄取（前端上传 .txt/.md 或粘贴文本，前端已读为字符串）
    content = body.content;
    name = (typeof body.name === 'string' && body.name.trim()) || '粘贴文本';
    name = name.slice(0, 120);
  } else {
    return json(res, 400, { error: '缺少 content（文本内容）或 url 参数' });
  }

  const { added, skipped } = ctx.store.addTexts([content], name);
  ctx.store.save();
  console.log(`[ingest] ${name}：新增 ${added} 块，跳过重复 ${skipped} 块`);

  return json(res, 200, {
    name,
    added,
    skipped,
    stats: ctx.store.stats(),
  });
}

// ─── POST /api/chat：SSE 流式问答 ─────────────────────────────────

async function handleChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: {
    registry: RuntimeRegistry;
    store: HybridStore;
    params: { candidateK: number; contextK: number; rrfK: number; gradeEnabled: boolean };
    fallback: { provider: string; modelId: string };
  },
): Promise<void> {
  const body =
    (await readJson(req).catch(() => null)) as
      | { message?: string; sessionId?: string; model?: { provider?: string; modelId?: string; apiKey?: string } }
      | null;
  if (!body || typeof body.message !== 'string' || !body.message.trim()) {
    return json(res, 400, { error: '缺少 message 参数' });
  }
  const question = body.message.trim();
  const sessionId = (typeof body.sessionId === 'string' && body.sessionId.trim()) || 'default';

  // ── 解析模型选择（缺省回退默认模型）────────────────────────────
  const { choice, error } = resolveModelChoice(body.model, ctx.fallback);
  if (error) {
    return json(res, 400, { error: `问答模型：${error}` });
  }

  let runtimes;
  try {
    runtimes = ctx.registry.get(choice.provider, choice.modelId, choice.apiKey);
  } catch (e) {
    return json(res, 400, { error: (e as Error).message });
  }

  // SSE 头（禁用代理缓冲，保证流式）
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

  const onEvent = (e: ChatEvent) => {
    switch (e.type) {
      case 'search_start':
        send('stage', { stage: 'search_start' });
        break;
      case 'search_done':
        send('stage', { stage: 'search_done', candidates: e.candidates });
        break;
      case 'grade_start':
        send('stage', { stage: 'grade_start', count: e.count });
        break;
      case 'grade_done':
        send('stage', { stage: 'grade_done', graded: e.graded, relevantCount: e.relevantCount, candidates: e.candidates });
        break;
      case 'answer_start':
        send('stage', { stage: 'answer_start', mode: e.mode, contextCount: e.contextCount });
        break;
      case 'answer_delta':
        send('delta', { kind: e.kind, delta: e.delta });
        break;
      case 'done':
        send('stage', { stage: 'done' });
        break;
      case 'error':
        send('error', { message: e.message });
        break;
    }
  };

  try {
    const history = chatHistories.get(sessionId) ?? [];
    const answer = await answerQuestion(
      { question, history },
      { store: ctx.store, runtimes, params: ctx.params },
      onEvent,
      ac.signal,
    );
    // 记录本轮问答（供下轮多轮上下文）
    history.push({ role: 'user', content: question });
    history.push({ role: 'assistant', content: answer });
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    chatHistories.set(sessionId, history);
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

// ─── 静态资源（生产态：dist/frontend，SPA fallback）────────────────────

async function serveStatic(pathname: string, res: http.ServerResponse) {
  // 安全：禁止路径穿越
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(PUBLIC_DIR, safe);
  if (filePath === PUBLIC_DIR || filePath === PUBLIC_DIR + '/') filePath = path.join(PUBLIC_DIR, 'index.html');

  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    // 文件不存在 → 回退 index.html（SPA）：开发态 dist/frontend 不存在时也走此路径
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    // 生产构建未产出或开发态：返回简短提示（开发态应访问 Vite 5173）
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found\n\n(开发态请访问 http://localhost:5173；生产态请先执行 pnpm --filter ai-hybrid-rag build)');
  }
}

// ─── 工具：JSON 读取/响应 ───────────────────────────────────────────

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > MAX_BODY) reject(new Error('body too large')), req.destroy();
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
