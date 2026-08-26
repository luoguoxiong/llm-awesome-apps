/**
 * starter_ai_agents/ai_web_scraping_agent/src/runtime.ts
 *
 * 智能抓取 Agent(基于 @aipack-ai/agent,单轮无会话):
 *   - 输入:目标 URL + 用户自然语言抽取指令(如"提取产品名称、价格和库存状态")
 *   - 流程:Agent 先调用 scrape_web 工具抓取网页正文,再按指令抽取结构化数据
 *   - 输出:结构化 JSON(```json 代码块)+ 摘要说明,SSE 流式推送
 *
 * 迁移自 awesome-llm-apps/starter_ai_agents/web_scraping_ai_agent
 * (源应用:ScrapeGraphAI SmartScraperGraph,抓取 + LLM 抽取两步合一;
 *  本实现以 aipack 工具调用循环等价替代,抓取走三层降级链)。
 */
import {
  createRuntime,
  createRequest,
  type Model,
  type StreamFn,
  type Runtime,
} from '@aipack-ai/agent';
import { buildModel } from './config.js';
import { createScrapeTool } from './tools/scrape.js';
import { createHash } from 'node:crypto';

// ─── 系统提示词 ─────────────────────────────────────────────────

const EXTRACTOR_SYSTEM_PROMPT = `你是一位专业的网页数据抽取专家(智能抓取 Agent)。工作流程:
1. 收到目标 URL 和抽取指令后,立即调用 scrape_web 工具抓取页面正文
2. 仔细阅读抓取到的正文,按用户的抽取指令提取所需信息
3. 输出格式(严格遵守):
   - 先用一两句话说明抓取结果(页面标题、正文是否完整/截断)
   - 然后输出一个 \`\`\`json 代码块,包含抽取出的结构化数据
4. JSON 结构设计原则:
   - 列表类数据(产品/文章/公司等)用数组,每项为对象,字段名用英文小驼峰,值保留原文语言
   - 例如抽取产品:{"products":[{"name":"...","price":"...","availability":"..."}],"totalCount":3}
   - 单对象数据直接用对象,如 {"title":"...","author":"...","date":"..."}
5. 正文中不存在的信息不要编造;缺失字段填 null;页面无目标数据时返回空数组并说明
6. 若抓取失败(工具返回了失败提示),向用户说明原因,输出 {"error":"抓取失败原因"}
7. 用中文说明,JSON 值保留页面原文语言`;

// ─── 类型 ───────────────────────────────────────────────────────

export interface ExtractionInput {
  /** 目标网页 URL */
  url: string;
  /** 用户自然语言抽取指令 */
  prompt: string;
}

/** SSE 进度事件(经 server 转译为 stage/delta/error) */
export interface ExtractionProgress {
  type: 'start' | 'delta' | 'tool_start' | 'tool_end' | 'done' | 'error';
  /** delta 类型:正文 / 思考链 */
  kind?: 'text' | 'thinking';
  /** delta 增量文本 */
  delta?: string;
  /** tool_start / tool_end 时的工具名 */
  toolName?: string;
  /** error 时的错误信息 */
  message?: string;
}

export interface ExtractionOutput {
  text: string;
  thinking: string;
}

// ─── Runtime 工厂 ───────────────────────────────────────────────

/** 构建抽取 Runtime:单轮,带 scrape_web 工具,无会话存储 */
export function createExtractionRuntime(model: Model, streamFn: StreamFn, firecrawlKey?: string): Runtime {
  return createRuntime({
    model,
    streamFn,
    systemPrompt: EXTRACTOR_SYSTEM_PROMPT,
    tools: [createScrapeTool(firecrawlKey)],
    maxTurns: 4,
    config: { role: 'extractor' },
  });
}

// ─── 流式执行 ───────────────────────────────────────────────────

/**
 * 流式执行结构化抽取:Agent 收到 URL + 指令后自行调用 scrape_web,
 * 捕获 text / thinking / 工具调用阶段,细粒度推送给 SSE。
 */
export async function streamExtraction(
  input: ExtractionInput,
  runtime: Runtime,
  onProgress: (p: ExtractionProgress) => void,
  signal?: AbortSignal,
): Promise<ExtractionOutput> {
  onProgress({ type: 'start' });
  const message = `目标网页:${input.url}\n\n抽取指令:${input.prompt}`;
  const req = createRequest(message, { ephemeral: true });

  const output: ExtractionOutput = { text: '', thinking: '' };
  for await (const chunk of runtime.stream(req)) {
    if (signal?.aborted) throw new Error('aborted');
    if (chunk.type === 'text' && chunk.content) {
      output.text += chunk.content;
      onProgress({ type: 'delta', kind: 'text', delta: chunk.content });
    } else if (chunk.type === 'thinking' && chunk.content) {
      output.thinking += chunk.content;
      onProgress({ type: 'delta', kind: 'thinking', delta: chunk.content });
    } else if (chunk.type === 'tool_start' && chunk.toolName) {
      onProgress({ type: 'tool_start', toolName: chunk.toolName });
    } else if (chunk.type === 'tool_end' && chunk.toolName) {
      onProgress({ type: 'tool_end', toolName: chunk.toolName });
    } else if (chunk.type === 'error') {
      throw new Error(chunk.content || '抽取执行出错');
    }
  }

  if (!output.text.trim() && !output.thinking.trim()) {
    throw new Error('模型未生成内容,请重试或更换模型');
  }
  onProgress({ type: 'done' });
  return output;
}

// ─── Runtime 注册表:按 (provider, modelId, apiKey) 缓存 ──────────

export interface RuntimeRegistry {
  /** 取(或首次构建并缓存)指定模型的 Runtime。模型不存在时抛错。 */
  get(provider: string, modelId: string, apiKey?: string): Runtime;
  /** 关闭所有缓存的 Runtime(优雅退出时调用) */
  closeAll(): Promise<void>;
}

/**
 * 创建 Runtime 注册表。模型在首次被选中时按需构建并缓存,
 * 避免每次请求重建,同时支持运行时切换模型。
 */
export function createRuntimeRegistry(firecrawlKey?: string): RuntimeRegistry {
  const cache = new Map<string, Runtime>();
  return {
    get(provider, modelId, apiKey) {
      const keyTag = apiKey ? `u:${createHash('sha256').update(apiKey).digest('hex').slice(0, 8)}` : 'env';
      const cacheKey = `${provider}/${modelId}:${keyTag}`;
      let runtime = cache.get(cacheKey);
      if (!runtime) {
        const { model, streamFn } = buildModel(provider, modelId, apiKey);
        runtime = createExtractionRuntime(model, streamFn, firecrawlKey);
        cache.set(cacheKey, runtime);
      }
      return runtime;
    },
    async closeAll() {
      await Promise.allSettled([...cache.values()].map((r) => r.close()));
      cache.clear();
    },
  };
}
