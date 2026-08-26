/**
 * starter_ai_agents/ai_startup_trends_agent/src/tools/summaries.ts
 *
 * 文章摘要收集工具(aipack Tool),等价源应用的 Summary Writer Agent(Newspaper4kTools
 * include_summary):摘要整理阶段每深读一篇文章即调用保存(标题/来源/摘要),
 * 供趋势分析阶段撰写报告引用,同时通过 onSummary 回调实时推送前端(SSE summary 事件)。
 *
 * 每次分析创建独立的 SummariesStore(闭包),分析结束随 Runtime 一起丢弃。
 */
import type { Tool } from '@aipack-ai/agent';

export interface ArticleSummaryEntry {
  /** 文章标题 */
  title: string;
  /** 来源(URL) */
  source: string;
  /** 摘要(2-4 句话) */
  summary: string;
}

interface SaveSummaryArgs {
  title?: string;
  source?: string;
  summary?: string;
}

export interface SummariesStore {
  /** 已收集的文章摘要(报告完成后仍可读取) */
  readonly summaries: ArticleSummaryEntry[];
  /** save_article_summary 工具(闭包持有 store) */
  readonly tool: Tool;
}

/** 创建文章摘要 store + 配套工具。onSummary 在每次保存时被调用(如推送 SSE)。 */
export function createSummariesStore(onSummary?: (s: ArticleSummaryEntry) => void): SummariesStore {
  const summaries: ArticleSummaryEntry[] = [];
  const tool: Tool = {
    name: 'save_article_summary',
    description:
      '保存一篇已深读文章的摘要,供趋势分析阶段引用。摘要整理阶段每读完一篇有价值的文章就调用一次。' +
      '参数:title(文章标题)、source(来源 URL)、summary(2-4 句话概括核心内容:关键事实/数据/观点)。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '文章标题' },
        source: { type: 'string', description: '文章来源 URL' },
        summary: { type: 'string', description: '文章摘要,2-4 句话概括核心内容' },
      },
      required: ['title', 'summary'],
    },
    async execute(_toolCallId, args) {
      const { title, source, summary } = (args ?? {}) as SaveSummaryArgs;
      if (!title || !title.trim() || !summary || !summary.trim()) {
        return { content: [{ type: 'text', text: '错误:缺少 title 或 summary 参数' }], details: { error: 'missing_params' } };
      }
      const entry: ArticleSummaryEntry = {
        title: title.trim().slice(0, 200),
        source: (source || '未注明').trim(),
        summary: summary.trim(),
      };
      summaries.push(entry);
      onSummary?.(entry);
      return {
        content: [{ type: 'text', text: `已保存文章摘要 #${summaries.length}:${entry.title}(来源:${entry.source})` }],
        details: { count: summaries.length },
      };
    },
  };
  return { summaries, tool };
}
