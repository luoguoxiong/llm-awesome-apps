/**
 * starter_ai_agents/ai_multimodal_agent/src/runtime.ts
 *
 * 多模态分析 Agent(基于 @aipack-ai/agent,单轮无会话):
 *   - 输入:用户问题 + 图片附件(data URI base64;视频由前端抽帧转为多张图片)
 *   - 能力:视觉理解 + search_web 工具(结合 web 搜索补充回答)
 *   - 输出:SSE 流式推送 thinking / text / 工具调用阶段
 *
 * 多模态通路:aipack Request.media(string[],data URI)→ runtime 自动转为
 * ImageContent 内容块 → provider 适配层(OpenAI image_url / Anthropic base64)。
 *
 * 迁移自 awesome-llm-apps/starter_ai_agents/multimodal_ai_agent
 * (源应用:Gemini 2.5 视频分析 + web 搜索;视频在浏览器端抽帧实现功能等价)。
 */
import {
  createRuntime,
  createRequest,
  type Model,
  type StreamFn,
  type Runtime,
} from '@aipack-ai/agent';
import { buildModel } from './config.js';
import { createSearchTool } from './tools/search.js';
import { createHash } from 'node:crypto';

// ─── 系统提示词 ─────────────────────────────────────────────────

const ANALYST_SYSTEM_PROMPT = `你是一位专业的多模态分析师,擅长结合视觉内容与网络信息回答问题:
- 先仔细观察并理解输入的图片(或视频关键帧序列):识别其中的对象、场景、文字、时间顺序等要素
- 视频帧按时间先后排列,可据此推断画面内容的变化与动作
- 需要外部信息佐证时(地标/品牌/人物背景、最新资讯、事实核查等),调用 search_web 工具搜索
- 回答结构:先给出基于视觉内容的观察结论,再补充 web 搜索到的相关信息,明确区分两者来源
- 给出实用、可操作的信息;用 Markdown 组织答案,关键结论加粗
- 视觉内容中不存在的信息不要臆造;看不清的部分明确说明
- 用中文回答(除非用户用其他语言提问)`;

// ─── 类型 ───────────────────────────────────────────────────────

export interface AnalysisInput {
  /** 用户问题 */
  question: string;
  /** 图片附件(data URI base64;视频已由前端抽帧) */
  media: string[];
}

/** SSE 进度事件(经 server 转译为 stage/delta/done/error) */
export interface AnalysisProgress {
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

export interface AnalysisOutput {
  text: string;
  thinking: string;
}

// ─── Runtime 工厂 ───────────────────────────────────────────────

/** 构建多模态分析 Runtime:单轮,带 search_web 工具,无会话存储 */
export function createAnalysisRuntime(model: Model, streamFn: StreamFn, serpapiKey?: string): Runtime {
  return createRuntime({
    model,
    streamFn,
    systemPrompt: ANALYST_SYSTEM_PROMPT,
    tools: [createSearchTool(serpapiKey)],
    maxTurns: 6,
    config: { role: 'analyst' },
  });
}

// ─── 流式执行 ───────────────────────────────────────────────────

/**
 * 流式执行多模态分析:media 经 Request.media 传给 aipack(自动转 ImageContent),
 * 捕获 text / thinking / 工具调用阶段,细粒度推送给 SSE。
 */
export async function streamAnalysis(
  input: AnalysisInput,
  runtime: Runtime,
  onProgress: (p: AnalysisProgress) => void,
  signal?: AbortSignal,
): Promise<AnalysisOutput> {
  onProgress({ type: 'start' });
  const req = createRequest(input.question, { media: input.media, ephemeral: true });

  const output: AnalysisOutput = { text: '', thinking: '' };
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
      throw new Error(chunk.content || '分析执行出错');
    }
  }

  if (!output.text.trim() && !output.thinking.trim()) {
    throw new Error('模型未生成内容(所选模型可能不支持图片输入,请切换多模态模型)');
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
export function createRuntimeRegistry(serpapiKey?: string): RuntimeRegistry {
  const cache = new Map<string, Runtime>();
  return {
    get(provider, modelId, apiKey) {
      const keyTag = apiKey ? `u:${createHash('sha256').update(apiKey).digest('hex').slice(0, 8)}` : 'env';
      const cacheKey = `${provider}/${modelId}:${keyTag}`;
      let runtime = cache.get(cacheKey);
      if (!runtime) {
        const { model, streamFn } = buildModel(provider, modelId, apiKey);
        runtime = createAnalysisRuntime(model, streamFn, serpapiKey);
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
