/**
 * starter_ai_agents/ai_research_agent/src/tools/facts.ts
 *
 * 事实收集工具(aipack Tool),等价源应用 openai_research_agent 的 save_important_fact:
 * Research 阶段发现重要事实即调用保存(附来源),供 Editor 阶段撰写报告引用,
 * 同时通过 onFact 回调实时推送前端(SSE fact 事件)展示研究进展。
 *
 * 每次研究创建独立的 FactsStore(闭包),研究结束随 Runtime 一起丢弃。
 */
import type { Tool } from '@aipack-ai/agent';

export interface FactEntry {
  /** 事实内容 */
  fact: string;
  /** 来源(URL 或说明) */
  source: string;
}

interface SaveFactArgs {
  fact?: string;
  source?: string;
}

export interface FactsStore {
  /** 已收集的事实(报告完成后仍可读取) */
  readonly facts: FactEntry[];
  /** save_important_fact 工具(闭包持有 store) */
  readonly tool: Tool;
}

/** 创建事实收集 store + 配套工具。onFact 在每次保存时被调用(如推送 SSE)。 */
export function createFactsStore(onFact?: (f: FactEntry) => void): FactsStore {
  const facts: FactEntry[] = [];
  const tool: Tool = {
    name: 'save_important_fact',
    description:
      '保存研究过程中发现的重要事实(带来源),供撰写报告时引用。每发现一条值得写进报告的关键数据/结论/观点就调用一次。' +
      '参数:fact(事实内容,一句话)、source(来源,优先填 URL 或站点名)。',
    parameters: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: '重要事实,一句话概括' },
        source: { type: 'string', description: '事实来源(URL 或站点名)' },
      },
      required: ['fact'],
    },
    async execute(_toolCallId, args) {
      const { fact, source } = (args ?? {}) as SaveFactArgs;
      if (!fact || !fact.trim()) {
        return { content: [{ type: 'text', text: '错误:缺少 fact 参数' }], details: { error: 'missing_fact' } };
      }
      const entry: FactEntry = { fact: fact.trim(), source: (source || '未注明').trim() };
      facts.push(entry);
      onFact?.(entry);
      return { content: [{ type: 'text', text: `已保存事实 #${facts.length}:${entry.fact}(来源:${entry.source})` }], details: { count: facts.length } };
    },
  };
  return { facts, tool };
}
