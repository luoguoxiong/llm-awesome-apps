/**
 * starter_ai_agents/ai_finance_agent/src/tools/market.ts
 *
 * 股票行情工具(aipack Tool),源应用 YFinanceTools 的免 Key 等价实现,四层降级:
 *   1. Yahoo Finance chart API(query1.finance.yahoo.com,免 Key,带浏览器 UA;海外网络友好)
 *   2. 腾讯财经(qt.gtimg.cn 报价 + web.ifzq.gtimg.cn 日 K,免 Key;中国网络友好,支持美股/A股)
 *   3. Stooq CSV(stooq.com,免 Key,美股加 .us 后缀)
 *   4. 兜底提示(行情源均不可达,建议 Agent 用 search_web 搜索行情)
 *
 * 容错细节:每层 try/catch + fetch 超时 + 1 次重试 + User-Agent;
 * 腾讯接口返回 GBK 编码,用 TextDecoder('gbk') 解码(Node 18+ 内置 ICU)。
 * 模式对齐 ai_travel_agent/src/tools/search.ts(多层降级)。
 */
import type { Tool } from '@aipack-ai/agent';

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** 数字格式化辅助(腾讯接口字段为字符串,兼容 number | string) */
function fmt(n: number | string | undefined | null): string {
  const v = Number(n);
  if (n === undefined || n === null || n === '' || !isFinite(v)) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function pct(n: number | undefined | null): string {
  if (n === undefined || n === null || !isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

/** 规范化 symbol:去空格、大写 */
function normalizeSymbol(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

/** 带 1 次重试 + 超时 + User-Agent 的 fetch(JSON) */
async function fetchJson<T>(url: string, timeoutMs = 8000, retries = 1): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      const msg = (err as Error).message || '';
      if (/HTTP 4\d\d/.test(msg)) throw err;
    }
    if (attempt < retries) await sleep(500 * (attempt + 1));
  }
  throw lastErr instanceof Error ? lastErr : new Error('fetch failed');
}

/** 带 1 次重试 + 超时 + User-Agent 的 fetch(文本) */
async function fetchText(url: string, timeoutMs = 8000, retries = 1): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': BROWSER_UA },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      const msg = (err as Error).message || '';
      if (/HTTP 4\d\d/.test(msg)) throw err;
    }
    if (attempt < retries) await sleep(500 * (attempt + 1));
  }
  throw lastErr instanceof Error ? lastErr : new Error('fetch failed');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 带 1 次重试 + 超时 + User-Agent + Referer 的 fetch,并以 GBK 解码(腾讯接口编码) */
async function fetchGbk(url: string, timeoutMs = 8000, retries = 1): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': BROWSER_UA, Referer: 'https://gu.qq.com/' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      // 腾讯返回 GBK;Node 18+ 内置 full-icu 支持 gbk,无 icu 构建回退 utf-8(中文会乱码但价格可用)
      try {
        return new TextDecoder('gbk').decode(buf);
      } catch {
        return new TextDecoder('utf-8').decode(buf);
      }
    } catch (err) {
      lastErr = err;
      const msg = (err as Error).message || '';
      if (/HTTP 4\d\d/.test(msg)) throw err;
    }
    if (attempt < retries) await sleep(500 * (attempt + 1));
  }
  throw lastErr instanceof Error ? lastErr : new Error('fetch failed');
}

/** 映射 symbol 到腾讯代码:600519.SS/SH→sh600519、000001.SZ→sz000001、600519→sh600519、AAPL→usAAPL */
function toTencentSymbol(symbol: string): string | null {
  const s = symbol.toUpperCase();
  const suf = s.match(/^(\d{6})\.(SS|SH|SZ)$/);
  if (suf) return `${suf[2] === 'SZ' ? 'sz' : 'sh'}${suf[1]}`;
  if (/^\d{6}$/.test(s)) return `${s.startsWith('6') ? 'sh' : 'sz'}${s}`;
  if (/^[A-Z][A-Z0-9.-]*$/.test(s)) return `us${s}`;
  return null;
}

// ─── 后端 1:Yahoo Finance chart API ──────────────────────────────

/** Yahoo chart API 响应结构(仅取所需字段) */
interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: {
        symbol?: string;
        currency?: string;
        exchangeName?: string;
        instrumentType?: string;
        regularMarketPrice?: number;
        previousClose?: number;
        chartPreviousClose?: number;
        regularMarketVolume?: number;
        longName?: string;
        shortName?: string;
        fiftyTwoWeekHigh?: number;
        fiftyTwoWeekLow?: number;
        regularMarketDayHigh?: number;
        regularMarketDayLow?: number;
        regularMarketTime?: number;
      };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          close?: (number | null)[];
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          volume?: (number | null)[];
        }>;
      };
    }>;
    error?: { code?: string; description?: string } | null;
  };
}

/** 请求 Yahoo chart(报价与历史共用) */
async function fetchYahooChart(
  symbol: string,
  range: string,
): Promise<NonNullable<YahooChartResponse['chart']>> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const data = await fetchJson<YahooChartResponse>(url);
  const chart = data.chart;
  if (chart?.error) throw new Error(`Yahoo API 错误:${chart.error.description || chart.error.code}`);
  if (!chart?.result?.length) throw new Error('Yahoo 返回空结果');
  return chart;
}

/** Yahoo 当前报价 */
async function quoteYahoo(symbol: string): Promise<string> {
  const chart = await fetchYahooChart(symbol, '1d');
  const m = chart!.result![0]!.meta ?? {};
  const price = m.regularMarketPrice ?? 0;
  const prev = m.previousClose ?? m.chartPreviousClose ?? 0;
  const change = price - prev;
  const changePct = prev !== 0 ? (change / prev) * 100 : 0;
  const name = m.longName ?? m.shortName ?? symbol;
  const lines = [
    `[行情来源: Yahoo Finance] ${name}(${symbol})`,
    `交易所: ${m.exchangeName ?? '—'} · 币种: ${m.currency ?? '—'} · 类型: ${m.instrumentType ?? '—'}`,
    '',
    `| 指标 | 数值 |`,
    `| --- | --- |`,
    `| 最新价 | ${fmt(price)} |`,
    `| 涨跌 | ${change >= 0 ? '+' : ''}${fmt(change)}(${pct(changePct)}) |`,
    `| 昨收 | ${fmt(prev)} |`,
    `| 今日最高/最低 | ${fmt(m.regularMarketDayHigh)} / ${fmt(m.regularMarketDayLow)} |`,
    `| 52 周最高/最低 | ${fmt(m.fiftyTwoWeekHigh)} / ${fmt(m.fiftyTwoWeekLow)} |`,
    `| 成交量 | ${fmt(m.regularMarketVolume)} |`,
  ];
  return lines.join('\n');
}

/** 历史统计摘要(收盘序列 → Markdown 统计表),Yahoo 与腾讯共用 */
function summarizeHistory(source: string, symbol: string, days: number, closes: number[]): string {
  if (closes.length === 0) throw new Error('历史数据为空');
  const first = closes[0];
  const last = closes[closes.length - 1];
  const ret = first !== 0 ? ((last - first) / first) * 100 : 0;
  const high = Math.max(...closes);
  const low = Math.min(...closes);
  const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
  // 日收益率标准差(年化,252 交易日)
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const meanRet = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance = rets.reduce((a, b) => a + (b - meanRet) ** 2, 0) / (rets.length || 1);
  const annualVol = Math.sqrt(variance * 252) * 100;

  return [
    `[行情来源: ${source}] ${symbol} 近 ${days} 天日线统计(共 ${closes.length} 个交易日)`,
    '',
    `| 指标 | 数值 |`,
    `| --- | --- |`,
    `| 期初收盘 | ${fmt(first)} |`,
    `| 期末收盘 | ${fmt(last)} |`,
    `| 区间涨跌幅 | ${pct(ret)} |`,
    `| 区间最高 | ${fmt(high)} |`,
    `| 区间最低 | ${fmt(low)} |`,
    `| 均价 | ${fmt(mean)} |`,
    `| 年化波动率 | ${annualVol.toFixed(1)}% |`,
    '',
    `最近 5 个交易日收盘(旧→新): ${closes.slice(-5).map((c) => fmt(c)).join(', ')}`,
  ].join('\n');
}

/** Yahoo 历史日线(近 N 天) */
async function historyYahoo(symbol: string, days: number): Promise<string> {
  const chart = await fetchYahooChart(symbol, `${days}d`);
  const result = chart.result![0]!;
  const closes = (result.indicators?.quote?.[0]?.close ?? []).filter((v): v is number => v != null);
  return summarizeHistory('Yahoo Finance', symbol, days, closes);
}

// ─── 后端 2:腾讯财经(中国网络友好)─────────────────────────────

/** 腾讯当前报价(qt.gtimg.cn,GBK;~ 分隔字段,字段位置美股/A 股一致) */
async function quoteTencent(symbol: string): Promise<string> {
  const tsm = toTencentSymbol(symbol);
  if (!tsm) throw new Error(`腾讯行情不支持代码 ${symbol}`);
  const text = await fetchGbk(`https://qt.gtimg.cn/q=${encodeURIComponent(tsm)}`);
  const m = text.match(/="([^"]*)"/);
  const f = m?.[1]?.split('~') ?? [];
  const price = Number(f[3]);
  if (f.length < 37 || !f[3] || !isFinite(price) || price <= 0) {
    throw new Error('腾讯返回无效报价');
  }
  const prev = Number(f[4]) || price;
  const change = price - prev;
  const changePct = prev !== 0 ? (change / prev) * 100 : 0;
  const isUS = tsm.startsWith('us');
  const name = (isUS ? f[46] || f[1] : f[1]) || symbol;

  const lines = [
    `[行情来源: 腾讯财经] ${name}(${symbol})`,
    isUS
      ? `币种: ${f[35] || '—'} · 代码: ${f[2] || tsm}`
      : `市场: ${tsm.startsWith('sh') ? '沪市 A 股' : '深市 A 股'} · 币种: CNY`,
    `行情时间: ${f[30] || '—'}`,
    '',
    `| 指标 | 数值 |`,
    `| --- | --- |`,
    `| 最新价 | ${fmt(price)} |`,
    `| 涨跌 | ${change >= 0 ? '+' : ''}${fmt(change)}(${pct(changePct)}) |`,
    `| 昨收 | ${fmt(prev)} |`,
    `| 开盘 | ${fmt(f[5])} |`,
    `| 日内最高/最低 | ${fmt(f[33])} / ${fmt(f[34])} |`,
  ];
  // 52 周高低仅美股报价提供(字段 48/49)
  if (isUS && f[48] && f[49]) {
    lines.push(`| 52 周最高/最低 | ${fmt(Number(f[48]))} / ${fmt(Number(f[49]))} |`);
  }
  lines.push(`| 成交量 | ${fmt(f[36])}${isUS ? '(股)' : '(手)'}`);
  return lines.join('\n');
}

/** 腾讯历史日 K(web.ifzq.gtimg.cn,JSON;A 股直接查,美股需带交易所后缀 .OQ/.N 才有完整历史) */
async function historyTencent(symbol: string, days: number): Promise<string> {
  const tsm = toTencentSymbol(symbol);
  if (!tsm) throw new Error(`腾讯历史数据不支持代码 ${symbol}`);
  const candidates = tsm.startsWith('us') ? [`${tsm}.OQ`, `${tsm}.N`, tsm] : [tsm];

  let closes: number[] | null = null;
  let lastErr: unknown = null;
  for (const code of candidates) {
    try {
      const n = Math.min(days + 10, 400); // 多取几天再截取,覆盖休市
      const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${encodeURIComponent(code)},day,,,${n},qfq`;
      const res = await fetchJson<{ data?: Record<string, { qfqday?: unknown[][]; day?: unknown[][] }> }>(url);
      const d = res.data?.[code];
      const raw = d?.qfqday ?? d?.day;
      if (!raw?.length) throw new Error('腾讯日 K 为空');
      closes = raw.map((r) => Number(r[2])).filter((c) => isFinite(c)).slice(-days);
      if (!closes.length) throw new Error('腾讯日 K 无有效收盘价');
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!closes) throw lastErr instanceof Error ? lastErr : new Error('腾讯日 K 查询失败');
  return summarizeHistory('腾讯财经', symbol, days, closes);
}

// ─── 后端 3:Stooq CSV(当前报价)────────────────────────────────

/** Stooq 当前报价:Symbol,Date,Time,Open,High,Low,Close,Volume */
async function quoteStooq(symbol: string): Promise<string> {
  // 美股在 Stooq 需要 .us 后缀;指数等其他类型尝试原样
  const candidates = /^[A-Z.]+$/.test(symbol) && !symbol.includes('.') ? [`${symbol}.US`, symbol] : [symbol];
  let lastErr: unknown;
  for (const sym of candidates) {
    try {
      const csv = await fetchText(`https://stooq.com/q/l/?s=${encodeURIComponent(sym.toLowerCase())}&f=sd2t2ohlcv&h&e=csv`);
      const lines = csv.trim().split('\n');
      if (lines.length < 2) throw new Error('Stooq 返回行数不足');
      const [symCol, date, , open, high, low, close, volume] = lines[1].split(',');
      if (!close || isNaN(Number(close))) throw new Error('Stooq 返回无效价格');
      const o = Number(open), h = Number(high), l = Number(low), c = Number(close);
      const chg = o !== 0 ? ((c - o) / o) * 100 : 0;
      return [
        `[行情来源: Stooq] ${symbol}(查询代码 ${symCol})`,
        `日期: ${date || '—'}`,
        '',
        `| 指标 | 数值 |`,
        `| --- | --- |`,
        `| 收盘价 | ${fmt(c)} |`,
        `| 开盘价 | ${fmt(o)} |`,
        `| 日内涨跌(相对开盘) | ${pct(chg)} |`,
        `| 日内最高/最低 | ${fmt(h)} / ${fmt(l)} |`,
        `| 成交量 | ${fmt(Number(volume))} |`,
      ].join('\n');
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Stooq 查询失败');
}

// ─── 后端 4:兜底 ────────────────────────────────────────────────

function quoteFallback(symbol: string): string {
  return `[行情源不可用] Yahoo、腾讯财经与 Stooq 均未能返回 ${symbol} 的行情数据。请改用 search_web 工具搜索 "${symbol} stock price" 获取近期报价,并向用户说明实时行情源暂不可用。`;
}

// ─── 导出 aipack Tool ──────────────────────────────────────────

/** 当前报价工具:get_stock_quote(symbol) */
export function createQuoteTool(): Tool {
  return {
    name: 'get_stock_quote',
    description:
      '查询股票/ETF/指数的当前行情:最新价、涨跌幅、昨收、日内高低、52 周高低、成交量。' +
      '支持美股(如 "AAPL")与 A 股(如 "600519" 或 "600519.SS")。数据源 Yahoo → 腾讯财经 → Stooq 免 Key 降级。' +
      '用户询问某标的"现价/今天涨跌"时调用。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '股票代码,如 "AAPL"、"MSFT"、"600519.SS"(Yahoo 格式)' },
      },
      required: ['symbol'],
    },
    async execute(_toolCallId, args) {
      const { symbol } = (args ?? {}) as { symbol?: string };
      if (!symbol) {
        return { content: [{ type: 'text', text: '错误:缺少 symbol 参数' }], details: { error: 'missing_symbol' } };
      }
      const sym = normalizeSymbol(symbol);

      // 降级链:Yahoo → 腾讯 → Stooq → 兜底
      try {
        const text = await quoteYahoo(sym);
        return { content: [{ type: 'text', text }], details: { source: 'yahoo' } };
      } catch (err) {
        console.warn(`[get_stock_quote] Yahoo 失败,降级到腾讯:`, (err as Error).message);
      }
      try {
        const text = await quoteTencent(sym);
        return { content: [{ type: 'text', text }], details: { source: 'tencent' } };
      } catch (err) {
        console.warn(`[get_stock_quote] 腾讯失败,降级到 Stooq:`, (err as Error).message);
      }
      try {
        const text = await quoteStooq(sym);
        return { content: [{ type: 'text', text }], details: { source: 'stooq' } };
      } catch (err) {
        console.warn(`[get_stock_quote] Stooq 失败,降级到兜底:`, (err as Error).message);
      }
      return { content: [{ type: 'text', text: quoteFallback(sym) }], details: { source: 'fallback' } };
    },
  };
}

/** 历史统计工具:get_stock_history(symbol, days) */
export function createHistoryTool(): Tool {
  return {
    name: 'get_stock_history',
    description:
      '查询股票/ETF 近 N 天(默认 30)的日线历史统计:区间涨跌幅、最高/最低、均价、年化波动率、最近 5 日收盘。' +
      '支持美股(如 "NVDA")与 A 股(如 "600519")。数据源 Yahoo → 腾讯财经免 Key 降级。' +
      '用户询问"近一个月/三个月表现、走势、波动"时调用。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '股票代码,如 "NVDA"' },
        days: { type: 'number', description: '回看天数,常用 30/90/180/365,默认 30' },
      },
      required: ['symbol'],
    },
    async execute(_toolCallId, args) {
      const { symbol, days = 30 } = (args ?? {}) as { symbol?: string; days?: number };
      if (!symbol) {
        return { content: [{ type: 'text', text: '错误:缺少 symbol 参数' }], details: { error: 'missing_symbol' } };
      }
      const sym = normalizeSymbol(symbol);
      const d = Math.max(1, Math.min(730, Math.round(days)));

      // 降级链:Yahoo → 腾讯 → 兜底
      try {
        const text = await historyYahoo(sym, d);
        return { content: [{ type: 'text', text }], details: { source: 'yahoo' } };
      } catch (err) {
        console.warn(`[get_stock_history] Yahoo 失败,降级到腾讯:`, (err as Error).message);
      }
      try {
        const text = await historyTencent(sym, d);
        return { content: [{ type: 'text', text }], details: { source: 'tencent' } };
      } catch (err) {
        console.warn(`[get_stock_history] 腾讯失败,降级到兜底:`, (err as Error).message);
      }
      return {
        content: [
          {
            type: 'text',
            text: `[历史数据不可用] 未能获取 ${sym} 近 ${d} 天的历史数据。` +
              `请改用 search_web 搜索 "${sym} stock performance" 获取近期走势信息,并向用户说明。`,
          },
        ],
        details: { source: 'fallback' },
      };
    },
  };
}
