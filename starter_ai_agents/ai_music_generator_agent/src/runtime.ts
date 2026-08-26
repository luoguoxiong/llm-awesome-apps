/**
 * starter_ai_agents/ai_music_generator_agent/src/runtime.ts
 *
 * 音乐生成 Agent(基于 @aipack-ai/agent,多轮对话,内存会话):
 *   - 输入:用户消息(自然语言的音乐生成需求)
 *   - 工具:generate_music(LLM 润色详细提示词 → ModelsLab 生成 MP3)
 *   - 会话:createRequest 携带 sessionKey(非 ephemeral),aipack Runtime 按其维护对话历史,
 *     前端"新对话"按钮切换 sessionId 即开启全新会话
 *   - 音乐回传:工具按 toolCallId 登记生成结果,tool_end 事件取出后经
 *     progress(type:'music')→ SSE `music` 事件 → 前端内嵌播放器
 *
 * 迁移自 awesome-llm-apps/starter_ai_agents/ai_music_generator_agent
 * (源应用:OpenAI gpt-4o + agno ModelsLabTools + Streamlit;
 *  本实现以 aipack 工具调用循环 + ModelsLab v6 voice/music_gen 端点等价替代,
 *  系统提示词沿用源应用"详尽音乐提示词"的指令约定)。
 */
import {
  createRuntime,
  createRequest,
  type Model,
  type StreamFn,
  type Runtime,
} from '@aipack-ai/agent';
import { buildModel } from './config.js';
import { createMusicTool, takeGeneration, type MusicGeneration } from './tools/modelslab.js';
import { createHash } from 'node:crypto';

// ─── 系统提示词 ─────────────────────────────────────────────────

const MUSIC_SYSTEM_PROMPT = `你是一位专业的 AI 音乐创作助手(ModelsLab Music Agent)。工作方式:
- 当用户想要生成音乐时,先把需求扩写成详细、丰富的英文音乐提示词,再调用 generate_music 工具。提示词必须包含:
  * 流派与风格(如 classical、jazz、electronic、hip-hop、cinematic score、lo-fi)
  * 乐器与音色(如 piano、strings、synthesizer pads、808 drums、acoustic guitar)
  * 节奏与速度(如 120 BPM、slow tempo、driving rhythm)
  * 情绪与氛围(如 uplifting、melancholic、dreamy、energetic)
  * 曲式结构(如 intro → verse → chorus → bridge → outro 的推进)
- generate_music 参数:prompt 为扩写后的英文提示词;duration 为时长(秒),用户未指定时默认 30
- 生成成功后,简要介绍这首曲子(风格、乐器、情绪、结构),不要重复粘贴完整音频 URL(前端会自动展示播放器和下载按钮)
- 用户想调整效果(换风格/乐器/情绪)时,基于反馈修改提示词再次调用工具
- 用户只是聊音乐知识、问乐理问题时直接回答,不调用工具
- 一次只生成一首;除非用户明确要求多首,不要连续调用工具
- 用中文回答(除非用户用其他语言提问)`;

// ─── 类型 ───────────────────────────────────────────────────────

export interface ChatInput {
  /** 用户消息 */
  message: string;
  /** 会话 ID(前端生成并持有;同一 ID 维持多轮对话上下文) */
  sessionId: string;
}

/** SSE 进度事件(经 server 转译为 stage/delta/music/error) */
export interface ChatProgress {
  type: 'start' | 'delta' | 'tool_start' | 'tool_end' | 'music' | 'done' | 'error';
  /** delta 类型:正文 / 思考链 */
  kind?: 'text' | 'thinking';
  /** delta 增量文本 */
  delta?: string;
  /** tool_start / tool_end 时的工具名 */
  toolName?: string;
  /** music 事件时的生成结果(播放器数据) */
  music?: MusicGeneration;
  /** error 时的错误信息 */
  message?: string;
}

export interface ChatOutput {
  text: string;
  thinking: string;
}

// ─── Runtime 工厂 ───────────────────────────────────────────────

/** 构建音乐生成 Runtime:多轮会话 + generate_music 工具 */
export function createMusicRuntime(model: Model, streamFn: StreamFn, modelslabKey?: string): Runtime {
  return createRuntime({
    model,
    streamFn,
    systemPrompt: MUSIC_SYSTEM_PROMPT,
    tools: [createMusicTool(modelslabKey)],
    maxTurns: 8,
    config: { role: 'music-generator' },
  });
}

// ─── 流式执行 ───────────────────────────────────────────────────

/**
 * 流式执行一轮对话:sessionKey 维持多轮上下文(aipack 内存会话),
 * 捕获 text / thinking / 工具调用阶段 / 生成结果,细粒度推送给 SSE。
 */
export async function streamChat(
  input: ChatInput,
  runtime: Runtime,
  onProgress: (p: ChatProgress) => void,
  signal?: AbortSignal,
): Promise<ChatOutput> {
  onProgress({ type: 'start' });
  // sessionKey 而非 ephemeral:Runtime 按 sessionKey 维护对话历史,支持多轮
  const req = createRequest(input.message, { sessionKey: input.sessionId });

  const output: ChatOutput = { text: '', thinking: '' };
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
      // 音乐生成完成:按 toolCallId 取登记结果,推送 music 事件(前端渲染播放器)
      if (chunk.toolName === 'generate_music' && chunk.toolCallId) {
        const music = takeGeneration(chunk.toolCallId);
        if (music) onProgress({ type: 'music', music });
      }
    } else if (chunk.type === 'error') {
      throw new Error(chunk.content || '对话执行出错');
    }
  }

  if (!output.text.trim() && !output.thinking.trim()) {
    throw new Error('模型未生成内容,请重试或更换模型');
  }
  onProgress({ type: 'done' });
  return output;
}

// ─── Runtime 注册表:按 (provider, modelId, apiKey, modelslabKey) 缓存 ──

export interface RuntimeRegistry {
  /** 取(或首次构建并缓存)指定模型的 Runtime。模型不存在时抛错。 */
  get(provider: string, modelId: string, apiKey?: string, modelslabKey?: string): Runtime;
  /** 关闭所有缓存的 Runtime(优雅退出时调用) */
  closeAll(): Promise<void>;
}

/**
 * 创建 Runtime 注册表。模型在首次被选中时按需构建并缓存,
 * 避免每次请求重建,同时支持运行时切换模型。
 * 注:会话历史保存在 Runtime 内存中,切换模型(不同 Runtime)后原会话上下文不延续。
 */
export function createRuntimeRegistry(defaultModelslabKey?: string): RuntimeRegistry {
  const cache = new Map<string, Runtime>();
  return {
    get(provider, modelId, apiKey, modelslabKey) {
      const llmTag = apiKey ? `u:${createHash('sha256').update(apiKey).digest('hex').slice(0, 8)}` : 'env';
      // ModelsLab Key 影响工具绑定,需纳入缓存键
      const mlKey = modelslabKey || defaultModelslabKey;
      const mlTag = mlKey ? `ml:${createHash('sha256').update(mlKey).digest('hex').slice(0, 8)}` : 'ml:none';
      const cacheKey = `${provider}/${modelId}:${llmTag}:${mlTag}`;
      let runtime = cache.get(cacheKey);
      if (!runtime) {
        const { model, streamFn } = buildModel(provider, modelId, apiKey);
        runtime = createMusicRuntime(model, streamFn, mlKey);
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
