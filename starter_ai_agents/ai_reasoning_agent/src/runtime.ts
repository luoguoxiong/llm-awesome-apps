/**
 * starter_ai_agents/ai_reasoning_agent/src/runtime.ts
 *
 * 双 Agent 对比设计(基于 @aipack-ai/agent,单轮无会话):
 *   - Regular Agent(普通模型):直接回答,体现"快思考"
 *   - Reasoning Agent(推理模型):原生思考链(thinking)+ 最终答案,体现"慢思考"
 *
 * 两个 Agent 并行流式执行,SSE 按 agent 字段区分事件归属;
 * 推理模型的 thinking chunk(aipack StreamChunk type='thinking')单独推送前端展示思考链。
 *
 * 迁移自 awesome-llm-apps/starter_ai_agents/ai_reasoning_agent(Regular vs Reasoning 对比)。
 */
import {
  createRuntime,
  createRequest,
  type Model,
  type StreamFn,
  type Runtime,
} from '@aipack-ai/agent';
import { buildModel } from './config.js';
import { createHash } from 'node:crypto';

// ─── 系统提示词 ─────────────────────────────────────────────────

const REGULAR_SYSTEM_PROMPT = `你是一位乐于助人的 AI 助手。请直接、清晰地回答用户问题:
- 保持简洁,先给结论,再给必要的解释
- 用 Markdown 组织答案,关键结论加粗
- 用中文回答(除非用户用其他语言提问)`;

const REASONING_SYSTEM_PROMPT = `你是一位严谨的推理专家,擅长解决计数、数学、逻辑与多步推理问题:
- 对问题进行深入、逐步的思考与自我验证(不放过边界情况)
- 推理过程会以独立的思考链呈现,最终答案请清晰、明确地标注
- 计数/字符类问题务必逐个列举核对,不要凭直觉
- 最终答案用 Markdown 输出,结论加粗,用中文回答(除非用户用其他语言提问)`;

// ─── 类型 ───────────────────────────────────────────────────────

export type AgentSide = 'regular' | 'reasoning';

export interface CompareInput {
  question: string;
}

/** SSE 进度事件(经 server 转译为 stage/delta/done/error) */
export interface CompareProgress {
  type: 'start' | 'delta' | 'done' | 'error';
  /** 事件归属的 agent */
  agent?: AgentSide;
  /** delta 类型:正文 / 思考链 */
  kind?: 'text' | 'thinking';
  /** delta 增量文本 */
  delta?: string;
  /** error 时的错误信息 */
  message?: string;
}

export interface AgentOutput {
  text: string;
  thinking: string;
}

// ─── Runtime 工厂 ───────────────────────────────────────────────

/** 构建普通模型 Runtime:单轮,无工具,无会话存储 */
export function createRegularRuntime(model: Model, streamFn: StreamFn): Runtime {
  return createRuntime({
    model,
    streamFn,
    systemPrompt: REGULAR_SYSTEM_PROMPT,
    tools: [],
    maxTurns: 4,
    config: { role: 'regular' },
  });
}

/** 构建推理模型 Runtime:单轮,无工具,无会话存储 */
export function createReasoningRuntime(model: Model, streamFn: StreamFn): Runtime {
  return createRuntime({
    model,
    streamFn,
    systemPrompt: REASONING_SYSTEM_PROMPT,
    tools: [],
    maxTurns: 4,
    config: { role: 'reasoning' },
  });
}

// ─── 流式执行 ───────────────────────────────────────────────────

/**
 * 流式执行单个 agent:捕获 text 与 thinking 两类 delta,细粒度推送给 SSE。
 */
async function streamAgent(
  side: AgentSide,
  runtime: Runtime,
  question: string,
  onProgress: (p: CompareProgress) => void,
  signal?: AbortSignal,
): Promise<AgentOutput> {
  onProgress({ type: 'start', agent: side });
  const req = createRequest(question);

  const output: AgentOutput = { text: '', thinking: '' };
  for await (const chunk of runtime.stream(req)) {
    if (signal?.aborted) throw new Error('aborted');
    if (chunk.type === 'text' && chunk.content) {
      output.text += chunk.content;
      onProgress({ type: 'delta', agent: side, kind: 'text', delta: chunk.content });
    } else if (chunk.type === 'thinking' && chunk.content) {
      output.thinking += chunk.content;
      onProgress({ type: 'delta', agent: side, kind: 'thinking', delta: chunk.content });
    } else if (chunk.type === 'error') {
      throw new Error(chunk.content || `${side} 执行出错`);
    }
  }

  if (!output.text.trim() && !output.thinking.trim()) {
    throw new Error(`${side === 'regular' ? '普通模型' : '推理模型'}未生成内容`);
  }
  onProgress({ type: 'done', agent: side });
  return output;
}

/**
 * 并行执行普通/推理双 Agent 对比,流式推送进度。
 * 任一 agent 失败不中断另一个(allSettled),最终由调用方汇总错误。
 */
export async function runComparison(
  input: CompareInput,
  runtimes: { regular: Runtime; reasoning: Runtime },
  onProgress: (p: CompareProgress) => void,
  signal?: AbortSignal,
): Promise<{ regular: AgentOutput; reasoning: AgentOutput; errors: string[] }> {
  const question = input.question.trim();

  const settle = await Promise.allSettled([
    streamAgent('regular', runtimes.regular, question, onProgress, signal),
    streamAgent('reasoning', runtimes.reasoning, question, onProgress, signal),
  ]);

  const errors: string[] = [];
  const empty: AgentOutput = { text: '', thinking: '' };
  let regular = empty;
  let reasoning = empty;

  const label: Record<AgentSide, string> = { regular: '普通模型', reasoning: '推理模型' };
  (['regular', 'reasoning'] as AgentSide[]).forEach((side, i) => {
    const r = settle[i];
    if (r.status === 'fulfilled') {
      if (side === 'regular') regular = r.value;
      else reasoning = r.value;
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      if (msg === 'aborted') throw new Error('aborted');
      errors.push(`${label[side]}出错: ${msg}`);
    }
  });

  if (errors.length > 0) {
    onProgress({ type: 'error', message: errors.join('\n') });
  }
  onProgress({ type: 'done' });
  return { regular, reasoning, errors };
}

// ─── Runtime 注册表:按 (side, provider, modelId, apiKey) 缓存 ────

export interface RuntimeRegistry {
  /** 取(或首次构建并缓存)指定侧、指定模型的 Runtime。模型不存在时抛错。 */
  get(side: AgentSide, provider: string, modelId: string, apiKey?: string): Runtime;
  /** 关闭所有缓存的 Runtime(优雅退出时调用) */
  closeAll(): Promise<void>;
}

/**
 * 创建 Runtime 注册表。模型在首次被选中时按需构建并缓存,
 * 避免每次请求重建,同时支持运行时切换模型。
 */
export function createRuntimeRegistry(): RuntimeRegistry {
  const cache = new Map<string, Runtime>();
  return {
    get(side, provider, modelId, apiKey) {
      const keyTag = apiKey ? `u:${createHash('sha256').update(apiKey).digest('hex').slice(0, 8)}` : 'env';
      const cacheKey = `${side}:${provider}/${modelId}:${keyTag}`;
      let runtime = cache.get(cacheKey);
      if (!runtime) {
        const { model, streamFn } = buildModel(provider, modelId, apiKey);
        runtime = side === 'regular' ? createRegularRuntime(model, streamFn) : createReasoningRuntime(model, streamFn);
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
