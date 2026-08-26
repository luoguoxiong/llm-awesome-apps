/**
 * starter_ai_agents/ai_mixture_of_agents/src/mixture.ts
 *
 * 混合专家(Mixture-of-Agents)编排核心:
 *   阶段 1(并行):N 个参考模型各自独立回答同一问题(逐路流式推送前端)
 *   阶段 2(聚合):聚合模型批判性综合所有回答,产出单一高质量回答(流式)
 *
 * 迁移自 awesome-llm-apps/starter_ai_agents/mixture_of_agents
 * (源应用:Together AI + asyncio.gather 并行 4 模型 + Mixtral 聚合流式)。
 * 改进:参考模型失败不中断整体(报告该路错误,聚合成功的回答);
 *       聚合提示词附原始问题(源应用会丢失问题上下文)。
 */
import { createRuntime, createRequest, type Runtime } from '@aipack-ai/agent';
import { buildModel, type ModelSpec } from './config.js';

// ─── 提示词 ─────────────────────────────────────────────────────

/**
 * 聚合模型系统提示词(对齐源应用 aggregator_system_prompt):
 * 批判性评估各模型回答(可能有偏颇或错误),综合产出更优的单一回答。
 */
const AGGREGATOR_SYSTEM_PROMPT = `你将收到多个模型对同一问题的回答。你的任务是把它们综合成一个高质量的最终回答:
- 批判性地评估这些回答,注意其中可能存在偏见、错误或互相矛盾之处
- 不要简单复述或拼接给定回答,而应提炼出更准确、更全面的回复
- 多数模型一致的内容可信度更高;孤证内容需谨慎采纳
- 回答应结构良好、逻辑连贯,符合最高的准确性与可靠性标准
- 用中文回答(除非问题本身是其他语言)`;

/** 参考模型使用的轻量提示词(对齐源应用"直接回答"的角色) */
const REFERENCE_SYSTEM_PROMPT = `你是一位知识渊博的助手,请认真、准确地回答用户问题。观点清晰、论证充分,用中文回答(除非问题本身是其他语言)。`;

// ─── 类型 ───────────────────────────────────────────────────────

export interface MixtureCallbacks {
  /** 某参考模型开始生成 */
  onRefStart?: (modelKey: string) => void;
  /** 某参考模型流式增量 */
  onRefDelta?: (modelKey: string, delta: string) => void;
  /** 某参考模型结束(ok 为 null;失败时为错误信息) */
  onRefEnd?: (modelKey: string, error: string | null) => void;
  /** 聚合阶段开始(failedRefs: 失败的模型及原因,供提示聚合模型注意信息缺失) */
  onAggregateStart?: (failedRefs: Array<{ modelKey: string; error: string }>) => void;
  /** 聚合回答流式增量 */
  onDelta?: (kind: 'text' | 'thinking', delta: string) => void;
}

export interface MixtureOutput {
  /** 聚合后的最终回答 */
  aggregated: string;
  /** 各参考模型的回答(modelKey → 文本;失败的不在内) */
  references: Record<string, string>;
}

// ─── 单模型流式执行 ─────────────────────────────────────────────

/**
 * 用指定模型单轮流式生成回答(ephemeral 请求,无会话)。
 * 每次调用构建独立 Runtime,用完即关(支持同请求多模型并行,互不干扰)。
 */
async function runSingleModel(
  spec: ModelSpec,
  systemPrompt: string,
  prompt: string,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const { model, streamFn } = buildModel(spec.provider, spec.modelId, spec.apiKey);
  const runtime: Runtime = createRuntime({
    model,
    streamFn,
    systemPrompt,
    tools: [],
    maxTurns: 2,
    config: { role: 'mixture-model' },
  });

  try {
    const req = createRequest(prompt); // ephemeral:单次生成,无会话历史
    let text = '';
    for await (const chunk of runtime.stream(req)) {
      if (signal?.aborted) throw new Error('aborted');
      if (chunk.type === 'text' && chunk.content) {
        text += chunk.content;
        onDelta(chunk.content);
      } else if (chunk.type === 'error') {
        throw new Error(chunk.content || '模型生成失败');
      }
    }
    return text;
  } finally {
    await runtime.close().catch(() => {
      // 关闭失败不影响结果
    });
  }
}

// ─── 混合专家编排 ───────────────────────────────────────────────

/**
 * 执行完整的 MoA 流程:
 *   1. 所有参考模型并行生成(每路流式推送),失败的路记录错误并继续
 *   2. 全部结束后,聚合模型综合成功回答(附原始问题)流式输出
 * 若所有参考模型均失败,抛出聚合错误。
 */
export async function runMixture(
  prompt: string,
  references: ModelSpec[],
  aggregator: ModelSpec,
  cb: MixtureCallbacks,
  signal?: AbortSignal,
): Promise<MixtureOutput> {
  // ── 阶段 1:参考模型并行 ─────────────────────────────────────
  const settled = await Promise.allSettled(
    references.map(async (spec) => {
      cb.onRefStart?.(spec.modelKey);
      try {
        const text = await runSingleModel(
          spec,
          REFERENCE_SYSTEM_PROMPT,
          prompt,
          (delta) => cb.onRefDelta?.(spec.modelKey, delta),
          signal,
        );
        if (!text.trim()) throw new Error('模型未生成内容');
        cb.onRefEnd?.(spec.modelKey, null);
        return { modelKey: spec.modelKey, text };
      } catch (err) {
        const msg = (err as Error).message === 'aborted' ? '已中止' : (err as Error).message;
        cb.onRefEnd?.(spec.modelKey, msg);
        throw err; // 交给 allSettled 记录
      }
    }),
  );

  if (signal?.aborted) throw new Error('aborted');

  const okResults = settled
    .filter((s): s is PromiseFulfilledResult<{ modelKey: string; text: string }> => s.status === 'fulfilled')
    .map((s) => s.value);
  // allSettled 保序:按下标回查对应的 modelKey
  const failedRefs = settled
    .map((s, i): { modelKey: string; error: string } | null =>
      s.status === 'rejected'
        ? { modelKey: references[i]?.modelKey ?? '未知模型', error: (s.reason as Error)?.message || '生成失败' }
        : null,
    )
    .filter((f): f is { modelKey: string; error: string } => f !== null);

  if (okResults.length === 0) {
    const detail = failedRefs.map((f) => `${f.modelKey}:${f.error}`).join('; ');
    throw new Error(`所有参考模型均失败(${detail})。请检查各 provider 的 API Key 是否有效。`);
  }

  // ── 阶段 2:聚合 ─────────────────────────────────────────────
  cb.onAggregateStart?.(failedRefs);

  const sections = okResults.map((r) => `【模型 ${r.modelKey} 的回答】\n${r.text}`).join('\n\n');
  const failedNote =
    failedRefs.length > 0
      ? `\n\n(注:以下参考模型失败,其回答缺失:${failedRefs.map((f) => f.modelKey).join('、')})`
      : '';
  const aggregatePrompt =
    `用户的问题:\n${prompt}\n\n各参考模型对该问题的回答如下,请综合它们给出最终回答:\n\n${sections}${failedNote}`;

  const aggregated = await runSingleModel(
    aggregator,
    AGGREGATOR_SYSTEM_PROMPT,
    aggregatePrompt,
    (delta) => cb.onDelta?.('text', delta),
    signal,
  );

  if (!aggregated.trim()) {
    throw new Error('聚合模型未生成内容,请重试或更换聚合模型');
  }

  return {
    aggregated,
    references: Object.fromEntries(okResults.map((r) => [r.modelKey, r.text])),
  };
}
