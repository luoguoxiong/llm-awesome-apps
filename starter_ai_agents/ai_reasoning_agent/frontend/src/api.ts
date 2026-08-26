// starter_ai_agents/ai_reasoning_agent/frontend/src/api.ts
// 与后端 /api/config、/api/compare(SSE) 的类型约定与调用封装。
// SSE 解析逻辑对齐 ai_teaching_agent_team/frontend/src/api.ts(fetch + ReadableStream + \n\n 分帧)。

export type AgentSide = 'regular' | 'reasoning';

/** 后端 /api/config 返回的模型条目 */
export interface ModelOption {
  provider: string;
  providerName: string;
  modelId: string;
  modelName: string;
  /** 该 provider 是否已配置 API Key(决定前端是否禁用输入) */
  available: boolean;
  /** 是否为推理模型 */
  reasoning: boolean;
  /** 缺 Key 时提示用户设置的环境变量名 */
  envVar: string;
}

export interface ServerConfig {
  provider: string;
  model: string;
  reasoningProvider: string;
  reasoningModel: string;
  llmReady: boolean;
  reasoningReady: boolean;
  defaultRegular: { provider: string; modelId: string };
  defaultReasoning: { provider: string; modelId: string };
  models: ModelOption[];
}

export interface ModelChoice {
  provider: string;
  modelId: string;
  apiKey?: string;
}

export type StageStatus = 'pending' | 'active' | 'done';

/** 拉取服务配置 */
export async function fetchConfig(): Promise<ServerConfig> {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ServerConfig;
}

export interface CompareCallbacks {
  /** agent 阶段:start(开始生成)/ done(完成) */
  onStage?: (agent: AgentSide, stage: 'start' | 'done') => void;
  /** 流式增量:kind=text 正文 / kind=thinking 思考链 */
  onDelta?: (agent: AgentSide, kind: 'text' | 'thinking', delta: string) => void;
  /** 整体完成(两侧均已结束) */
  onDone?: () => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
}

export interface CompareParams {
  question: string;
  regularModel?: ModelChoice;
  reasoningModel?: ModelChoice;
}

/**
 * 调用 /api/compare 并消费 SSE 流。
 * 解析 event:/data: 帧,分发到对应回调。客户端取消(abort)时静默退出。
 */
export async function streamCompare(params: CompareParams, cb: CompareCallbacks): Promise<void> {
  const { question, regularModel, reasoningModel } = params;
  const res = await fetch('/api/compare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, regularModel, reasoningModel }),
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

    // SSE 以 \n\n 分隔事件
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const evt = parseSse(raw);
      if (!evt) continue;

      if (evt.event === 'stage') {
        const agent = evt.data.agent as AgentSide;
        const stage = evt.data.stage as 'start' | 'done';
        if (agent && stage) cb.onStage?.(agent, stage);
      } else if (evt.event === 'delta') {
        const agent = evt.data.agent as AgentSide;
        const kind = evt.data.kind as 'text' | 'thinking';
        if (agent && kind && typeof evt.data.delta === 'string') {
          cb.onDelta?.(agent, kind, evt.data.delta);
        }
      } else if (evt.event === 'done') {
        cb.onDone?.();
      } else if (evt.event === 'error') {
        cb.onError?.(typeof evt.data.message === 'string' ? evt.data.message : '生成失败');
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

/** localStorage key:按 provider 持久化 API Key(普通/推理两侧共享同一 provider 的 Key) */
export function apiKeyStorageKey(provider: string): string {
  return `reasoning_agent_apikey_${provider}`;
}
