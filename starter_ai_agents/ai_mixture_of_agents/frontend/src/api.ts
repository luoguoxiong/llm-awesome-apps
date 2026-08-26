// starter_ai_agents/ai_mixture_of_agents/frontend/src/api.ts
// 与后端 /api/config、/api/mixture(SSE) 的类型约定与调用封装。
// SSE 解析逻辑对齐系列应用(fetch + ReadableStream + \n\n 分帧)。

/** 后端 /api/config 返回的模型条目 */
export interface ModelOption {
  provider: string;
  providerName: string;
  modelId: string;
  modelName: string;
  /** 该 provider 是否已配置 API Key(决定前端提示) */
  available: boolean;
  /** 是否为推理模型 */
  reasoning: boolean;
  /** 缺 Key 时提示用户设置的环境变量名 */
  envVar: string;
}

export interface ServerConfig {
  provider: string;
  model: string;
  llmReady: boolean;
  defaultModel: { provider: string; modelId: string };
  models: ModelOption[];
  /** 前端默认勾选的参考模型 */
  defaultReferences: Array<{ provider: string; modelId: string }>;
  /** 参考模型数量上限 */
  maxReferences: number;
}

/** 提交给后端的单个模型选择 */
export interface ModelSpec {
  provider: string;
  modelId: string;
  apiKey?: string;
}

/** 拉取服务配置 */
export async function fetchConfig(): Promise<ServerConfig> {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ServerConfig;
}

// ─── MoA(SSE)───────────────────────────────────────────────────

/** 单个参考模型的结果面板状态 */
export interface RefResult {
  modelKey: string;
  /** 展示名(如 DeepSeek Chat) */
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  text: string;
  error?: string;
}

/** 聚合阶段状态 */
export interface AggregateState {
  status: 'idle' | 'running' | 'done' | 'error';
  text: string;
  error?: string;
}

export interface MixtureCallbacks {
  onStage?: (stage: string, data: Record<string, unknown>) => void;
  /** 参考模型流式增量 */
  onRefDelta?: (modelKey: string, delta: string) => void;
  /** 聚合回答流式增量 */
  onDelta?: (kind: 'text' | 'thinking', delta: string) => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
}

/**
 * 调用 /api/mixture 并消费 SSE 流。
 * 事件:stage(start/ref_start/ref_end/aggregate_start/done)/ ref_delta / delta / error。
 */
export async function runMixture(
  prompt: string,
  references: ModelSpec[],
  aggregator: ModelSpec,
  cb: MixtureCallbacks,
): Promise<void> {
  const res = await fetch('/api/mixture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, references, aggregator }),
    signal: cb.signal,
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  if (!res.body) throw new Error('响应无 body 流');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const evt = parseSse(raw);
      if (!evt) continue;

      if (evt.event === 'stage') {
        const stage = String(evt.data.stage ?? '');
        cb.onStage?.(stage, evt.data);
      } else if (evt.event === 'ref_delta') {
        const modelKey = evt.data.modelKey;
        if (typeof modelKey === 'string' && typeof evt.data.delta === 'string') {
          cb.onRefDelta?.(modelKey, evt.data.delta);
        }
      } else if (evt.event === 'delta') {
        const kind = evt.data.kind as 'text' | 'thinking';
        if (kind && typeof evt.data.delta === 'string') {
          cb.onDelta?.(kind, evt.data.delta);
        }
      } else if (evt.event === 'error') {
        cb.onError?.(typeof evt.data.message === 'string' ? evt.data.message : 'MoA 执行失败');
      }
    }
  }
}

/** 解析单条 SSE 帧 → { event, data } */
function parseSse(raw: string): { event: string; data: Record<string, unknown> } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) as Record<string, unknown> };
  } catch {
    return { event, data: { raw: dataLines.join('\n') } };
  }
}

/** localStorage key:按 provider 持久化 API Key */
export function apiKeyStorageKey(provider: string): string {
  return `moa_apikey_${provider}`;
}
