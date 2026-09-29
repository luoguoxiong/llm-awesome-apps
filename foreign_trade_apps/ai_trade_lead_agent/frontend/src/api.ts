// foreign_trade_apps/ai_trade_lead_agent/frontend/src/api.ts
// 与后端 /api/config、/api/leads(SSE) 的类型约定与调用封装。
// SSE 解析逻辑对齐 ai_research_agent/frontend/src/api.ts(fetch + ReadableStream + \n\n 分帧)。

/** 后端 /api/config 返回的模型条目 */
export interface ModelOption {
  provider: string;
  providerName: string;
  modelId: string;
  modelName: string;
  available: boolean;
  reasoning: boolean;
  envVar: string;
}

export interface ServerConfig {
  provider: string;
  model: string;
  llmReady: boolean;
  defaultModel: { provider: string; modelId: string };
  models: ModelOption[];
  /** web 搜索后端描述 */
  searchBackend: string;
  /** 默认候选进口商数量 */
  defaultLeads: number;
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

// ─── 线索数据类型(与后端 Lead 对齐)────────────────────────────

export type Verdict = 'yes' | 'likely' | 'unknown' | 'no';

export interface ContactInfo {
  website?: string;
  linkedin?: string;
  emails: string[];
  phones: string[];
  people: string[];
  address?: string;
  note?: string;
}

export interface Lead {
  id: string;
  name: string;
  country?: string;
  city?: string;
  website?: string;
  importyetiUrl?: string;
  source?: string;
  note?: string;
  verdict?: Verdict;
  verdictReason?: string;
  suppliers?: string[];
  matchedCategory?: string;
  signal?: string;
  contact?: ContactInfo;
}

export type PipelineStage = 'importers' | 'verify' | 'contacts' | 'analysis' | 'email';

/** 工具调用条目(由 tool 事件驱动) */
export interface ToolCallEntry {
  name: string;
  status: 'running' | 'done';
}

/** 一次获客任务的前端状态 */
export interface LeadRun {
  id: string;
  keyword: string;
  /** 线索(按 id 索引,后端推送完整快照) */
  leads: Record<string, Lead>;
  /** 线索顺序 */
  order: string[];
  /** 各阶段的流式日志(过程说明) */
  log: string;
  /** 已开始/完成的阶段标记 */
  stages: Partial<Record<PipelineStage | 'done', string>>;
  /** 当前阶段 */
  current: PipelineStage | 'done' | null;
  /** 客户分析与开发信(target 区分) */
  analysis: Record<string, string>;
  emails: Record<string, string>;
  toolCalls: ToolCallEntry[];
  done: boolean;
  error?: string;
}

export interface LeadCallbacks {
  onStage?: (stage: PipelineStage | 'done' | 'start', label?: string, leadId?: string) => void;
  onLog?: (delta: string) => void;
  onDelta?: (target: 'analysis' | 'email', leadId: string, delta: string) => void;
  onLead?: (lead: Lead) => void;
  onTool?: (phase: 'start' | 'end', toolName: string) => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
}

export interface LeadRequest {
  keyword: string;
  market: string;
  sellerProfile: string;
  maxLeads: number;
}

/** 调用 /api/leads 并消费 SSE 流。客户端取消(abort)时静默退出。 */
export async function runLeads(
  req: LeadRequest,
  model: ModelChoice | undefined,
  cb: LeadCallbacks,
): Promise<void> {
  const res = await fetch('/api/leads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...req, model }),
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
        const stage = evt.data.stage as PipelineStage | 'done' | 'start';
        cb.onStage?.(stage, typeof evt.data.label === 'string' ? evt.data.label : undefined, typeof evt.data.leadId === 'string' ? evt.data.leadId : undefined);
      } else if (evt.event === 'log') {
        if (typeof evt.data.delta === 'string') cb.onLog?.(evt.data.delta);
      } else if (evt.event === 'delta') {
        const target = evt.data.target as 'analysis' | 'email';
        const leadId = String(evt.data.leadId ?? '');
        if ((target === 'analysis' || target === 'email') && leadId && typeof evt.data.delta === 'string') {
          cb.onDelta?.(target, leadId, evt.data.delta);
        }
      } else if (evt.event === 'lead') {
        const lead = evt.data as unknown as Lead;
        if (lead && typeof lead.id === 'string') cb.onLead?.(lead);
      } else if (evt.event === 'tool') {
        const phase = evt.data.phase as 'start' | 'end';
        const toolName = String(evt.data.toolName ?? '');
        if (toolName) cb.onTool?.(phase, toolName);
      } else if (evt.event === 'error') {
        cb.onError?.(typeof evt.data.message === 'string' ? evt.data.message : '获客流水线失败');
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
  return `trade_lead_agent_apikey_${provider}`;
}

let runSeq = 0;
export function nextRunId(): string {
  runSeq += 1;
  return `run${runSeq}`;
}
