/**
 * rag_tutorials/ai_rag_chain/src/runtime.ts
 *
 * RAG 生成 Runtime(基于 @aipack-ai/agent):
 *   - 检索在服务端本地完成(vectordb.ts),LLM 仅作为"基于上下文作答"的生成器,
 *     因此 Runtime 无工具、单轮(ephemeral 请求,不落会话)
 *   - 提示词对齐源应用 PharmaQuery 的 pharmaceutical-sciences 助手设定与严格接地规则
 *
 * 迁移自 awesome-llm-apps/rag_tutorials/rag_chain
 * (源应用:LangChain RAG Chain = retriever | prompt | ChatGoogleGenerativeAI | StrOutputParser;
 *  本实现以 TF-IDF 本地检索 + aipack 流式生成等价替代,指令沿用源应用"仅基于上下文回答"的约定)。
 */
import {
  createRuntime,
  createRequest,
  createMemorySessionStorage,
  type Model,
  type StreamFn,
  type Runtime,
} from '@aipack-ai/agent';
import { buildModel } from './config.js';
import { createHash } from 'node:crypto';

// ─── 系统提示词 ─────────────────────────────────────────────────

const RAG_SYSTEM_PROMPT = `你是一位知识渊博的检索问答助手,基于知识库中的文档片段回答用户问题。
回答规则(严格遵守):
- 仅基于提供的上下文片段回答,做到准确、简洁
- 不要为答案做额外辩解
- 不要给出上下文中未提及的信息,不得编造
- 不要在回答中出现"根据上下文""上下文提到"之类的表述,直接给出答案本身
- 若上下文不足以回答问题,明确说明"知识库中没有足够信息回答该问题",并简述缺少哪方面内容
- 用中文回答(除非用户用其他语言提问)`;

// ─── Runtime 工厂 ───────────────────────────────────────────────

/** 构建 RAG 生成 Runtime:无工具,单轮,ephemeral 请求 */
export function createRagRuntime(model: Model, streamFn: StreamFn): Runtime {
  return createRuntime({
    model,
    streamFn,
    systemPrompt: RAG_SYSTEM_PROMPT,
    tools: [],
    sessionStorage: createMemorySessionStorage(),
    maxTurns: 1,
    config: { role: 'rag-answerer' },
  });
}

// ─── 流式生成 ───────────────────────────────────────────────────

/** SSE 进度事件(经 server 转译为 stage/delta/sources/error) */
export type RagEvent =
  | { type: 'answer_start' }
  | { type: 'delta'; delta: string }
  | { type: 'done'; answer: string }
  | { type: 'error'; message: string };

/**
 * 基于检索片段流式生成回答:上下文 + 问题交给 Runtime,增量推送。
 * 对应源应用的 RAG Chain:invoke(query) → 流式输出。
 */
export async function streamAnswer(
  question: string,
  contextChunks: string[],
  runtime: Runtime,
  onEvent: (e: RagEvent) => void,
  signal?: AbortSignal,
): Promise<string> {
  const prompt = [
    `用户问题: ${question}`,
    '',
    '知识库检索到的上下文片段:',
    ...contextChunks.map((t, i) => `--- 片段 ${i + 1} ---\n${t}`),
    '',
    '请基于以上上下文回答用户问题。',
  ].join('\n');

  onEvent({ type: 'answer_start' });
  // ephemeral:单轮 RAG 请求,不维护会话历史(每问独立检索)
  const req = createRequest(prompt, { ephemeral: true });

  let answer = '';
  for await (const chunk of runtime.stream(req)) {
    if (signal?.aborted) throw new Error('aborted');
    if (chunk.type === 'text' && chunk.content) {
      answer += chunk.content;
      onEvent({ type: 'delta', delta: chunk.content });
    } else if (chunk.type === 'error') {
      throw new Error(chunk.content || '生成回答时出错');
    }
  }
  if (!answer.trim()) throw new Error('模型未返回任何内容,请重试或更换模型');
  onEvent({ type: 'done', answer });
  return answer;
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
 */
export function createRuntimeRegistry(): RuntimeRegistry {
  const cache = new Map<string, Runtime>();
  return {
    get(provider, modelId, apiKey) {
      // 用 key 的哈希区分缓存(不明文存 key);env key 用 'env'
      const keyTag = apiKey ? `u:${createHash('sha256').update(apiKey).digest('hex').slice(0, 8)}` : 'env';
      const cacheKey = `${provider}/${modelId}:${keyTag}`;
      let runtime = cache.get(cacheKey);
      if (!runtime) {
        const { model, streamFn } = buildModel(provider, modelId, apiKey);
        runtime = createRagRuntime(model, streamFn);
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
