/**
 * rag_tutorials/ai_rag_chain/src/server.ts
 *
 * 原生 http 服务(后端零运行时框架依赖):
 *   - GET  /               → 生产:dist/frontend/index.html(React 构建产物)
 *   - GET  /<static>       → dist/frontend 静态资源 + SPA fallback
 *   - GET  /api/config      → 默认模型/模型目录/知识库统计(JSON)
 *   - POST /api/upload     → 上传文档(PDF/TXT/MD,base64)→ 提取文本 → 分块入库
 *   - POST /api/clear      → 清空知识库
 *   - POST /api/query      → SSE 流式:检索 top-k 片段 → 上下文流式问答
 *
 * 开发态前端由 Vite(5173)提供,/api 经 Vite 代理到本服务(3013):
 *   pnpm --filter ai-rag-chain dev
 * 生产态单端口:先 build(vite build + tsc),再 serve:
 *   pnpm --filter ai-rag-chain serve
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveModelChoice } from './config.js';
import { createRuntimeRegistry, streamAnswer } from './runtime.js';
import { VectorStore } from './vectordb.js';
import { extractPdfText } from './pdf.js';

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

/** 上传体上限(含 base64 编码的 PDF):40MB */
const MAX_BODY = 40 * 1024 * 1024;

/** 文本类扩展名(直接按 utf-8 解码);其余尝试 PDF 提取 */
const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.text', '.csv', '.json']);

/** 前端提交的模型选择 */
interface PickedModel {
  provider?: string;
  modelId?: string;
  apiKey?: string;
}

/** 上传文件条目(前端 FileReader 转 base64) */
interface UploadFile {
  name?: string;
  contentBase64?: string;
}

/** 单文件上传结果 */
interface UploadResult {
  name: string;
  status: 'ok' | 'skipped' | 'error';
  chars: number;
  added: number;
  message?: string;
}

async function main() {
  const config = loadConfig();

  // 知识库(自动从磁盘加载)+ Runtime 注册表(按用户选择模型按需构建)
  const store = new VectorStore({ dir: config.vectorDbDir });
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
          topK: config.topK,
          db: store.stats(),
        });
      }

      // ── POST /api/upload(文档入库)────────────────────────────
      if (req.method === 'POST' && url.pathname === '/api/upload') {
        return handleUpload(req, res, store);
      }

      // ── POST /api/clear(清空知识库)────────────────────────────
      if (req.method === 'POST' && url.pathname === '/api/clear') {
        const removed = store.clear();
        store.save();
        return json(res, 200, { removed, db: store.stats() });
      }

      // ── POST /api/query (SSE 流式 RAG 问答)────────────────────
      if (req.method === 'POST' && url.pathname === '/api/query') {
        return handleQuery(req, res, { registry, store, config });
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
      '║   📚  AI RAG Chain (aipack)                  ║',
      '╠══════════════════════════════════════════════════╣',
      `║  生成模型: ${pad(`${config.provider}/${config.modelId}`, 39)}║`,
      `║  Key 就绪: ${pad(config.llmReady ? '✅' : '❌', 39)}║`,
      `║  知识库:   ${pad(`${store.stats().chunkCount} 块 / ${store.stats().sourceCount} 来源`, 39)}║`,
      `║  检索 Top: ${pad(String(config.topK), 39)}║`,
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

// ─── POST /api/upload:文档提取 + 分块入库 ──────────────────────────

async function handleUpload(req: http.IncomingMessage, res: http.ServerResponse, store: VectorStore) {
  const body = (await readJson(req).catch(() => null)) as { files?: UploadFile[] } | null;
  const files = Array.isArray(body?.files) ? body!.files! : [];
  if (files.length === 0) {
    return json(res, 400, { error: '缺少 files 参数(至少一个文件)' });
  }

  const results: UploadResult[] = [];
  for (const file of files.slice(0, 20)) {
    const name = String(file.name || '未命名').slice(0, 200);
    try {
      if (typeof file.contentBase64 !== 'string' || !file.contentBase64.trim()) {
        throw new Error('文件内容为空');
      }
      const buf = Buffer.from(file.contentBase64, 'base64');
      if (buf.length === 0) throw new Error('文件内容为空');

      const ext = path.extname(name).toLowerCase();
      let text: string;
      if (TEXT_EXTS.has(ext)) {
        text = buf.toString('utf-8');
      } else {
        // PDF 或其他二进制:走零依赖 PDF 提取
        text = extractPdfText(buf);
        if (!text.trim()) {
          throw new Error(
            ext === '.pdf'
              ? '无法从该 PDF 提取文本(可能为扫描件或使用了 CID 字体),请转为 .txt/.md 后上传'
              : '不支持的文件类型(支持 .pdf / .txt / .md 等文本类文件)',
          );
        }
      }

      const { added, skipped } = store.addTexts([text], name);
      results.push({
        name,
        status: added > 0 ? 'ok' : 'skipped',
        chars: text.length,
        added,
        message: added > 0 ? `已分块入库 ${added} 段` : '内容与已有知识库重复,未入库',
      });
      if (skipped > 0 && added > 0) {
        results[results.length - 1].message += `(另有 ${skipped} 段重复被跳过)`;
      }
    } catch (err) {
      results.push({ name, status: 'error', chars: 0, added: 0, message: (err as Error).message });
    }
  }

  store.save();
  return json(res, 200, { results, db: store.stats() });
}

// ─── SSE:POST /api/query ───────────────────────────────────────────

async function handleQuery(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: {
    registry: ReturnType<typeof createRuntimeRegistry>;
    store: VectorStore;
    config: ReturnType<typeof loadConfig>;
  },
) {
  const body =
    (await readJson(req).catch(() => null)) as { question?: string; model?: PickedModel } | null;
  if (!body || typeof body.question !== 'string' || !body.question.trim()) {
    return json(res, 400, { error: '缺少 question 参数' });
  }
  const question = body.question.trim();

  // ── 解析模型选择(缺省回退默认模型)────────────────────────────
  const { choice, error } = resolveModelChoice(body.model, {
    provider: ctx.config.provider,
    modelId: ctx.config.modelId,
  });
  if (error) {
    return json(res, 400, { error: `生成模型:${error}` });
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

  // ── 阶段 1:本地检索(对应源应用的 retriever | format_docs)──────
  send('stage', { stage: 'retrieval_start' });
  const hits = ctx.store.search(question, ctx.config.topK);
  send('stage', { stage: 'retrieval_done', hitCount: hits.length, db: ctx.store.stats() });

  if (hits.length === 0) {
    send('error', {
      message:
        '知识库为空或未检索到相关内容。请先在"知识库"卡片上传文档(PDF/TXT/MD),再提问。',
    });
    return res.end();
  }

  // 检索到的片段随 sources 事件下发(前端展示引用来源,含相似度分数)
  send('sources', {
    hits: hits.map((h, i) => ({
      index: i + 1,
      source: h.source,
      score: Math.round(h.score * 1000) / 1000,
      text: h.text.length > 400 ? `${h.text.slice(0, 400)}…` : h.text,
    })),
  });

  // ── 阶段 2:基于上下文流式生成(对应 prompt | chat_model | parser)──
  try {
    await streamAnswer(
      question,
      hits.map((h) => h.text),
      runtime,
      (e) => {
        if (e.type === 'answer_start') send('stage', { stage: 'answer_start' });
        else if (e.type === 'delta') send('delta', { kind: 'text', delta: e.delta });
        else if (e.type === 'error') send('error', { message: e.message });
      },
      ac.signal,
    );
  } catch (err) {
    const msg = (err as Error).message === 'aborted' ? '客户端已断开' : (err as Error).message;
    if (msg !== '客户端已断开') {
      send('error', { message: msg });
      console.error('[/api/query] 失败:', err);
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
    res.end('404 Not Found\n\n(开发态请访问 http://localhost:5173;生产态请先执行 pnpm --filter ai-rag-chain build)');
  }
}

// ─── 工具:JSON 读取/响应 ───────────────────────────────────────────

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
