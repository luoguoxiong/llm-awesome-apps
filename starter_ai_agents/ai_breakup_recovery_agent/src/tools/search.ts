/**
 * starter_ai_agents/ai_breakup_recovery_agent/src/tools/search.ts
 *
 * web 搜索工具(aipack Tool),复用 ai_research_agent 的四层降级模式:
 *   1. SERPAPI_KEY 存在 → SerpAPI Google 搜索
 *   2. Bing(cn.bing.com,免费,国内网络通常可达)
 *   3. DuckDuckGo HTML(免费,部分网络环境被阻断)
 *   4. 通用兜底提示(不返回伪知识)
 *
 * 容错细节:每层 try/catch + fetch 超时(8s)+ 1 次重试 + User-Agent。
 * 迁移自源应用的 Brutal Honesty Agent 的 DuckDuckGoTools(Agno),
 * 用于搜索心理学/关系恢复的客观依据。
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

async function searchBing(query: string, limit: number): Promise<SearchResult[]> {
  const url = new URL('https://cn.bing.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(limit));
  const html = await fetchHtml(url.toString());

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

// ─── 汇总为文本 ───────────────────────────────────────────────────

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

// ─── 导出 aipack Tool ──────────────────────────────────────────

export function createSearchTool(serpapiKey?: string): Tool {
  return {
    name: 'search_web',
    description:
      '搜索网络获取客观依据(分手恢复期研究、关系心理学、情感疗愈方法等)。' +
      '在需要佐证观点或给出权威建议时调用,返回网页结果标题、摘要与链接。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词' },
        limit: { type: 'number', description: '返回结果数量上限,默认 5' },
      },
      required: ['query'],
    },
    async execute(_toolCallId, args) {
      const { query, limit = 5 } = (args ?? {}) as { query?: string; limit?: number };
      if (!query) {
        return { content: [{ type: 'text', text: '错误:缺少 query 参数' }], details: { error: 'missing_query' } };
      }

      // 四层降级链:每层失败打印原因后继续
      // 1) SerpAPI
      if (serpapiKey) {
        try {
          const results = await searchSerpapi(query, serpapiKey, limit);
          return { content: [{ type: 'text', text: formatResults(query, results, 'SerpAPI') }], details: { source: 'serpapi', count: results.length } };
        } catch (err) {
          console.warn(`[search_web] SerpAPI 失败,降级到 Bing:`, (err as Error).message);
        }
      }

      // 2) Bing(国内通常可达)
      try {
        const results = await searchBing(query, limit);
        return { content: [{ type: 'text', text: formatResults(query, results, 'Bing') }], details: { source: 'bing', count: results.length } };
      } catch (err) {
        console.warn(`[search_web] Bing 失败,降级到 DuckDuckGo:`, (err as Error).message);
      }

      // 3) DuckDuckGo(部分环境被阻断)
      try {
        const results = await searchDuckDuckGo(query, limit);
        return { content: [{ type: 'text', text: formatResults(query, results, 'DuckDuckGo') }], details: { source: 'duckduckgo', count: results.length } };
      } catch (err) {
        console.warn(`[search_web] DuckDuckGo 失败,降级到内置兜底:`, (err as Error).message);
      }

      // 4) 通用兜底
      const results = searchFallback(query);
      return { content: [{ type: 'text', text: formatResults(query, results, '通用提示(兜底)') }], details: { source: 'fallback', count: results.length } };
    },
  };
}
