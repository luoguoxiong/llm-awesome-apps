/**
 * starter_ai_agents/ai_data_analysis_agent/src/runtime.ts
 *
 * 数据分析 Agent(基于 @aipack-ai/agent,多轮对话,内存会话):
 *   - 工具:get_data_summary(结构概览) / query_data(过滤/分组/聚合/排序)
 *   - 会话:createRequest 携带 sessionKey(非 ephemeral),按数据集维度隔离上下文
 *   - 可视化:系统提示词约定输出 ```echarts 代码块(合法 ECharts option JSON),
 *     前端提取渲染(等价源可视化应用的 E2B 沙箱 + matplotlib 方案,免外部 Key)
 *
 * 迁移自 awesome-llm-apps/starter_ai_agents/ai_data_analysis_agent
 * (源:Agno + gpt-4o + DuckDB SQL 问答)与 ai_data_visualisation_agent
 * (源:Together AI + E2B 沙箱 matplotlib 图表),两应用按 PLAN 合并为本应用。
 */
import {
  createRuntime,
  createRequest,
  type Model,
  type StreamFn,
  type Runtime,
} from '@aipack-ai/agent';
import { buildModel } from './config.js';
import { createSummaryTool, createQueryTool } from './tools/query.js';
import type { Dataset } from './dataset.js';
import { createHash } from 'node:crypto';

// ─── 系统提示词 ─────────────────────────────────────────────────

const ANALYST_SYSTEM_PROMPT = `你是一位专业的数据分析师(AI Data Analyst)。用户已上传数据集,通过工具查询并分析:

工作流程:
1. 首次接触数据或不确定列结构时,先调用 get_data_summary 查看结构概览
2. 按问题调用 query_data 做精确查询(过滤/分组聚合/排序/Top-N),不要凭空猜数字
3. 回答规范:
   - 数据结果用 Markdown 表格展示(列名 | 数值)
   - 文字解读用要点列表(bullet points),给出洞察而不只是重复数字
   - 对比类问题优先用表格并排展示
4. 可视化规范(用户明确要图表,或图表能明显增强表达时):
   - 在回答末尾输出一个 \`\`\`echarts 代码块,内容为合法的 ECharts option JSON
   - JSON 必须严格合法:键用双引号,禁止注释、尾逗号、单引号、JavaScript 表达式
   - 图表数据取自你的查询结果,直接写进 series.data;x 轴分类用 "xAxis":{"type":"category","data":[...]}
   - 常用类型:柱状图 bar(分类对比)、折线图 line(趋势)、饼图 pie(占比)、散点图 scatter(相关性)
   - 数值轴建议 "yAxis":{"type":"value"};饼图数据格式 [{"name":"...","value":123}]
   - 配色用 ECharts 默认即可,不要设置背景色
5. 数据中不存在的维度不要编造;缺失值(—)要说明
6. 用中文回答(除非用户用其他语言提问)

echarts 代码块示例(柱状图):
\`\`\`echarts
{"title":{"text":"各类别平均价格"},"xAxis":{"type":"category","data":["A类","B类","C类"]},"yAxis":{"type":"value"},"series":[{"type":"bar","data":[120,200,150]}]}
\`\`\``;

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

/** 构建数据分析 Runtime:多轮会话 + 数据查询两工具(闭包持有当前数据集) */
export function createAnalysisRuntime(model: Model, streamFn: StreamFn, dataset: Dataset): Runtime {
  return createRuntime({
    model,
    streamFn,
    systemPrompt: ANALYST_SYSTEM_PROMPT,
    tools: [createSummaryTool(dataset), createQueryTool(dataset)],
    maxTurns: 8,
    config: { role: 'data-analyst' },
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

// ─── Runtime 注册表:按 (provider, modelId, apiKey, datasetId) 缓存 ──

export interface RuntimeRegistry {
  /** 取(或首次构建并缓存)指定模型 + 数据集的 Runtime。模型不存在时抛错。 */
  get(provider: string, modelId: string, apiKey: string | undefined, dataset: Dataset): Runtime;
  /** 关闭所有缓存的 Runtime(优雅退出时调用) */
  closeAll(): Promise<void>;
}

/**
 * 创建 Runtime 注册表。按 (模型, 数据集) 维度缓存:
 *   - 同一数据集多轮追问复用同一 Runtime(会话上下文延续)
 *   - 切换数据集即新 Runtime(新会话,避免旧数据列名干扰)
 *   - 切换模型同理(注:会话历史保存在 Runtime 内存中)
 */
export function createRuntimeRegistry(): RuntimeRegistry {
  const cache = new Map<string, Runtime>();
  return {
    get(provider, modelId, apiKey, dataset) {
      const keyTag = apiKey ? `u:${createHash('sha256').update(apiKey).digest('hex').slice(0, 8)}` : 'env';
      const cacheKey = `${provider}/${modelId}:${keyTag}:${dataset.id}`;
      let runtime = cache.get(cacheKey);
      if (!runtime) {
        const { model, streamFn } = buildModel(provider, modelId, apiKey);
        runtime = createAnalysisRuntime(model, streamFn, dataset);
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
