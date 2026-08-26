// starter_ai_agents/ai_data_analysis_agent/frontend/src/api.ts
// 与后端 /api/config、/api/dataset(上传)、/api/chat(SSE) 的类型约定与调用封装。
// SSE 解析逻辑对齐 ai_finance_agent/frontend/src/api.ts(fetch + ReadableStream + \n\n 分帧)。

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
  llmReady: boolean;
  defaultModel: { provider: string; modelId: string };
  models: ModelOption[];
}

export interface ModelChoice {
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

// ─── 数据集上传 ──────────────────────────────────────────────────

export type ColumnType = 'number' | 'date' | 'string';

export interface ColumnMeta {
  name: string;
  type: ColumnType;
  missing: number;
  unique: number;
  min?: number;
  max?: number;
  mean?: number;
}

export interface DatasetInfo {
  id: string;
  name: string;
  rowCount: number;
  truncated: boolean;
  columns: ColumnMeta[];
  preview: Record<string, unknown>[];
}

/** 上传 CSV/Excel 文件 → 解析并缓存到服务端,返回元信息 + 预览行 */
export async function uploadDataset(file: File): Promise<DatasetInfo> {
  const res = await fetch(`/api/dataset?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: await file.arrayBuffer(),
  });
  const data = (await res.json().catch(() => ({}))) as DatasetInfo & { error?: string };
  if (!res.ok) throw new Error(data.error || `上传失败(HTTP ${res.status})`);
  return data;
}

// ─── 聊天(SSE)──────────────────────────────────────────────────

/** 工具调用条目(由 stage 事件驱动) */
export interface ToolCallEntry {
  name: string;
  status: 'running' | 'done';
}

/** 聊天消息(前端本地状态) */
export interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  thinking: string;
  toolCalls: ToolCallEntry[];
  done: boolean;
}

export interface ChatCallbacks {
  /** SSE 下发会话 ID(首轮) */
  onSession?: (sessionId: string) => void;
  /** 阶段:start / done / tool_start / tool_end */
  onStage?: (stage: 'start' | 'done' | 'tool_start' | 'tool_end', toolName?: string) => void;
  /** 流式增量:kind=text 正文 / kind=thinking 思考链 */
  onDelta?: (kind: 'text' | 'thinking', delta: string) => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
}

export interface ChatParams {
  message: string;
  /** 当前数据集 ID(必传,服务端据此装配查询工具) */
  datasetId: string;
  /** 会话 ID;空则由服务端生成并通过 onSession 回传 */
  sessionId?: string;
  model?: ModelChoice;
}

/**
 * 调用 /api/chat 并消费 SSE 流。
 * 解析 event:/data: 帧,分发到对应回调。客户端取消(abort)时静默退出。
 */
export async function streamChat(params: ChatParams, cb: ChatCallbacks): Promise<void> {
  const { message, datasetId, sessionId, model } = params;
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, datasetId, sessionId, model }),
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
        const stage = evt.data.stage as 'start' | 'done' | 'tool_start' | 'tool_end' | 'session';
        if (stage === 'session' && typeof evt.data.sessionId === 'string') {
          cb.onSession?.(evt.data.sessionId);
        } else if (stage && stage !== 'session') {
          cb.onStage?.(stage, typeof evt.data.toolName === 'string' ? evt.data.toolName : undefined);
        }
      } else if (evt.event === 'delta') {
        const kind = evt.data.kind as 'text' | 'thinking';
        if (kind && typeof evt.data.delta === 'string') {
          cb.onDelta?.(kind, evt.data.delta);
        }
      } else if (evt.event === 'error') {
        cb.onError?.(typeof evt.data.message === 'string' ? evt.data.message : '对话失败');
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
  return `data_analysis_agent_apikey_${provider}`;
}

/** 前端生成会话 ID(浏览器原生 UUID) */
export function newSessionId(): string {
  return crypto.randomUUID();
}
