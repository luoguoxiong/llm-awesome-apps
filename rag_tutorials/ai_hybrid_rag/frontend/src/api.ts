// rag_tutorials/ai_hybrid_rag/frontend/src/api.ts
// 与后端 /api/config、/api/ingest（摄取）、/api/documents（索引管理）、/api/chat（SSE）
// 的类型约定与调用封装。SSE 解析逻辑对齐 ai_data_analysis_agent/frontend/src/api.ts
// （fetch + ReadableStream + \n\n 分帧）。

/** 后端 /api/config 返回的模型条目 */
export interface ModelOption {
  provider: string;
  providerName: string;
  modelId: string;
  modelName: string;
  /** 该 provider 是否已配置 API Key（决定前端是否禁用输入） */
  available: boolean;
  /** 是否为推理模型 */
  reasoning: boolean;
  /** 缺 Key 时提示用户设置的环境变量名 */
  envVar: string;
}

/** 检索参数（服务端 env 配置，随 config 下发用于展示） */
export interface RetrievalParams {
  candidateK: number;
  contextK: number;
  rrfK: number;
  gradeEnabled: boolean;
}

export interface SourceStats {
  name: string;
  chunkCount: number;
  addedAt: number;
}

export interface StoreStats {
  totalChunks: number;
  sources: SourceStats[];
}

export interface ServerConfig {
  provider: string;
  model: string;
  llmReady: boolean;
  defaultModel: { provider: string; modelId: string };
  models: ModelOption[];
  stats: StoreStats;
  params: RetrievalParams;
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

// ─── 文档摄取 / 索引管理 ──────────────────────────────────────────

export interface IngestResult {
  name: string;
  added: number;
  skipped: number;
  stats: StoreStats;
}

/** 摄取文本（name + content；文件由前端读取为字符串后提交） */
export async function ingestText(name: string, content: string): Promise<IngestResult> {
  const res = await fetch('/api/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, content }),
  });
  const data = (await res.json().catch(() => ({}))) as IngestResult & { error?: string };
  if (!res.ok) throw new Error(data.error || `摄取失败（HTTP ${res.status}）`);
  return data;
}

/** 摄取 URL（服务端抓取正文：Firecrawl 可选 → 原生 fetch） */
export async function ingestUrl(url: string): Promise<IngestResult> {
  const res = await fetch('/api/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const data = (await res.json().catch(() => ({}))) as IngestResult & { error?: string };
  if (!res.ok) throw new Error(data.error || `抓取失败（HTTP ${res.status}）`);
  return data;
}

/** 拉取索引统计 */
export async function fetchDocuments(): Promise<StoreStats> {
  const res = await fetch('/api/documents');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as StoreStats;
}

/** 删除指定来源（name 为空则清空全部索引） */
export async function removeDocuments(name?: string): Promise<{ removed: number; stats: StoreStats }> {
  const qs = name ? `?name=${encodeURIComponent(name)}` : '';
  const res = await fetch(`/api/documents${qs}`, { method: 'DELETE' });
  const data = (await res.json().catch(() => ({}))) as { removed?: number; stats?: StoreStats; error?: string };
  if (!res.ok) throw new Error(data.error || `删除失败（HTTP ${res.status}）`);
  return { removed: data.removed ?? 0, stats: data.stats ?? { totalChunks: 0, sources: [] } };
}

// ─── 聊天（SSE）──────────────────────────────────────────────────

/** 检索候选片段（search_done 事件下发，用于展示检索细节） */
export interface CandidateInfo {
  rank: number;
  source: string;
  score: number;
  keywordScore: number | null;
  vectorScore: number | null;
  preview: string;
  relevant: boolean | null;
}

/** 阶段状态（单条 assistant 消息的检索/评估过程） */
export interface RetrievalTrace {
  stage: 'searching' | 'grading' | 'answering' | 'done';
  candidates: CandidateInfo[];
  /** grade_done：是否完成 LLM 评估（false = 降级用融合名次） */
  graded: boolean | null;
  relevantCount: number | null;
  /** answer_start：rag / fallback */
  mode: 'rag' | 'fallback' | null;
  contextCount: number | null;
}

/** 聊天消息（前端本地状态） */
export interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  thinking: string;
  trace: RetrievalTrace | null;
  done: boolean;
}

export interface ChatCallbacks {
  onStage?: (stage: string, data: Record<string, unknown>) => void;
  /** 流式增量：kind=text 正文 / kind=thinking 思考链 */
  onDelta?: (kind: 'text' | 'thinking', delta: string) => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
}

export interface ChatParams {
  message: string;
  /** 会话 ID；同一 ID 维持多轮上下文（服务端内存历史） */
  sessionId?: string;
  model?: ModelChoice;
}

/**
 * 调用 /api/chat 并消费 SSE 流。
 * 解析 event:/data: 帧，分发到对应回调。客户端取消（abort）时静默退出。
 */
export async function streamChat(params: ChatParams, cb: ChatCallbacks): Promise<void> {
  const { message, sessionId, model } = params;
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionId, model }),
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
        const stage = evt.data.stage as string;
        if (stage) cb.onStage?.(stage, evt.data);
      } else if (evt.event === 'delta') {
        const kind = evt.data.kind as 'text' | 'thinking';
        if (kind && typeof evt.data.delta === 'string') {
          cb.onDelta?.(kind, evt.data.delta);
        }
      } else if (evt.event === 'error') {
        cb.onError?.(typeof evt.data.message === 'string' ? evt.data.message : '问答失败');
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

/** localStorage key：按 provider 持久化 API Key */
export function apiKeyStorageKey(provider: string): string {
  return `hybrid_rag_apikey_${provider}`;
}

/** 前端生成会话 ID（浏览器原生 UUID） */
export function newSessionId(): string {
  return crypto.randomUUID();
}
