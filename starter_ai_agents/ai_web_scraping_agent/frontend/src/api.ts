// starter_ai_agents/ai_web_scraping_agent/frontend/src/api.ts
// 与后端 /api/config、/api/scrape(SSE) 的类型约定与调用封装。
// SSE 解析逻辑对齐 ai_reasoning_agent/frontend/src/api.ts(fetch + ReadableStream + \n\n 分帧)。

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
  /** 网页抓取后端描述,如 'firecrawl+fetch+fallback' / 'fetch+fallback' */
  scrapeBackend: string;
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

export interface ScrapeCallbacks {
  /** 阶段:start(开始)/ done(完成)/ tool_start / tool_end(工具调用) */
  onStage?: (stage: 'start' | 'done' | 'tool_start' | 'tool_end', toolName?: string) => void;
  /** 流式增量:kind=text 正文 / kind=thinking 思考链 */
  onDelta?: (kind: 'text' | 'thinking', delta: string) => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
}

export interface ScrapeParams {
  /** 目标网页 URL */
  url: string;
  /** 自然语言抽取指令 */
  prompt: string;
  model?: ModelChoice;
}

/**
 * 调用 /api/scrape 并消费 SSE 流。
 * 解析 event:/data: 帧,分发到对应回调。客户端取消(abort)时静默退出。
 */
export async function streamScrape(params: ScrapeParams, cb: ScrapeCallbacks): Promise<void> {
  const { url, prompt, model } = params;
  const res = await fetch('/api/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, prompt, model }),
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
        if (stage) cb.onStage?.(stage, typeof evt.data.toolName === 'string' ? evt.data.toolName : undefined);
      } else if (evt.event === 'delta') {
        const kind = evt.data.kind as 'text' | 'thinking';
        if (kind && typeof evt.data.delta === 'string') {
          cb.onDelta?.(kind, evt.data.delta);
        }
      } else if (evt.event === 'error') {
        cb.onError?.(typeof evt.data.message === 'string' ? evt.data.message : '抓取失败');
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
  return `scraping_agent_apikey_${provider}`;
}

/** 从模型输出文本中提取第一个 JSON 代码块(或裸 JSON 对象),失败返回 null */
export function extractJsonBlock(text: string): string | null {
  // 1) ```json ... ``` 代码块
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fence?.[1]) {
    const candidate = fence[1].trim();
    if (isValidJson(candidate)) return candidate;
  }
  // 2) 裸 JSON(第一个 { 到最后一个 } / [ ... ])
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start !== -1 && end > start) {
      const candidate = text.slice(start, end + 1);
      if (isValidJson(candidate)) return candidate;
    }
  }
  return null;
}

function isValidJson(s: string): boolean {
  if (!s) return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}
