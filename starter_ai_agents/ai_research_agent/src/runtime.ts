/**
 * starter_ai_agents/ai_research_agent/src/runtime.ts
 *
 * 深度研究 Agent(基于 @aipack-ai/agent,单次研究任务):
 *   - 输入:研究主题
 *   - 工具:search_web(四层降级搜索) / search_hackernews(HN Algolia)
 *          / fetch_url(网页正文抽取) / save_important_fact(事实收集,实时推送前端)
 *   - 编排:以一个系统提示词驱动「制定计划 → 多源搜索 → 深读与事实收集 → 撰写报告」
 *     的完整研究循环(等价源应用 Triage/Research/Editor 三 Agent 的接力,免多 Agent 依赖)
 *
 * 迁移自 awesome-llm-apps 的两个源应用(按 PLAN 合并):
 *   - starter_ai_agents/openai_research_agent(OpenAI Agents SDK:Triage→Research→Editor,
 *     WebSearchTool + save_important_fact + ResearchReport 结构化输出)
 *   - advanced_ai_agents/multi_agent_apps/multi_agent_researcher(Agno Team:
 *     HackerNewsTools + DuckDuckGoTools + Newspaper4kTools)
 */
import {
  createRuntime,
  createRequest,
  type Model,
  type StreamFn,
  type Runtime,
  type Tool,
} from '@aipack-ai/agent';

// ─── 系统提示词(三阶段研究循环)─────────────────────────────────

const RESEARCH_SYSTEM_PROMPT = `你是一位专业的研究员(AI Research Agent),负责对给定主题开展深度研究并产出综合报告。严格按以下三阶段工作:

阶段 1 — 制定研究计划(开头输出,简短):
  - 用 2-3 句话明确研究主题与范围
  - 列出 3-5 个具体搜索查询(Markdown 编号列表,标注"搜索查询")
  - 列出 3-5 个重点方向(标注"重点方向")
  然后立即开始研究,不要等待用户确认。

阶段 2 — 收集信息(多轮工具调用,研究的主体):
  - 调用 search_web 执行每个搜索查询;技术/创业/产品类主题同时调用 search_hackernews 获取社区讨论
  - 对最有价值的 2-4 个搜索结果调用 fetch_url 深读全文,提取详细信息
  - 发现重要事实(关键数据、核心结论、重要观点)时立即调用 save_important_fact 保存,source 尽量填 URL
  - 覆盖所有重点方向;信息不足时追加新的搜索查询
  - 全程至少执行 3 次搜索,信息足够后才进入写作

阶段 3 — 撰写研究报告(最终输出,Markdown):
  - # 一级标题:简洁有力的报告标题
  - 报告开头给出大纲(Markdown 编号列表)
  - 正文分章节(## 二级标题):执行摘要 → 各重点方向展开 → 结论与展望
  - 报告末尾列出参考来源(编号列表,含标题与链接)
  - 中文报告篇幅 1500 字以上,要点列表与叙述段落结合,引用收集的事实(关键数据注明来源)

规则:
- 只依据工具返回的真实信息撰写,绝不编造事实、数据或来源
- 搜索/抓取不可用时,在报告中明确说明信息局限
- 用中文撰写(除非用户用其他语言提问)`;

// ─── 类型 ───────────────────────────────────────────────────────

export interface ResearchInput {
  /** 研究主题 */
  topic: string;
}

/** SSE 进度事件(经 server 转译为 stage/delta/error) */
export interface ResearchProgress {
  type: 'start' | 'delta' | 'tool_start' | 'tool_end' | 'done' | 'error';
  /** delta 类型:正文 / 思考链 */
  kind?: 'text' | 'thinking';
  /** delta 增量文本 */
  delta?: string;
  /** tool_start / tool_end 时的工具名 */
  toolName?: string;
  /** error 时的错误信息 */
  message?: string;
}

export interface ResearchOutput {
  /** 报告全文(含计划与正文,Markdown) */
  text: string;
  thinking: string;
}

// ─── Runtime 工厂 ───────────────────────────────────────────────

/**
 * 构建研究 Runtime。每次研究任务新建(tools 中 save_important_fact
 * 闭包持有本次研究的 FactsStore),研究结束即丢弃——对齐源应用的一次性研究流程。
 */
export function createResearchRuntime(model: Model, streamFn: StreamFn, tools: Tool[]): Runtime {
  return createRuntime({
    model,
    streamFn,
    systemPrompt: RESEARCH_SYSTEM_PROMPT,
    tools,
    // 研究是多步工具循环(3-6 次搜索 + 若干深读 + 事实保存),给足轮次
    maxTurns: 30,
    config: { role: 'researcher' },
  });
}

// ─── 流式执行 ───────────────────────────────────────────────────

/**
 * 流式执行一次研究:ephemeral 请求(单次任务,无多轮会话),
 * 捕获 text / thinking / 工具调用阶段,细粒度推送给 SSE。
 */
export async function streamResearch(
  input: ResearchInput,
  runtime: Runtime,
  onProgress: (p: ResearchProgress) => void,
  signal?: AbortSignal,
): Promise<ResearchOutput> {
  onProgress({ type: 'start' });
  // ephemeral(无 sessionKey):研究是一次性任务,不保留会话历史
  const req = createRequest(`请深入研究以下主题并产出综合报告:${input.topic}`);

  const output: ResearchOutput = { text: '', thinking: '' };
  for await (const chunk of runtime.stream(req)) {
    if (signal?.aborted) throw new Error('aborted');
    if (chunk.type === 'text' && chunk.content) {
      output.text += chunk.content;
      onProgress({ type: 'delta', kind: 'text', delta: chunk.content });
    } else if (chunk.type === 'thinking' && chunk.content) {
      output.thinking += chunk.content;
      onProgress({ type: 'delta', kind: 'thinking', delta: chunk.content });
    } else if (chunk.type === 'tool_start' && chunk.toolName) {
      onProgress({ type: 'tool_start', toolName: chunk.toolName });
    } else if (chunk.type === 'tool_end' && chunk.toolName) {
      onProgress({ type: 'tool_end', toolName: chunk.toolName });
    } else if (chunk.type === 'error') {
      throw new Error(chunk.content || '研究执行出错');
    }
  }

  if (!output.text.trim() && !output.thinking.trim()) {
    throw new Error('模型未生成研究报告,请重试或更换模型');
  }
  onProgress({ type: 'done' });
  return output;
}
