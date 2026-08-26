// starter_ai_agents/ai_breakup_recovery_agent/frontend/src/api.ts
// 与后端 /api/config、/api/recovery(SSE) 的类型约定与调用封装。
// SSE 解析逻辑对齐 ai_multimodal_agent/frontend/src/api.ts(fetch + ReadableStream + \n\n 分帧)。

/** 四个 Agent 的标识(与后端 runtime.ts 的 AgentId 约定一致) */
export type AgentId = 'therapist' | 'closure' | 'routine' | 'honesty';

/** Agent 展示元数据(顺序即执行顺序) */
export const AGENT_META: Array<{ id: AgentId; emoji: string; title: string; subtitle: string }> = [
  { id: 'therapist', emoji: '🤗', title: '共情陪伴', subtitle: '接住情绪,温柔安慰' },
  { id: 'closure', emoji: '✍️', title: '告别仪式', subtitle: '写下不会寄出的信' },
  { id: 'routine', emoji: '📅', title: '七天恢复计划', subtitle: '可执行的每日挑战' },
  { id: 'honesty', emoji: '💪', title: '毒舌真相', subtitle: '直白看清现实,继续向前' },
];

/** 后端 /api/config 返回的模型条目(全内置模型目录,含多模态标记) */
export interface ModelOption {
  provider: string;
  providerName: string;
  modelId: string;
  modelName: string;
  /** 该 provider 是否已配置 API Key(决定前端是否禁用输入) */
  available: boolean;
  /** 是否为推理模型 */
  reasoning: boolean;
  /** 是否支持图片输入(上传截图时必须选择此类模型) */
  multimodal: boolean;
  /** 缺 Key 时提示用户设置的环境变量名 */
  envVar: string;
}

export interface ServerConfig {
  provider: string;
  model: string;
  llmReady: boolean;
  defaultModel: { provider: string; modelId: string };
  models: ModelOption[];
  /** web 搜索后端描述,如 'serpapi' / 'bing+duckduckgo+fallback' */
  searchBackend: string;
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

/** 工具调用条目(由 stage 事件驱动) */
export interface ToolCallEntry {
  name: string;
  status: 'running' | 'done';
}

export interface RecoveryCallbacks {
  /**
   * 阶段:start / done(整体)/ agent_start / agent_end(某 Agent 开始与结束)
   * / tool_start / tool_end(工具调用,携带 agent 归属)
   */
  onStage?: (
    stage: 'start' | 'done' | 'agent_start' | 'agent_end' | 'tool_start' | 'tool_end',
    agent?: AgentId,
    toolName?: string,
  ) => void;
  /** 流式增量:agent 归属 + kind=text 正文 / kind=thinking 思考链 */
  onDelta?: (agent: AgentId, kind: 'text' | 'thinking', delta: string) => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
}

export interface RecoveryParams {
  /** 感受自述(与截图至少一项) */
  story: string;
  /** 聊天截图(data URI base64) */
  media: string[];
  model?: ModelChoice;
}

/**
 * 调用 /api/recovery 并消费 SSE 流。
 * 解析 event:/data: 帧,分发到对应回调。客户端取消(abort)时静默退出。
 */
export async function streamRecovery(params: RecoveryParams, cb: RecoveryCallbacks): Promise<void> {
  const { story, media, model } = params;
  const res = await fetch('/api/recovery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ story, media, model }),
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
        const stage = evt.data.stage as
          | 'start'
          | 'done'
          | 'agent_start'
          | 'agent_end'
          | 'tool_start'
          | 'tool_end';
        if (stage) {
          const agent = typeof evt.data.agent === 'string' ? (evt.data.agent as AgentId) : undefined;
          const toolName = typeof evt.data.toolName === 'string' ? evt.data.toolName : undefined;
          cb.onStage?.(stage, agent, toolName);
        }
      } else if (evt.event === 'delta') {
        const agent = evt.data.agent as AgentId | undefined;
        const kind = evt.data.kind as 'text' | 'thinking' | undefined;
        if (agent && kind && typeof evt.data.delta === 'string') {
          cb.onDelta?.(agent, kind, evt.data.delta);
        }
      } else if (evt.event === 'error') {
        cb.onError?.(typeof evt.data.message === 'string' ? evt.data.message : '陪伴请求失败');
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
  return `breakup_recovery_apikey_${provider}`;
}
