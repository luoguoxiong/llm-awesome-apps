/**
 * rag_tutorials/ai_hybrid_rag/src/runtime.ts
 *
 * 两个无工具 Runtime（对齐 ai_rag_database_routing 的 Router/Answer 模式）：
 *   - Grader：检索结果相关性评估专家，逐片段输出 yes/no
 *     （等价源应用 hybrid_search_rag 的 Cohere Reranker 重排 +
 *     ai_blog_search 的 grade_documents 相关性门控，合并为本应用的单次 LLM 评估）
 *   - Answer：RAG / 通用知识双模式回答专家，基于给定上下文流式作答
 *
 * 按 (provider, modelId, apiKey) 构建并缓存，支持运行时切换模型。
 */
import {
  createRuntime,
  createMemorySessionStorage,
  type Model,
  type StreamFn,
  type Runtime,
} from '@aipack-ai/agent';
import { buildModel } from './config.js';
import { createHash } from 'node:crypto';

/** 相关性评估系统提示词（严格逐行输出 编号:yes/no） */
export const GRADER_SYSTEM_PROMPT = `你是一位检索结果相关性评估专家。用户会给出一个问题和若干编号的候选文档片段，你需要判断每个片段是否与问题相关（即：片段内容能否帮助回答该问题）。

判断标准：
- 片段包含与问题直接相关的关键词或语义信息 → yes
- 片段与问题主题无关、或信息不足以辅助回答 → no
- 拿不准时倾向于 no（宁缺毋滥，避免噪声进入上下文）

严格规则：
1. 每个片段输出一行，格式为「编号:yes」或「编号:no」（如 1:yes、2:no）
2. 不要输出任何其他文本、解释或标点
3. 必须覆盖全部候选片段`;

/** 回答专家系统提示词（RAG 优先 + 通用知识兜底，等价源应用的双提示词设计） */
export const ANSWER_SYSTEM_PROMPT = `你是一位友好且知识渊博的 AI 助手，提供完整而有洞察力的回答。

工作模式：
- 当消息中附带「参考片段」时：严格基于参考片段回答用户问题，把片段内容当作你的工作记忆，不要直接或间接提及"参考片段/上下文/检索"的存在；片段信息不足的部分如实说明
- 当消息注明未检索到相关文档时：基于你的通用知识回答，并在开头用一句话说明本次回答未参考知识库文档
- 回答直接、准确、结构清晰；涉及列举/对比时优先用 Markdown 表格或要点列表

语言：用中文回答（除非用户用其他语言提问）`;

/** 构建 Grader Runtime：严格评估，无工具，单轮 */
export function createGraderRuntime(model: Model, streamFn: StreamFn): Runtime {
  return createRuntime({
    model,
    streamFn,
    systemPrompt: GRADER_SYSTEM_PROMPT,
    tools: [],
    sessionStorage: createMemorySessionStorage(),
    maxTurns: 1,
    config: { role: 'grader' },
  });
}

/** 构建 Answer Runtime：纯生成，无工具，单轮（多轮历史由 pipeline 手动编排） */
export function createAnswerRuntime(model: Model, streamFn: StreamFn): Runtime {
  return createRuntime({
    model,
    streamFn,
    systemPrompt: ANSWER_SYSTEM_PROMPT,
    tools: [],
    sessionStorage: createMemorySessionStorage(),
    maxTurns: 1,
    config: { role: 'answer' },
  });
}

// ─── Runtime 注册表：按 (provider, modelId, apiKey) 缓存复用 ──────────

export interface RuntimePair {
  grader: Runtime;
  answer: Runtime;
}

export interface RuntimeRegistry {
  /** 取（或首次构建并缓存）指定模型的 grader/answer Runtime。apiKey 为用户提供的 key（不传则用 env）。模型不存在时抛错。 */
  get(provider: string, modelId: string, apiKey?: string): RuntimePair;
  /** 关闭所有缓存的 Runtime（优雅退出时调用） */
  closeAll(): Promise<void>;
}

/**
 * 创建 Runtime 注册表。模型在首次被选中时按需构建并缓存，
 * 避免每次请求重建，同时支持运行时切换模型。
 */
export function createRuntimeRegistry(): RuntimeRegistry {
  const cache = new Map<string, RuntimePair>();
  return {
    get(provider, modelId, apiKey) {
      // 用 key 的哈希区分缓存（不明文存 key）；env key 用 'env'
      const keyTag = apiKey ? `u:${createHash('sha256').update(apiKey).digest('hex').slice(0, 8)}` : 'env';
      const cacheKey = `${provider}/${modelId}:${keyTag}`;
      let pair = cache.get(cacheKey);
      if (!pair) {
        const { model, streamFn } = buildModel(provider, modelId, apiKey);
        pair = {
          grader: createGraderRuntime(model, streamFn),
          answer: createAnswerRuntime(model, streamFn),
        };
        cache.set(cacheKey, pair);
      }
      return pair;
    },
    async closeAll() {
      await Promise.allSettled(
        [...cache.values()].map((p) => Promise.all([p.grader.close(), p.answer.close()])),
      );
      cache.clear();
    },
  };
}
