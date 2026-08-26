// starter_ai_agents/ai_startup_trends_agent/frontend/src/api.ts
// 与后端 /api/config、/api/analyze(SSE) 的类型约定与调用封装。
// SSE 解析逻辑对齐 ai_research_agent/frontend/src/api.ts(fetch + ReadableStream + \n\n 分帧)。

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

// ─── 趋势分析(SSE)──────────────────────────────────────────────

/** 分析流水线阶段(由 phase 事件驱动) */
export type AnalysisPhase = 'collect' | 'summarize' | 'analyze';

/** 工具调用条目(由 stage 事件驱动) */
export interface ToolCallEntry {
  name: string;
  status: 'running' | 'done';
}

/** 已收集文章摘要(由 summary 事件驱动) */
export interface ArticleSummaryEntry {
  title: string;
  source: string;
  summary: string;
}

/** 一次分析任务的前端状态 */
export interface TrendRun {
  id: string;
  /** 感兴趣的创业领域 */
  topic: string;
  /** 报告全文(流式追加,Markdown) */
  text: string;
  thinking: string;
  /** 当前分析阶段 */
  phase: AnalysisPhase;
  toolCalls: ToolCallEntry[];
  summaries: ArticleSummaryEntry[];
  done: boolean;
  /** 失败时的错误信息 */
  error?: string;
}

export interface AnalysisCallbacks {
  onStage?: (stage: 'start' | 'done' | 'tool_start' | 'tool_end', toolName?: string) => void;
  /** 阶段切换(collect 新闻收集 / summarize 摘要整理 / analyze 趋势分析) */
  onPhase?: (phase: AnalysisPhase) => void;
  /** 流式增量:kind=text 报告正文 / kind=thinking 思考链 */
  onDelta?: (kind: 'text' | 'thinking', delta: string) => void;
  /** 新文章摘要(save_article_summary 工具触发) */
  onSummary?: (summary: ArticleSummaryEntry) => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
}

/**
 * 调用 /api/analyze 并消费 SSE 流。
 * 解析 event:/data: 帧,分发到对应回调。客户端取消(abort)时静默退出。
 */
export async function runAnalysis(topic: string, model: ModelChoice | undefined, cb: AnalysisCallbacks): Promise<void> {
  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, model }),
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
        const stage = evt.data.stage as 'start' | 'done' | 'tool_start' | 'tool_end';
        if (stage) {
          cb.onStage?.(stage, typeof evt.data.toolName === 'string' ? evt.data.toolName : undefined);
        }
      } else if (evt.event === 'phase') {
        const phase = evt.data.phase as AnalysisPhase;
        if (phase === 'collect' || phase === 'summarize' || phase === 'analyze') {
          cb.onPhase?.(phase);
        }
      } else if (evt.event === 'delta') {
        const kind = evt.data.kind as 'text' | 'thinking';
        if (kind && typeof evt.data.delta === 'string') {
          cb.onDelta?.(kind, evt.data.delta);
        }
      } else if (evt.event === 'summary') {
        if (typeof evt.data.title === 'string' && typeof evt.data.summary === 'string') {
          cb.onSummary?.({
            title: evt.data.title,
            source: String(evt.data.source ?? '未注明'),
            summary: evt.data.summary,
          });
        }
      } else if (evt.event === 'error') {
        cb.onError?.(typeof evt.data.message === 'string' ? evt.data.message : '分析失败');
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
  return `startup_trends_apikey_${provider}`;
}

let runSeq = 0;
export function nextRunId(): string {
  runSeq += 1;
  return `run${runSeq}`;
}
