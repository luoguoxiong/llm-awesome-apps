/**
 * starter_ai_agents/ai_startup_trends_agent/src/runtime.ts
 *
 * 创业趋势分析 Agent(基于 @aipack-ai/agent,单次分析任务):
 *   - 输入:感兴趣的创业领域/技术方向
 *   - 工具:search_web(四层降级搜索)/ fetch_url(网页正文抽取)
 *          / save_article_summary(文章摘要收集,实时推送前端)
 *   - 编排:以一个系统提示词驱动「新闻收集 → 摘要整理 → 趋势分析」的完整分析循环
 *     (等价源应用 News Collector / Summary Writer / Trend Analyzer 三 Agent 的接力,
 *     免多 Agent 框架依赖)
 *
 * 迁移自 awesome-llm-apps 的 starter_ai_agents/ai_startup_trend_analysis_agent
 * (Agno 三 Agent:DuckDuckGoTools 收集 → Newspaper4kTools 摘要 → 趋势分析输出)。
 */
import {
  createRuntime,
  createRequest,
  type Model,
  type StreamFn,
  type Runtime,
  type Tool,
} from '@aipack-ai/agent';

// ─── 系统提示词(三阶段分析循环)─────────────────────────────────

const STARTUP_TRENDS_SYSTEM_PROMPT = `你是一位资深的创业趋势分析师(AI Startup Trends Agent),负责对给定领域收集最新动态、整理文章摘要并分析趋势与创业机会。严格按以下三阶段工作:

阶段 1 — 新闻收集:
  - 围绕主题设计 3-5 个互补的搜索查询,覆盖:领域最新动态与新闻、创业公司融资事件、市场分析与行业报告
  - 逐个调用 search_web 执行查询,收集最新文章、融资轮次与市场数据
  - 用简短列表汇总有价值的搜索发现(标题 + 要点 + 链接)

阶段 2 — 摘要整理:
  - 从搜索结果中挑选 4-6 篇最有价值的文章,调用 fetch_url 深读全文
  - 每读完一篇立即调用 save_article_summary 保存摘要(title 填文章标题、source 填文章 URL、summary 用 2-4 句话概括核心内容:关键事实/数据/观点)
  - 深读失败或正文过少的文章直接跳过,不编造内容

阶段 3 — 趋势分析(最终输出,Markdown):
  - # 一级标题:简洁有力的分析标题
  - ## 市场概览:2-3 段执行摘要,说明该领域现状与热度
  - ## 新兴趋势:3-6 个趋势,每个含趋势现象、支撑证据(引用文章摘要中的数据与事实)、驱动因素
  - ## 潜在创业机会:2-4 个机会,每个含机会定位、目标用户、差异化切入点、主要风险
  - ## 风险与不确定性:整体性风险提示(市场/技术/竞争)
  - ## 参考来源:编号列表(文章标题 + 链接),与摘要收集的文章对应
  - 中文报告篇幅 1500 字以上,要点列表与叙述段落结合

规则:
- 只依据工具返回的真实信息分析,绝不编造事实、数据、融资事件或来源
- 搜索/抓取不可用时,在报告中明确说明信息局限
- 用中文撰写(除非用户用其他语言提问)`;

// ─── 类型 ───────────────────────────────────────────────────────

export interface TrendAnalysisInput {
  /** 感兴趣的创业领域/技术方向 */
  topic: string;
}

/** 分析流水线阶段(由工具调用启发式推断,推送前端进度条) */
export type AnalysisPhase = 'collect' | 'summarize' | 'analyze';

/** SSE 进度事件(经 server 转译为 stage/phase/delta/summary/error) */
export interface TrendProgress {
  type: 'start' | 'phase' | 'delta' | 'tool_start' | 'tool_end' | 'done' | 'error';
  /** phase 事件:当前阶段 */
  phase?: AnalysisPhase;
  /** delta 类型:正文 / 思考链 */
  kind?: 'text' | 'thinking';
  /** delta 增量文本 */
  delta?: string;
  /** tool_start / tool_end 时的工具名 */
  toolName?: string;
  /** error 时的错误信息 */
  message?: string;
}

export interface TrendAnalysisOutput {
  /** 报告全文(含各阶段输出,Markdown) */
  text: string;
  thinking: string;
}

// ─── Runtime 工厂 ───────────────────────────────────────────────

/**
 * 构建趋势分析 Runtime。每次分析新建(tools 中 save_article_summary
 * 闭包持有本次分析的 SummariesStore),分析结束即丢弃——对齐源应用的一次性分析流程。
 */
export function createTrendRuntime(model: Model, streamFn: StreamFn, tools: Tool[]): Runtime {
  return createRuntime({
    model,
    streamFn,
    systemPrompt: STARTUP_TRENDS_SYSTEM_PROMPT,
    tools,
    // 分析是多步工具循环(3-5 次搜索 + 4-6 次深读 + 摘要保存),给足轮次
    maxTurns: 24,
    config: { role: 'analyst' },
  });
}

// ─── 流式执行 ───────────────────────────────────────────────────

/**
 * 流式执行一次创业趋势分析:ephemeral 请求(单次任务,无多轮会话),
 * 捕获 text / thinking / 工具调用阶段,细粒度推送给 SSE。
 *
 * 阶段推断(启发式):
 *   collect   → 初始(只见到 search_web)
 *   summarize → 首次 fetch_url / save_article_summary 调用
 *   analyze   → 已保存过摘要、无工具运行时的正文增量(最终报告开始流式输出)
 */
export async function streamTrendAnalysis(
  input: TrendAnalysisInput,
  runtime: Runtime,
  summaryCount: () => number,
  onProgress: (p: TrendProgress) => void,
  signal?: AbortSignal,
): Promise<TrendAnalysisOutput> {
  onProgress({ type: 'start', phase: 'collect' });
  // ephemeral(无 sessionKey):分析是一次性任务,不保留会话历史
  const req = createRequest(`请分析以下创业领域的最新趋势与潜在创业机会:${input.topic}`);

  const output: TrendAnalysisOutput = { text: '', thinking: '' };
  let phase: AnalysisPhase = 'collect';
  let activeTools = 0;

  for await (const chunk of runtime.stream(req)) {
    if (signal?.aborted) throw new Error('aborted');
    if (chunk.type === 'text' && chunk.content) {
      // 已有摘要且无工具在运行 → 最终报告开始(阶段 3)
      if (phase === 'summarize' && activeTools === 0 && summaryCount() > 0) {
        phase = 'analyze';
        onProgress({ type: 'phase', phase });
      }
      output.text += chunk.content;
      onProgress({ type: 'delta', kind: 'text', delta: chunk.content });
    } else if (chunk.type === 'thinking' && chunk.content) {
      output.thinking += chunk.content;
      onProgress({ type: 'delta', kind: 'thinking', delta: chunk.content });
    } else if (chunk.type === 'tool_start' && chunk.toolName) {
      activeTools++;
      // 首次深读/保存摘要 → 进入摘要整理阶段
      if (phase === 'collect' && (chunk.toolName === 'fetch_url' || chunk.toolName === 'save_article_summary')) {
        phase = 'summarize';
        onProgress({ type: 'phase', phase });
      }
      onProgress({ type: 'tool_start', toolName: chunk.toolName });
    } else if (chunk.type === 'tool_end' && chunk.toolName) {
      activeTools = Math.max(0, activeTools - 1);
      onProgress({ type: 'tool_end', toolName: chunk.toolName });
    } else if (chunk.type === 'error') {
      throw new Error(chunk.content || '分析执行出错');
    }
  }

  if (!output.text.trim() && !output.thinking.trim()) {
    throw new Error('模型未生成趋势分析报告,请重试或更换模型');
  }
  onProgress({ type: 'done' });
  return output;
}
