/**
 * starter_ai_agents/ai_research_agent/src/tools/fetchUrl.ts
 *
 * URL 阅读工具(aipack Tool),等价源应用 multi_agent_researcher 的 Newspaper4kTools:
 * 抓取网页 → 剥离脚本/样式/导航等噪音 → 提取正文纯文本(截断保护),供 Agent 深读文章。
 *
 * 迁移说明:源应用用 newspaper4k(Python 库)做正文抽取;本实现用正则启发式
 * (去 script/style/nav → 取文本密度最高的区块近似),零依赖、免沙箱。
 */
import type { Tool } from '@aipack-ai/agent';

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** 返回给 LLM 的正文上限(字符) */
const MAX_TEXT_CHARS = 6000;

interface FetchArgs {
  url?: string;
  max_chars?: number;
}

export function createFetchUrlTool(): Tool {
  return {
    name: 'fetch_url',
    description:
      '抓取指定 URL 的网页正文(剥离导航/脚本/样式,提取主要文本)。用于深读搜索结果或 HackerNews 帖子中最有价值的文章,获取详细信息。' +
      '返回纯文本正文(最长约 6000 字符)。非 HTML 内容(如 JSON API)会返回原始片段。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要阅读的文章/页面 URL(须含 http:// 或 https://)' },
        max_chars: { type: 'number', description: '返回正文的最大字符数,默认 6000' },
      },
      required: ['url'],
    },
    async execute(_toolCallId, args) {
      const { url, max_chars } = (args ?? {}) as FetchArgs;
      if (!url || !/^https?:\/\//i.test(url)) {
        return { content: [{ type: 'text', text: '错误:url 参数缺失或不是合法的 http(s) 链接' }], details: { error: 'invalid_url' } };
      }
      const limit = Math.max(500, Math.min(12000, Math.round(max_chars ?? MAX_TEXT_CHARS)));

      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': BROWSER_UA,
            Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(12000),
        });
        if (!res.ok) {
          return { content: [{ type: 'text', text: `抓取失败:HTTP ${res.status}(${url})` }], details: { error: true, status: res.status } };
        }

        const contentType = res.headers.get('content-type') || '';
        const raw = await res.text();

        // JSON 响应:直接截断返回
        if (contentType.includes('json') || /^\s*[[{]/.test(raw)) {
          const text = raw.slice(0, limit);
          return { content: [{ type: 'text', text: `[JSON 响应 · ${url}]\n${text}` }], details: { kind: 'json' } };
        }

        const title = extractTitle(raw);
        const text = extractArticleText(raw, limit);
        if (!text) {
          return { content: [{ type: 'text', text: `页面无可提取正文(可能是纯脚本/二进制页面):${url}` }], details: { error: true } };
        }
        const header = title ? `[${title}]\n来源: ${url}\n\n` : `来源: ${url}\n\n`;
        return { content: [{ type: 'text', text: header + text }], details: { kind: 'html', title } };
      } catch (err) {
        const msg = (err as Error).name === 'TimeoutError' ? '抓取超时(12s)' : (err as Error).message;
        return { content: [{ type: 'text', text: `抓取失败:${msg}(${url})` }], details: { error: true } };
      }
    },
  };
}

/** 提取 <title>(解码实体) */
function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return '';
  return decodeEntities(m[1].replace(/\s+/g, ' ').trim()).slice(0, 200);
}

/**
 * 启发式正文抽取:
 *   1) 去 script/style/noscript/header/footer/nav/aside/form
 *   2) 优先取 <article>/<main> 或文本密度最高的 <div>/<section> 候选
 *   3) 剥标签 → 解码实体 → 规范空白 → 按段落拼接
 */
function extractArticleText(html: string, limit: number): string {
  let body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|header|footer|nav|aside|form)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(script|style|noscript|br|hr|img|input|meta|link)[^>]*\/?>/gi, ' ');

  // 候选区块:article > main > 文本最长的 div/section
  let candidates: string[] = [];
  const article = body.match(/<article[^>]*>([\s\S]*?)<\/article>/gi);
  const main = body.match(/<main[^>]*>([\s\S]*?)<\/main>/gi);
  if (article && article.length) candidates = article;
  else if (main && main.length) candidates = main;
  else {
    const blocks = [...body.matchAll(/<(?:div|section)[^>]*>([\s\S]*?)<\/(?:div|section)>/gi)].map((m) => m[0]);
    // 按剥标签后文本长度排序取最长
    candidates = blocks
      .map((b) => ({ b, len: b.replace(/<[^>]+>/g, '').length }))
      .sort((x, y) => y.len - x.len)
      .slice(0, 3)
      .map((x) => x.b);
  }

  const text = candidates
    .map((block) => textify(block))
    .filter((t) => t.length > 80)
    .join('\n\n');
  const finalText = text || textify(body);
  return finalText.slice(0, limit);
}

/** HTML 块 → 段落文本 */
function textify(html: string): string {
  return decodeEntities(
    html
      .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '· ')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0 && !/^(·\s*)?$/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&ensp;|&emsp;|&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&hellip;/g, '…')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
}
