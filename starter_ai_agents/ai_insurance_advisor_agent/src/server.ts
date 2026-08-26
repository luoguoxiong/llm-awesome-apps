/**
 * starter_ai_agents/ai_insurance_advisor_agent/src/server.ts
 *
 * 原生 http 服务(后端零运行时框架依赖):
 *   - GET  /             → 生产:dist/frontend/index.html(React 构建产物)
 *   - GET  /<static>     → dist/frontend 静态资源 + SPA fallback
 *   - GET  /api/config   → 默认模型/模型目录/搜索后端(JSON)
 *   - POST /api/advise   → SSE 流式:客户资料 → 保额计算 + 产品搜索 → Markdown 报告
 *
 * 开发态前端由 Vite(5173)提供,/api 经 Vite 代理到本服务(3009):
 *   pnpm --filter ai-insurance-advisor-agent dev
 * 生产态单端口:先 build(vite build + tsc),再 serve:
 *   pnpm --filter ai-insurance-advisor-agent serve
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveModelChoice } from './config.js';
import { createRuntimeRegistry, streamAdvise, type AdviseProgress, type ClientProfile } from './runtime.js';

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

/** 数值字段安全读取:非有限数 → NaN(供校验) */
function readNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** 校验客户资料:返回 error 文案或 null */
function validateProfile(p: Record<string, unknown> | undefined): string | null {
  if (!p || typeof p !== 'object') return '缺少 profile 参数(客户资料)';
  const numeric: Array<[string, number]> = [
    ['age', readNumber(p.age)],
    ['annual_income', readNumber(p.annual_income)],
    ['total_debt', readNumber(p.total_debt)],
    ['available_savings', readNumber(p.available_savings)],
    ['existing_life_insurance', readNumber(p.existing_life_insurance)],
    ['income_replacement_years', readNumber(p.income_replacement_years)],
  ];
  for (const [name, v] of numeric) {
    if (Number.isNaN(v)) return `客户资料字段 ${name} 缺失或不是有效数字`;
    if (v < 0) return `客户资料字段 ${name} 不能为负数`;
  }
  if (readNumber(p.age) < 18 || readNumber(p.age) > 85) return 'age 需在 18~85 之间';
  if (![5, 10, 15].includes(readNumber(p.income_replacement_years))) {
    return 'income_replacement_years 需为 5 / 10 / 15 之一';
  }
  if (!String(p.currency || '').trim()) return '缺少 currency 字段(货币代码)';
  return null;
}

async function main() {
  const config = loadConfig();

  // Runtime 注册表:按用户选择的模型按需构建并缓存(带计算/搜索两工具)
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

      // ── POST /api/advise (SSE 流式) ──────────────────────────
      if (req.method === 'POST' && url.pathname === '/api/advise') {
        return handleAdvise(req, res, { registry, config });
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
      '║   🛡️  AI Insurance Advisor (aipack)            ║',
      '╠══════════════════════════════════════════════════╣',
      `║  顾问模型: ${pad(`${config.provider}/${config.modelId}`, 39)}║`,
      `║  Key 就绪: ${pad(config.llmReady ? '✅' : '❌', 39)}║`,
      `║  搜索后端: ${pad(config.searchBackend, 39)}║`,
      `║  保额计算: ${pad('本地确定性公式(免沙箱)', 39)}║`,
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

// ─── SSE:/api/advise ──────────────────────────────────────────────

async function handleAdvise(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: {
    registry: ReturnType<typeof createRuntimeRegistry>;
    config: ReturnType<typeof loadConfig>;
  },
) {
  const body = (await readJson(req).catch(() => null)) as { profile?: Record<string, unknown>; model?: PickedModel } | null;

  // 客户资料校验(缺失/非法字段 → 400,引导用户补全)
  const profileError = validateProfile(body?.profile);
  if (profileError) {
    return json(res, 400, { error: `客户资料有误:${profileError}` });
  }

  // ── 解析模型选择(缺省回退默认模型)────────────────────────────
  const { choice, error } = resolveModelChoice(body?.model, {
    provider: ctx.config.provider,
    modelId: ctx.config.modelId,
  });
  if (error) {
    return json(res, 400, { error: `顾问模型:${error}` });
  }

  let runtime;
  try {
    runtime = ctx.registry.get(choice.provider, choice.modelId, choice.apiKey);
  } catch (e) {
    return json(res, 400, { error: (e as Error).message });
  }

  const profile: ClientProfile = {
    age: readNumber(body!.profile!.age),
    annual_income: readNumber(body!.profile!.annual_income),
    dependents: readNumber(body!.profile!.dependents) || 0,
    location: String(body!.profile!.location || '').trim(),
    total_debt: readNumber(body!.profile!.total_debt),
    available_savings: readNumber(body!.profile!.available_savings),
    existing_life_insurance: readNumber(body!.profile!.existing_life_insurance),
    income_replacement_years: readNumber(body!.profile!.income_replacement_years),
    currency: String(body!.profile!.currency || '').trim().toUpperCase(),
  };

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

  const onProgress = (p: AdviseProgress) => {
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
    await streamAdvise({ profile }, runtime, onProgress, ac.signal);
  } catch (err) {
    const msg = (err as Error).message === 'aborted' ? '客户端已断开' : (err as Error).message;
    if (msg !== '客户端已断开') {
      send('error', { message: msg });
      console.error('[/api/advise] 失败:', err);
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
    res.end('404 Not Found\n\n(开发态请访问 http://localhost:5173;生产态请先执行 pnpm --filter ai-insurance-advisor-agent build)');
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
