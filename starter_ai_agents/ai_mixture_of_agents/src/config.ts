/**
 * starter_ai_agents/ai_mixture_of_agents/src/config.ts
 *
 * 环境变量解析 + aipack 模型/streamFn 装配。
 * 对齐系列应用的「getBuiltinModel → adaptAiModel → createStreamFnFromAi」模式。
 *
 * 本应用为混合专家(Mixture-of-Agents):N 个参考模型并行 + 1 个聚合模型,
 * 参考模型由前端多选(模型无关),聚合模型默认 LLM_PROVIDER/LLM_MODEL。
 * 源应用用 Together AI(Qwen2-72B / Qwen1.5-72B / Mixtral-8x22B / dbrx + Mixtral 聚合),
 * 本实现以全内置模型目录等价替代(可跨 provider 组合)。
 */
import './loadEnv.js'; // 副作用:最先加载 .env(必须在读取 process.env 之前)
import {
  getBuiltinModel,
  getBuiltinModels,
  hasProviderConfigured,
  adaptAiModel,
  createStreamFnFromAi,
  BUILTIN_PROVIDERS,
} from '@aipack-ai/agent';
import type { Model, StreamFn } from '@aipack-ai/agent';

/** 各 provider 的默认模型 id(与 ai/catalog.ts 对齐) */
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

/**
 * 前端默认勾选的参考模型(对齐源应用"4 个开源大模型"的组合思路,
 * 跨 4 个 provider,保证多样性;实际可用性取决于各 provider 的 Key)。
 */
const DEFAULT_REFERENCE_MODELS: Array<{ provider: string; modelId: string }> = [
  { provider: 'deepseek', modelId: 'deepseek-chat' },
  { provider: 'openai', modelId: 'gpt-4o-mini' },
  { provider: 'google', modelId: 'gemini-2.0-flash' },
  { provider: 'groq', modelId: 'llama-3.3-70b-versatile' },
];

/** 供前端模型选择使用的模型条目(由内置目录映射而来) */
export interface ModelOption {
  provider: string;
  providerName: string;
  modelId: string;
  modelName: string;
  /** 该 provider 是否已配置 API Key(决定前端是否禁用) */
  available: boolean;
  /** 是否为推理模型 */
  reasoning: boolean;
  /** 缺 Key 时提示用户设置的环境变量名 */
  envVar: string;
}

export interface AppConfig {
  port: number;
  /** 默认聚合模型 */
  provider: string;
  modelId: string;
  /** 默认聚合模型 provider 是否已配置 Key(供 UI 展示状态) */
  llmReady: boolean;
  /** 内置模型目录(供前端渲染参考模型多选 + 聚合模型下拉) */
  models: ModelOption[];
  /** 前端默认勾选的参考模型 */
  defaultReferences: Array<{ provider: string; modelId: string }>;
}

/** 读 env,返回标准化配置对象。 */
export function loadConfig(): AppConfig {
  const port = Number(process.env.PORT) || 3008;

  // ── 聚合模型 ────────────────────────────────────────────────
  const provider = (process.env.LLM_PROVIDER || 'deepseek').toLowerCase();
  const knownProviders = new Set(BUILTIN_PROVIDERS.map((p) => p.id));
  if (!knownProviders.has(provider)) {
    console.warn(
      `⚠️  未知 provider "${provider}",将尝试作为 OpenAI 兼容接入。内置: ${[...knownProviders].join(', ')}`,
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
    console.warn(`⚠️  未检测到 ${provider.toUpperCase()}_API_KEY(聚合模型默认 provider)。`);
    console.warn('   可在 .env 设置,或由前端用户输入 Key。无 Key 时仍可启动服务,但 /api/mixture 会返回错误提示。\n');
  }

  // ── 内置模型目录(available 取决于当前已配置的 API Key)─────────
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

  return { port, provider, modelId, llmReady, models, defaultReferences: DEFAULT_REFERENCE_MODELS };
}

/**
 * 按 (provider, modelId) 构建模型 + streamFn。供 mixture 在运行时按选择装配 Runtime。
 * 模型不存在时抛明确错误,由调用方转为 400。
 */
export function buildModel(provider: string, modelId: string, apiKey?: string): { model: Model; streamFn: StreamFn } {
  const aiModel = getBuiltinModel(provider, modelId);
  if (!aiModel) {
    throw new Error(`找不到内置模型 ${provider}/${modelId}`);
  }
  // 提供用户 key 时透传给底层流式实现;否则回退 env
  return { model: adaptAiModel(aiModel), streamFn: createStreamFnFromAi(aiModel, apiKey ? { apiKey } : {}) };
}

/** 前端提交的单个模型选择 */
export interface ModelSpec {
  provider: string;
  modelId: string;
  /** `${provider}/${modelId}` */
  modelKey: string;
  /** 用户在前端输入的 API Key(未提供则用服务器 env) */
  apiKey?: string;
}

/**
 * 校验并解析单个模型选择:模型不存在或 Key 未配置时返回 error(供 400)。
 * 不抛异常,由调用方决定如何响应。
 */
export function resolveModelSpec(
  picked: { provider?: unknown; modelId?: unknown; apiKey?: unknown } | undefined,
): { spec: ModelSpec; error: string | null } {
  const provider = String(picked?.provider || '').toLowerCase();
  const modelId = String(picked?.modelId || '');
  const modelKey = `${provider}/${modelId}`;
  const apiKey = typeof picked?.apiKey === 'string' ? picked.apiKey.trim() || undefined : undefined;
  if (!provider || !modelId) {
    return { spec: { provider, modelId, modelKey, apiKey }, error: '缺少 provider/modelId' };
  }
  if (!getBuiltinModel(provider, modelId)) {
    return { spec: { provider, modelId, modelKey, apiKey }, error: `未知模型 ${modelKey}` };
  }
  if (!hasProviderConfigured(provider) && !apiKey) {
    const meta = BUILTIN_PROVIDERS.find((p) => p.id === provider);
    const envVar = meta?.envVar ?? `${provider.toUpperCase()}_API_KEY`;
    return { spec: { provider, modelId, modelKey, apiKey }, error: `未配置 ${envVar}(模型 ${modelKey}),请在页面输入该 provider 的 API Key 或在 .env 设置` };
  }
  return { spec: { provider, modelId, modelKey, apiKey }, error: null };
}
