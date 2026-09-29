/**
 * foreign_trade_apps/ai_trade_lead_agent/src/tools/search.ts
 *
 * web 搜索工具(aipack Tool),复用 ai_research_agent 的四层降级模式:
 *   1. SERPAPI_KEY 存在 → SerpAPI Google 搜索
 *   2. Bing(cn.bing.com,免费,国内网络通常可达)
 *   3. DuckDuckGo HTML(免费,部分网络环境被阻断)
 *   4. 通用兜底提示(不返回伪知识)
 *
 * 除 Tool 外还导出 runSearch(),供 importyeti.ts 做 site: 限定降级检索。
 * 容错细节:每层 try/catch + fetch 超时(8s)+ 1 次重试 + User-Agent。
 */
import type { Tool } from '@aipack-ai/agent';

export interface SearchResult {
  title: string;
  snippet: string;
  url?: string;
}

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** 带 1 次重试 + 8s 超时 + User-Agent 的 fetch */
async function fetchHtml(url: string, init: RequestInit = {}, retries = 1): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'User-Agent': BROWSER_UA, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      // 超时/连接失败才重试;4xx 不重试
      const msg = (err as Error).message || '';
      if (/HTTP 4\d\d/.test(msg)) throw err;
    }
    if (attempt < retries) await sleep(400 * (attempt + 1));
  }
  throw lastErr instanceof Error ? lastErr : new Error('fetch failed');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 解码常见 HTML 实体 */
function decodeEntities(s: string): string {
  return s
    .replace(/&ensp;|&emsp;|&nbsp;/g, ' ')
    .replace(/&#0183;|&middot;|·/g, '·')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#\d+;/g, (m) => {
      const code = parseInt(m.slice(2, -1), 10);
      return isNaN(code) ? m : String.fromCharCode(code);
    });
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
}

// ─── 后端 1:SerpAPI ───────────────────────────────────────────────

async function searchSerpapi(query: string, apiKey: string, limit: number): Promise<SearchResult[]> {
  const url = new URL('https://serpapi.com/search');
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', query);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('num', String(limit));
  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': BROWSER_UA },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`SerpAPI HTTP ${res.status}`);
  const data = (await res.json()) as { organic_results?: Array<{ title?: string; snippet?: string; link?: string }> };
  return (data.organic_results ?? [])
    .slice(0, limit)
    .map((r) => ({ title: r.title ?? '(无标题)', snippet: r.snippet ?? '', url: r.link }));
}

// ─── 后端 2:Bing(cn.bing.com,国内可达)──────────────────────────────

/**
 * Bing 检索:ensearch=1 取英文结果(外贸场景);国内站优先(国内网络通常可达),
 * 失败再试国际站。注意:免费后端可能忽略 site: 等高级语法,查询应把最具区分度的词放前面。
 */
async function searchBing(query: string, limit: number): Promise<SearchResult[]> {
  const hosts = ['https://cn.bing.com/search', 'https://www.bing.com/search'];
  let html = '';
  let lastErr: unknown;
  for (const host of hosts) {
    try {
      const url = new URL(host);
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(limit));
      url.searchParams.set('ensearch', '1'); // 英文结果
      html = await fetchHtml(url.toString());
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!html) throw lastErr instanceof Error ? lastErr : new Error('Bing 请求失败');

  const results: SearchResult[] = [];
  const blockRe = /<li class="b_algo"[\s\S]*?<\/li>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null && results.length < limit) {
    const block = m[0];
    const h2 = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    if (!h2) continue;
    const href = h2[1].match(/href="([^"]+)"/);
    const title = stripTags(h2[1]);
    if (!title) continue;
    const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const snippet = p ? stripTags(p[1]) : '';
    results.push({ title, snippet, url: href ? decodeEntities(href[1]) : undefined });
  }
  if (results.length === 0) throw new Error('Bing 未解析到结果');
  return results;
}

// ─── 后端 3:DuckDuckGo HTML(免费,部分环境被阻断)──────────────────

async function searchDuckDuckGo(query: string, limit: number): Promise<SearchResult[]> {
  const url = new URL('https://html.duckduckgo.com/html/');
  const html = await fetchHtml(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `q=${encodeURIComponent(query)}`,
  });

  const results: SearchResult[] = [];
  const blockRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) && results.length < limit) {
    const title = stripTags(m[2]);
    const snippet = stripTags(m[3]);
    if (title) results.push({ title, snippet, url: decodeDdgRedirect(m[1]) });
  }
  if (results.length === 0) throw new Error('DuckDuckGo 未解析到结果');
  return results;
}

function decodeDdgRedirect(url: string): string | undefined {
  try {
    const u = new URL(url.startsWith('//') ? `https:${url}` : url);
    const uddg = u.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : url;
  } catch {
    return url;
  }
}

// ─── 后端 4:通用兜底(不伪造知识,只说明状态)──────────────────────

function searchFallback(query: string): SearchResult[] {
  return [
    {
      title: '搜索后端暂不可用',
      snippet:
        `所有免费搜索后端(Bing / DuckDuckGo)均未能返回 "${query}" 的结果。` +
        '请在 .env 配置 SERPAPI_KEY 以启用 SerpAPI 搜索,或基于已知信息作答并说明数据可能不是最新。',
    },
  ];
}

// ─── 汇总 ────────────────────────────────────────────────────────

export interface SearchOutcome {
  results: SearchResult[];
  source: string;
}

/** 执行一次搜索并返回结果与命中的后端(供 Tool 与 importyeti 降级链共用) */
export async function runSearch(query: string, limit: number, serpapiKey?: string): Promise<SearchOutcome> {
  if (serpapiKey) {
    try {
      const results = await searchSerpapi(query, serpapiKey, limit);
      return { results, source: 'SerpAPI' };
    } catch (err) {
      console.warn(`[search_web] SerpAPI 失败,降级到 Bing:`, (err as Error).message);
    }
  }
  try {
    const results = await searchBing(query, limit);
    return { results, source: 'Bing' };
  } catch (err) {
    console.warn(`[search_web] Bing 失败,降级到 DuckDuckGo:`, (err as Error).message);
  }
  try {
    const results = await searchDuckDuckGo(query, limit);
    return { results, source: 'DuckDuckGo' };
  } catch (err) {
    console.warn(`[search_web] DuckDuckGo 失败,降级到内置兜底:`, (err as Error).message);
  }
  return { results: searchFallback(query), source: '通用提示(兜底)' };
}

function formatResults(query: string, results: SearchResult[], source: string): string {
  const lines = [`[搜索来源: ${source}] 查询: "${query}"`, `共 ${results.length} 条结果:`, ''];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    if (r.url) lines.push(`   链接: ${r.url}`);
    lines.push('');
  });
  return lines.join('\n');
}

/** 搜索结果 → 纯文本(供 importyeti 等工具组装自己的输出) */
export function formatResultsText(query: string, results: SearchResult[], source: string): string {
  return formatResults(query, results, source);
}

// ─── 导出 aipack Tool ──────────────────────────────────────────

export function createSearchTool(serpapiKey?: string): Tool {
  return {
    name: 'search_web',
    description:
      '搜索网络获取外贸线索信息(进口商官网、LinkedIn 公司页、供应商信息、行业目录、新闻等)。' +
      '可尝试 site: 语法(如 "<company> site:linkedin.com/company"),但免费后端可能忽略高级语法:' +
      '请把最具区分度的词(公司名/品牌名)放在查询开头,如 "<company> official website contact email"。' +
      '返回网页标题、摘要与链接;结果质量取决于搜索后端,配置 SERPAPI_KEY 可显著提升。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词' },
        limit: { type: 'number', description: '返回结果数量上限,默认 6' },
      },
      required: ['query'],
    },
    async execute(_toolCallId, args) {
      const { query, limit = 6 } = (args ?? {}) as { query?: string; limit?: number };
      if (!query) {
        return { content: [{ type: 'text', text: '错误:缺少 query 参数' }], details: { error: 'missing_query' } };
      }
      const { results, source } = await runSearch(query, limit, serpapiKey);
      return {
        content: [{ type: 'text', text: formatResults(query, results, source) }],
        details: { source, count: results.length },
      };
    },
  };
}
