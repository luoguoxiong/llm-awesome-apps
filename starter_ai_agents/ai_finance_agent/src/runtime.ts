/**
 * starter_ai_agents/ai_finance_agent/src/runtime.ts
 *
 * 金融分析 Agent(基于 @aipack-ai/agent,多轮对话,内存会话):
 *   - 输入:用户消息(自然语言金融问题)
 *   - 工具:get_stock_quote(实时报价) / get_stock_history(历史统计) / search_web(财经资讯)
 *   - 会话:createRequest 携带 sessionKey(非 ephemeral),aipack Runtime 按其维护对话历史,
 *     前端"新对话"按钮切换 sessionId 即开启全新会话
 *
 * 迁移自 awesome-llm-apps/starter_ai_agents/xai_finance_agent
 * (源应用:xAI Grok + YFinanceTools + DuckDuckGoTools + AgentOS playground;
 *  本实现以 aipack 工具调用循环 + Yahoo/腾讯/Stooq 免 Key 降级行情 + 四层降级搜索等价替代,
 *  指令沿用源应用"金融数据用表格、文字用要点"的约定)。
 */
import {
  createRuntime,
  createRequest,
  type Model,
  type StreamFn,
  type Runtime,
} from '@aipack-ai/agent';
import { buildModel } from './config.js';
import { createQuoteTool, createHistoryTool } from './tools/market.js';
import { createSearchTool } from './tools/search.js';
import { createHash } from 'node:crypto';

// ─── 系统提示词 ─────────────────────────────────────────────────

const FINANCE_SYSTEM_PROMPT = `你是一位专业的金融分析助手(AI Finance Agent)。工作方式:
- 涉及具体标的的价格/涨跌/成交量等实时数据时,调用 get_stock_quote 查询
- 涉及近期表现/走势/波动等历史数据时,调用 get_stock_history 查询
- 涉及最新新闻、财报解读、分析师观点、宏观政策等资讯时,调用 search_web 搜索
- 数据展示格式(严格遵守):
  * 金融/数值数据始终用 Markdown 表格展示(指标 | 数值 两列或多列对比)
  * 文字性内容用要点列表(bullet points)和短段落,简洁直接
- 分析时结合工具返回的数据与搜索到的资讯,给出有条理的解读;对比多个标的时用表格并排展示
- 明确标注数据来源与时效(如"数据来自 Yahoo Finance,截至最近交易日")
- 回答末尾附一句风险提示:"以上信息仅供参考,不构成投资建议。"
- 用中文回答(除非用户用其他语言提问)`;

// ─── 类型 ───────────────────────────────────────────────────────

export interface ChatInput {
  /** 用户消息 */
  message: string;
  /** 会话 ID(前端生成并持有;同一 ID 维持多轮对话上下文) */
  sessionId: string;
}

/** SSE 进度事件(经 server 转译为 stage/delta/error) */
export interface ChatProgress {
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

export interface ChatOutput {
  text: string;
  thinking: string;
}

// ─── Runtime 工厂 ───────────────────────────────────────────────

/** 构建金融分析 Runtime:多轮会话 + 行情/搜索三工具 */
export function createFinanceRuntime(model: Model, streamFn: StreamFn, serpapiKey?: string): Runtime {
  return createRuntime({
    model,
    streamFn,
    systemPrompt: FINANCE_SYSTEM_PROMPT,
    tools: [createQuoteTool(), createHistoryTool(), createSearchTool(serpapiKey)],
    maxTurns: 8,
    config: { role: 'finance-analyst' },
  });
}

// ─── 流式执行 ───────────────────────────────────────────────────

/**
 * 流式执行一轮对话:sessionKey 维持多轮上下文(aipack 内存会话),
 * 捕获 text / thinking / 工具调用阶段,细粒度推送给 SSE。
 */
export async function streamChat(
  input: ChatInput,
  runtime: Runtime,
  onProgress: (p: ChatProgress) => void,
  signal?: AbortSignal,
): Promise<ChatOutput> {
  onProgress({ type: 'start' });
  // sessionKey 而非 ephemeral:Runtime 按 sessionKey 维护对话历史,支持多轮
  const req = createRequest(input.message, { sessionKey: input.sessionId });

  const output: ChatOutput = { text: '', thinking: '' };
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
      throw new Error(chunk.content || '对话执行出错');
    }
  }

  if (!output.text.trim() && !output.thinking.trim()) {
    throw new Error('模型未生成内容,请重试或更换模型');
  }
  onProgress({ type: 'done' });
  return output;
}

// ─── Runtime 注册表:按 (provider, modelId, apiKey) 缓存 ──────────

export interface RuntimeRegistry {
  /** 取(或首次构建并缓存)指定模型的 Runtime。模型不存在时抛错。 */
  get(provider: string, modelId: string, apiKey?: string): Runtime;
  /** 关闭所有缓存的 Runtime(优雅退出时调用) */
  closeAll(): Promise<void>;
}

/**
 * 创建 Runtime 注册表。模型在首次被选中时按需构建并缓存,
 * 避免每次请求重建,同时支持运行时切换模型。
 * 注:会话历史保存在 Runtime 内存中,切换模型(不同 Runtime)后原会话上下文不延续。
 */
export function createRuntimeRegistry(serpapiKey?: string): RuntimeRegistry {
  const cache = new Map<string, Runtime>();
  return {
    get(provider, modelId, apiKey) {
      const keyTag = apiKey ? `u:${createHash('sha256').update(apiKey).digest('hex').slice(0, 8)}` : 'env';
      const cacheKey = `${provider}/${modelId}:${keyTag}`;
      let runtime = cache.get(cacheKey);
      if (!runtime) {
        const { model, streamFn } = buildModel(provider, modelId, apiKey);
        runtime = createFinanceRuntime(model, streamFn, serpapiKey);
        cache.set(cacheKey, runtime);
      }
      return runtime;
    },
    async closeAll() {
      await Promise.allSettled([...cache.values()].map((r) => r.close()));
      cache.clear();
    },
  };
}
