/**
 * starter_ai_agents/ai_research_agent/src/tools/hackernews.ts
 *
 * HackerNews 搜索工具(aipack Tool),等价源应用 multi_agent_researcher 的 HackerNewsTools:
 * 走 Algolia HN Search API(https://hn.algolia.com/api,免费免 Key),返回标题/链接/得分/评论数/摘要。
 *
 * 技术类主题的研究利器:社区讨论往往包含一手观点与实践经验。
 */
import type { Tool } from '@aipack-ai/agent';

interface HnHit {
  objectID?: string;
  title?: string | null;
  url?: string | null;
  story_text?: string | null;
  comment_text?: string | null;
  points?: number | null;
  num_comments?: number | null;
  author?: string | null;
  created_at?: string | null;
}

interface HnSearchArgs {
  query?: string;
  limit?: number;
  /** 按时间过滤:all(默认)/ last_month / last_year */
  period?: string;
}

export function createHackerNewsTool(): Tool {
  return {
    name: 'search_hackernews',
    description:
      '搜索 Hacker News 社区的帖子和讨论(技术/创业/产品主题的一手观点与实践经验)。' +
      '技术类研究主题优先调用,可与其他 web 搜索互补。返回标题、链接、得分、评论数与正文摘要。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词' },
        limit: { type: 'number', description: '返回结果数量上限,默认 8' },
        period: { type: 'string', description: '时间范围:all(默认)/ last_month / last_year' },
      },
      required: ['query'],
    },
    async execute(_toolCallId, args) {
      const { query, limit = 8, period } = (args ?? {}) as HnSearchArgs;
      if (!query) {
        return { content: [{ type: 'text', text: '错误:缺少 query 参数' }], details: { error: 'missing_query' } };
      }

      const tags = period === 'last_month' || period === 'last_year' ? `created_at_i>${Math.floor(Date.now() / 1000) - (period === 'last_month' ? 30 * 86400 : 365 * 86400)}` : undefined;

      const url = new URL('https://hn.algolia.com/api/v1/search');
      url.searchParams.set('query', query);
      url.searchParams.set('hitsPerPage', String(Math.max(1, Math.min(20, limit))));
      url.searchParams.set('tags', 'story');
      if (tags) url.searchParams.set('numericFilters', tags);

      try {
        const res = await fetch(url.toString(), {
          headers: { 'User-Agent': 'ai-research-agent/0.1' },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { hits?: HnHit[]; nbHits?: number };
        const hits = (data.hits ?? []).filter((h) => h.title);

        if (hits.length === 0) {
          return { content: [{ type: 'text', text: `[HackerNews] "${query}" 无相关帖子。` }], details: { count: 0 } };
        }

        const lines = [`[搜索来源: HackerNews(Algolia)] 查询: "${query}" · 共 ${data.nbHits ?? hits.length} 命中,展示 ${hits.length} 条:`, ''];
        hits.forEach((h, i) => {
          const meta: string[] = [];
          if (h.points != null) meta.push(`${h.points} 分`);
          if (h.num_comments != null) meta.push(`${h.num_comments} 评论`);
          if (h.author) meta.push(`@${h.author}`);
          if (h.created_at) meta.push(h.created_at.slice(0, 10));
          lines.push(`${i + 1}. ${h.title}${meta.length ? `(${meta.join(' · ')})` : ''}`);
          if (h.url) lines.push(`   链接: ${h.url}`);
          const text = (h.story_text || h.comment_text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          if (text) lines.push(`   摘要: ${text.slice(0, 300)}`);
          lines.push(`   HN 讨论: https://news.ycombinator.com/item?id=${h.objectID}`);
          lines.push('');
        });
        return { content: [{ type: 'text', text: lines.join('\n') }], details: { source: 'hackernews', count: hits.length } };
      } catch (err) {
        return { content: [{ type: 'text', text: `HackerNews 搜索失败:${(err as Error).message}(查询 "${query}")。可改用 search_web。` }], details: { error: true } };
      }
    },
  };
}
