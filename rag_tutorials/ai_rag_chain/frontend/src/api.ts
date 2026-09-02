// rag_tutorials/ai_rag_chain/frontend/src/api.ts
// 与后端 /api/config、/api/upload、/api/clear、/api/query(SSE)的类型约定与调用封装。
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

/** 知识库统计 */
export interface DbStats {
  chunkCount: number;
  sourceCount: number;
  sources: string[];
}

export interface ServerConfig {
  provider: string;
  model: string;
  llmReady: boolean;
  defaultModel: { provider: string; modelId: string };
  models: ModelOption[];
  topK: number;
  db: DbStats;
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

// ─── 知识库:上传 / 清空 ───────────────────────────────────────────

/** 单文件上传结果 */
export interface UploadResult {
  name: string;
  status: 'ok' | 'skipped' | 'error';
  chars: number;
  added: number;
  message?: string;
}

export interface UploadResponse {
  results: UploadResult[];
  db: DbStats;
}

/** 文件 → base64(剥离 data URL 前缀) */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.onerror = () => reject(r.error ?? new Error('读取文件失败'));
    r.readAsDataURL(file);
  });
}

/** 上传文档(PDF/TXT/MD 等)到知识库 */
export async function uploadFiles(files: File[]): Promise<UploadResponse> {
  const payload = await Promise.all(
    files.map(async (f) => ({ name: f.name, contentBase64: await fileToBase64(f) })),
  );
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: payload }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `上传失败(HTTP ${res.status})`);
  }
  return (await res.json()) as UploadResponse;
}

/** 清空知识库 */
export async function clearDb(): Promise<{ removed: number; db: DbStats }> {
  const res = await fetch('/api/clear', { method: 'POST' });
  if (!res.ok) throw new Error(`清空失败(HTTP ${res.status})`);
  return (await res.json()) as { removed: number; db: DbStats };
}

// ─── RAG 问答(SSE)───────────────────────────────────────────────

/** 检索到的引用片段(经 sources 事件下发) */
export interface SourceHit {
  index: number;
  source: string;
  score: number;
  text: string;
}

/** 聊天消息(前端本地状态) */
export interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** 检索到的引用片段(仅 assistant) */
  sources: SourceHit[];
  done: boolean;
}

export interface QueryCallbacks {
  /** 阶段:retrieval_start / retrieval_done / answer_start */
  onStage?: (stage: 'retrieval_start' | 'retrieval_done' | 'answer_start', hitCount?: number) => void;
  /** 检索片段下发(回答开始前) */
  onSources?: (hits: SourceHit[]) => void;
  /** 流式增量 */
  onDelta?: (delta: string) => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
}

/**
 * 调用 /api/query 并消费 SSE 流。
 * 解析 event:/data: 帧,分发到对应回调。客户端取消(abort)时静默退出。
 */
export async function streamQuery(
  params: { question: string; model?: ModelChoice },
  cb: QueryCallbacks,
): Promise<void> {
  const res = await fetch('/api/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
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
        const stage = evt.data.stage as 'retrieval_start' | 'retrieval_done' | 'answer_start';
        if (stage === 'retrieval_done') {
          cb.onStage?.(stage, typeof evt.data.hitCount === 'number' ? evt.data.hitCount : undefined);
        } else {
          cb.onStage?.(stage);
        }
      } else if (evt.event === 'sources') {
        if (Array.isArray(evt.data.hits)) cb.onSources?.(evt.data.hits as SourceHit[]);
      } else if (evt.event === 'delta') {
        if (typeof evt.data.delta === 'string') cb.onDelta?.(evt.data.delta);
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

/** localStorage key:按 provider 持久化 API Key */
export function apiKeyStorageKey(provider: string): string {
  return `rag_chain_apikey_${provider}`;
}
