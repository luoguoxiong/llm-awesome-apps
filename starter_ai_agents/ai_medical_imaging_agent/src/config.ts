/**
 * starter_ai_agents/ai_medical_imaging_agent/src/config.ts
 *
 * 环境变量解析 + aipack 模型/streamFn 装配。
 * 对齐 ai_multimodal_agent/config.ts 的「getBuiltinModel → adaptAiModel → createStreamFnFromAi」模式。
 *
 * 本应用为多模态（视觉）应用：
 *   - 模型目录只暴露 input 含 'image' 的模型（aipack Model.input 标记）
 *   - 默认 google/gemini-2.5-pro（对齐源应用的 Gemini 2.5 Pro）
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

/** 各 provider 的默认多模态模型 id（与 aipack catalog 的 input:['text','image'] 对齐） */
const DEFAULT_VISION_MODEL_BY_PROVIDER: Record<string, string> = {
  google: 'gemini-2.5-pro',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-sonnet-20241022',
  xai: 'grok-3-mini',
  openrouter: 'auto',
};

/** 供前端模型选择下拉使用的模型条目（由内置目录映射而来，仅多模态模型） */
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
  /** 默认医学影像分析模型 */
  provider: string;
  modelId: string;
  /** 默认模型 provider 是否已配置 Key（供 UI 展示状态） */
  llmReady: boolean;
  /** 内置多模态模型目录（供前端渲染模型选择下拉） */
  models: ModelOption[];
  /** web 搜索后端描述（如 'serpapi' / 'bing+duckduckgo+fallback'） */
  searchBackend: string;
  /** SerpAPI Key（供 search 工具） */
  serpapiKey?: string;
}

/** 读 env，返回标准化配置对象。 */
export function loadConfig(): AppConfig {
  const port = Number(process.env.PORT) || 3012;

  // ── 医学影像分析模型 ────────────────────────────────────────
  const provider = (process.env.LLM_PROVIDER || 'google').toLowerCase();
  const knownProviders = new Set(BUILTIN_PROVIDERS.map((p) => p.id));
  if (!knownProviders.has(provider)) {
    console.warn(
      `⚠️  未知 provider "${provider}"，将尝试作为 OpenAI 兼容接入。内置: ${[...knownProviders].join(', ')}`,
    );
  }
  let modelId = process.env.LLM_MODEL || DEFAULT_VISION_MODEL_BY_PROVIDER[provider] || '';
  if (!modelId) {
    // 该 provider 无预置多模态默认时，回退到目录中第一个 input 含 image 的模型
    const firstVision = getBuiltinModels().find((m) => m.provider === provider && m.input.includes('image'));
    if (!firstVision) {
      throw new Error(
        `provider "${provider}" 目录中没有支持图片输入的多模态模型。` +
          `请通过 LLM_PROVIDER / LLM_MODEL 指定（如 google/gemini-2.5-pro、openai/gpt-4o-mini）。`,
      );
    }
    modelId = firstVision.id;
    console.warn(`⚠️  provider "${provider}" 无预置多模态默认模型，回退 ${provider}/${modelId}。`);
  }
  const picked = getBuiltinModel(provider, modelId);
  if (!picked) {
    throw new Error(`找不到内置模型 ${provider}/${modelId}。可通过 LLM_PROVIDER / LLM_MODEL 环境变量指定。`);
  }
  if (!picked.input.includes('image')) {
    throw new Error(
      `模型 ${provider}/${modelId} 不支持图片输入（input: [${picked.input.join(', ')}]）。` +
        `本应用为医学影像分析，请选择 input 含 image 的模型，如 google/gemini-2.5-pro。`,
    );
  }

  const llmReady = hasProviderConfigured(provider);
  if (!llmReady) {
    console.warn(`⚠️  未检测到 ${provider.toUpperCase()}_API_KEY。`);
    console.warn('   可在 .env 设置，或由前端用户输入 Key。无 Key 时仍可启动服务，但 /api/analyze 会返回错误提示。\n');
  }

  // ── web 搜索（可选 SerpAPI；免费降级链见 tools/search.ts）────
  const serpapiKey = process.env.SERPAPI_KEY?.trim() || undefined;
  const searchBackend = serpapiKey ? 'serpapi' : 'bing+duckduckgo+fallback';

  // ── 内置多模态模型目录（供前端模型选择；available 取决于当前已配置的 API Key）──
  const models: ModelOption[] = getBuiltinModels()
    .filter((m) => m.input.includes('image'))
    .map((m) => {
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

  return { port, provider, modelId, llmReady, models, searchBackend, serpapiKey };
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
  if (!aiModel.input.includes('image')) {
    throw new Error(`模型 ${provider}/${modelId} 不支持图片输入，请选择多模态模型（如 gemini-2.5-pro）`);
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
  const builtin = getBuiltinModel(provider, modelId);
  if (!builtin) {
    return { choice: { provider, modelId, modelKey, apiKey }, error: `未知模型 ${modelKey}` };
  }
  if (!builtin.input.includes('image')) {
    return { choice: { provider, modelId, modelKey, apiKey }, error: `模型 ${modelKey} 不支持图片输入，请选择多模态模型` };
  }
  if (!hasProviderConfigured(provider) && !apiKey) {
    const meta = BUILTIN_PROVIDERS.find((p) => p.id === provider);
    const envVar = meta?.envVar ?? `${provider.toUpperCase()}_API_KEY`;
    return { choice: { provider, modelId, modelKey, apiKey }, error: `未配置 ${envVar}，请在页面上方输入 API Key 或在 .env 设置` };
  }
  return { choice: { provider, modelId, modelKey, apiKey }, error: null };
}
