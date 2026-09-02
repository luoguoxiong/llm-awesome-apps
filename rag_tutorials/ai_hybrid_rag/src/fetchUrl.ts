/**
 * rag_tutorials/ai_hybrid_rag/src/fetchUrl.ts
 *
 * URL 文档摄取（合并自源应用 ai_blog_search 的 WebBaseLoader + 本仓库
 * ai_blog_to_podcast_agent 的三层降级抓取模式）：
 *   1. FIRECRAWL_API_KEY 存在 → Firecrawl v2 /scrape（返回 markdown 正文）
 *   2. 原生 fetch + HTML 正文提取（去 script/style/nav，取 main/article/p 文本）
 *
 * 容错：每层 try/catch + fetch 超时（8s）+ 1 次重试 + User-Agent。
 */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** 单篇文档截断上限（摄取阶段限制，避免单 URL 撑爆索引与上下文） */
const MAX_CONTENT_CHARS = 60000;

export interface FetchedDocument {
  url: string;
  title: string;
  content: string;
  source: 'firecrawl' | 'fetch';
  truncated: boolean;
}

/** 带 1 次重试 + 8s 超时 + User-Agent 的 fetch */
async function fetchHtml(url: string, retries = 1): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': BROWSER_UA },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      // 超时/连接失败才重试；4xx 不重试
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

function truncate(s: string, max: number): { truncated: boolean; text: string } {
  if (s.length <= max) return { truncated: false, text: s };
  return { truncated: true, text: s.slice(0, max) + '\n\n[...内容已截断...]' };
}

/** URL 合法性校验（仅 http/https） */
export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// ─── 后端 1：Firecrawl v2 /scrape ─────────────────────────────────

async function fetchFirecrawl(url: string, apiKey: string): Promise<FetchedDocument> {
  const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url,
      formats: ['markdown'],
      onlyMainContent: true, // Firecrawl 自动去 nav/footer/script
    }),
    signal: AbortSignal.timeout(20000), // Firecrawl 较慢，给 20s
  });
  if (!res.ok) throw new Error(`Firecrawl HTTP ${res.status}`);
  const data = (await res.json()) as {
    data?: { markdown?: string; metadata?: { title?: string } };
  };
  const markdown = data.data?.markdown;
  if (!markdown || !markdown.trim()) throw new Error('Firecrawl 返回空 markdown');
  const { truncated, text } = truncate(markdown, MAX_CONTENT_CHARS);
  return {
    url,
    title: data.data?.metadata?.title || '',
    content: text,
    source: 'firecrawl',
    truncated,
  };
}

// ─── 后端 2：原生 fetch + HTML 正文提取 ──────────────────────────

/**
 * 零依赖 HTML 正文提取：去 script/style/nav/header/footer/aside，
 * 优先取 main/article，否则取整个 body；再提取 p/h/li/blockquote/pre 文本。
 */
function extractMainContent(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].trim()) : '';
  let body = html;
  body = body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  const mainMatch = body.match(/<(?:main|article)[\s\S]*?<\/(?:main|article)>/i);
  const region = mainMatch ? mainMatch[0] : body;
  const blocks: string[] = [];
  const blockRe = /<(?:p|h[1-6]|li|blockquote|pre)[^>]*>([\s\S]*?)<\/(?:p|h[1-6]|li|blockquote|pre)>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(region)) !== null) {
    const t = stripTags(m[1]);
    if (t.length > 20) blocks.push(t);
  }
  return { title, text: blocks.join('\n\n') };
}

async function fetchDirect(url: string): Promise<FetchedDocument> {
  const html = await fetchHtml(url);
  const { title, text } = extractMainContent(html);
  if (!text.trim()) throw new Error('HTML 解析为空');
  const { truncated, text: t } = truncate(text, MAX_CONTENT_CHARS);
  return { url, title, content: t, source: 'fetch', truncated };
}

/**
 * 抓取 URL 正文：Firecrawl（可选）→ 原生 fetch 两层降级。
 * 全部失败时抛出带原因的错误，由 server 转为 4xx 响应。
 */
export async function fetchUrlContent(url: string, firecrawlKey?: string): Promise<FetchedDocument> {
  if (firecrawlKey) {
    try {
      return await fetchFirecrawl(url, firecrawlKey);
    } catch (err) {
      console.warn(`[fetchUrl] Firecrawl 失败，降级到原生 fetch:`, (err as Error).message);
    }
  }
  return fetchDirect(url);
}
