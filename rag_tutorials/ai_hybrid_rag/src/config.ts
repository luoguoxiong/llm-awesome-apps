/**
 * rag_tutorials/ai_hybrid_rag/src/config.ts
 *
 * 环境变量解析 + aipack 模型/streamFn 装配。
 * 对齐 ai_data_analysis_agent/config.ts 的「getBuiltinModel → adaptAiModel → createStreamFnFromAi」模式。
 *
 * 本应用为混合检索 RAG（单模型同时承担相关性重排与回答），
 * 默认 deepseek/deepseek-chat（源应用用 Claude 3 Opus + Cohere 重排，
 * 可切换 anthropic/claude-3-5-sonnet-latest 等价体验；本地模型变体靠
 * OpenAI 兼容接入覆盖，与 PLAN 的合并策略一致）。
 */
import './loadEnv.js'; // 副作用：最先加载 .env（必须在读取 process.env 之前）
import {
  getBuiltinModel,
  getBuiltinModels,
  hasProviderConfigured,
  adaptAiModel,
  createStreamFnFromAi,
  BUILTIN_PROVIDERS,
} from '@aipack-ai/agent';
import type { Model, StreamFn } from '@aipack-ai/agent';

/** 各 provider 的默认模型 id（与 ai/catalog.ts 对齐） */
const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  deepseek: 'deepseek-chat',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-sonnet-latest',
  google: 'gemini-2.0-flash',
  groq: 'llama-3.3-70b-versatile',
  mistral: 'mistral-small-latest',
  xai: 'grok-3-mini',
  moonshot: 'moonshot-v1-128k',
};

/** 供前端模型选择下拉使用的模型条目（由内置目录映射而来） */
export interface ModelOption {
  provider: string;
  providerName: string;
  modelId: string;
  modelName: string;
  /** 该 provider 是否已配置 API Key（决定前端是否禁用） */
  available: boolean;
  /** 是否为推理模型 */
  reasoning: boolean;
  /** 缺 Key 时提示用户设置的环境变量名 */
  envVar: string;
}

export interface AppConfig {
  port: number;
  /** 默认问答模型 */
  provider: string;
  modelId: string;
  /** 默认模型 provider 是否已配置 Key（供 UI 展示状态） */
  llmReady: boolean;
  /** 内置模型目录（供前端渲染模型选择下拉） */
  models: ModelOption[];
  /** 混合检索候选数（融合后送入 LLM 重排的片段数） */
  candidateK: number;
  /** 最终注入上下文的片段数 */
  contextK: number;
  /** RRF 融合常数 */
  rrfK: number;
  /** 是否启用 LLM 相关性重排 */
  gradeEnabled: boolean;
  /** 索引持久化目录 */
  vectorDbDir: string;
  /** Firecrawl 抓取 Key（URL 摄取优先走 Firecrawl） */
  firecrawlKey?: string;
}

/** 读 env，返回标准化配置对象。 */
export function loadConfig(): AppConfig {
  const port = Number(process.env.PORT) || 3014;

  // ── 问答模型 ────────────────────────────────────────────────
  const provider = (process.env.LLM_PROVIDER || 'deepseek').toLowerCase();
  const knownProviders = new Set(BUILTIN_PROVIDERS.map((p) => p.id));
  if (!knownProviders.has(provider)) {
    console.warn(
      `⚠️  未知 provider "${provider}"，将尝试作为 OpenAI 兼容接入。内置: ${[...knownProviders].join(', ')}`,
    );
  }
  const modelId = process.env.LLM_MODEL || DEFAULT_MODEL_BY_PROVIDER[provider] || 'deepseek-chat';
  if (!getBuiltinModel(provider, modelId)) {
    throw new Error(
      `找不到内置模型 ${provider}/${modelId}。可通过 LLM_PROVIDER / LLM_MODEL 环境变量指定其他内置模型。`,
    );
  }

  const llmReady = hasProviderConfigured(provider);
  if (!llmReady) {
    console.warn(`⚠️  未检测到 ${provider.toUpperCase()}_API_KEY。`);
    console.warn('   可在 .env 设置，或由前端用户输入 Key。无 Key 时仍可启动服务，但 /api/chat 会返回错误提示。\n');
  }

  // ── 内置模型目录（供前端模型选择；available 取决于当前已配置的 API Key）──
  const models: ModelOption[] = getBuiltinModels().map((m) => {
    const meta = BUILTIN_PROVIDERS.find((p) => p.id === m.provider);
    return {
      provider: m.provider,
      providerName: meta?.name ?? m.provider,
      modelId: m.id,
      modelName: m.name,
      available: hasProviderConfigured(m.provider),
      reasoning: !!m.reasoning,
      envVar: meta?.envVar ?? `${m.provider.toUpperCase()}_API_KEY`,
    };
  });

  return {
    port,
    provider,
    modelId,
    llmReady,
    models,
    candidateK: clampInt(process.env.CANDIDATE_K, 10, 1, 50),
    contextK: clampInt(process.env.CONTEXT_K, 5, 1, 10),
    rrfK: clampInt(process.env.RRF_K, 60, 1, 1000),
    gradeEnabled: (process.env.GRADE_ENABLED || 'true').toLowerCase() !== 'false',
    vectorDbDir: process.env.VECTOR_DB_DIR || '.aipack/hybrid-rag-store',
    firecrawlKey: process.env.FIRECRAWL_API_KEY || undefined,
  };
}

/** 解析整数 env，非法时回退默认值，并夹到 [min, max] */
function clampInt(raw: string | undefined, def: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 按 (provider, modelId) 构建模型 + streamFn。供 server 在运行时按用户选择装配 Runtime。
 * 模型不存在时抛明确错误，由调用方转为 400。
 */
export function buildModel(provider: string, modelId: string, apiKey?: string): { model: Model; streamFn: StreamFn } {
  const aiModel = getBuiltinModel(provider, modelId);
  if (!aiModel) {
    throw new Error(`找不到内置模型 ${provider}/${modelId}`);
  }
  // 提供用户 key 时透传给底层流式实现；否则回退 env
  return { model: adaptAiModel(aiModel), streamFn: createStreamFnFromAi(aiModel, apiKey ? { apiKey } : {}) };
}

export interface ModelChoice {
  provider: string;
  modelId: string;
  /** `${provider}/${modelId}`，用于标识模型 */
  modelKey: string;
  /** 用户在前端输入的 API Key（未提供则用服务器 env） */
  apiKey?: string;
}

/**
 * 校验并解析前端选择的模型：缺省回退默认模型；模型不存在或 Key 未配置时返回 error（供 400）。
 * 不抛异常，由调用方决定如何响应。
 */
export function resolveModelChoice(
  picked: { provider?: unknown; modelId?: unknown; apiKey?: unknown } | undefined,
  fallback: { provider: string; modelId: string },
): { choice: ModelChoice; error: string | null } {
  const provider = String(picked?.provider || fallback.provider).toLowerCase();
  const modelId = String(picked?.modelId || fallback.modelId);
  const modelKey = `${provider}/${modelId}`;
  const apiKey = typeof picked?.apiKey === 'string' ? picked.apiKey.trim() || undefined : undefined;
  if (!getBuiltinModel(provider, modelId)) {
    return { choice: { provider, modelId, modelKey, apiKey }, error: `未知模型 ${modelKey}` };
  }
  if (!hasProviderConfigured(provider) && !apiKey) {
    const meta = BUILTIN_PROVIDERS.find((p) => p.id === provider);
    const envVar = meta?.envVar ?? `${provider.toUpperCase()}_API_KEY`;
    return { choice: { provider, modelId, modelKey, apiKey }, error: `未配置 ${envVar}，请在页面上方输入 API Key 或在 .env 设置` };
  }
  return { choice: { provider, modelId, modelKey, apiKey }, error: null };
}
