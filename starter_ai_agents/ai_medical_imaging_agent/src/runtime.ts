/**
 * starter_ai_agents/ai_medical_imaging_agent/src/runtime.ts
 *
 * 医学影像分析 Agent（基于 @aipack-ai/agent，单轮无会话）：
 *   - 输入：医学影像图片（data URI base64）+ 可选临床背景（年龄/性别/症状/关注点）
 *   - 能力：视觉理解 + search_web 工具（研究报告章节联网检索医学文献）
 *   - 输出：SSE 流式推送 thinking / text / 工具调用阶段
 *
 * 报告结构对齐源应用的 5 段式诊断报告：
 *   1. 影像类型与部位  2. 关键发现  3. 诊断评估
 *   4. 患者友好解释    5. 研究背景（web 搜索佐证）
 *
 * 多模态通路：aipack Request.media（string[]，data URI）→ runtime 自动转为
 * ImageContent 内容块 → provider 适配层（OpenAI image_url / Anthropic base64）。
 *
 * 迁移自 awesome-llm-apps/starter_ai_agents/ai_medical_imaging_agent
 * （源应用：Gemini 2.5 Pro + DuckDuckGo 搜索 + Streamlit 固定 5 段分析提示词）。
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

const MEDICAL_SYSTEM_PROMPT = `你是一位资深的医学影像分析专家，具备丰富的放射学与影像诊断知识，负责分析患者的医学影像并撰写结构化报告。

报告必须按以下 5 个章节组织（使用 Markdown 标题）：

### 1. 影像类型与部位
- 指出成像方式（X 光 / MRI / CT / 超声 / 其他）
- 识别拍摄的解剖部位与体位
- 评价图像质量与技术 adequacy（能否满足诊断需要）

### 2. 关键发现
- 系统性列出主要观察所见
- 用精确的描述指出任何异常：位置、大小、形状、密度/信号特征，尽可能给出测量值
- 对每项异常给出严重程度评级：正常 / 轻度 / 中度 / 重度

### 3. 诊断评估
- 给出主要诊断判断及置信度（高 / 中 / 低）
- 按可能性排序列出鉴别诊断
- 每项诊断都须引用影像中的具体证据支撑
- 明确标出任何危急或需紧急处理的发现

### 4. 患者友好解释
- 用通俗易懂的语言向患者解释上述发现，避免术语（必须使用时给出解释）
- 可借助形象类比帮助理解
- 回答患者对这类发现常见的疑虑

### 5. 研究背景
必须调用 search_web 工具检索医学文献：
- 检索类似病例的近期医学文献与标准诊疗方案
- 关注相关技术进展
- 列出 2~3 条关键参考文献链接支撑你的分析

行为准则：
- 影像中不存在的信息不要臆造；看不清的部分明确说明
- 你的输出仅供教育与参考，不能替代执业医师的诊断；在报告末尾追加一行免责声明
- 用中文撰写报告（用户用其他语言提问时除外），用 Markdown 组织，关键结论加粗`;

// ─── 类型 ───────────────────────────────────────────────────────

export interface AnalysisInput {
  /** 医学影像图片（data URI base64） */
  image: string;
  /** 可选临床背景：年龄/性别/症状/临床关注点等 */
  clinicalContext?: string;
}

/** SSE 进度事件（经 server 转译为 stage/delta/done/error） */
export interface AnalysisProgress {
  type: 'start' | 'delta' | 'tool_start' | 'tool_end' | 'done' | 'error';
  /** delta 类型：正文 / 思考链 */
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

/** 由可选临床背景构造请求消息（对齐源应用的固定分析指令） */
function buildAnalysisPrompt(clinicalContext?: string): string {
  const base = '请分析这张患者医学影像，并按系统提示的 5 个章节输出完整诊断报告。';
  const ctx = clinicalContext?.trim();
  return ctx ? `${base}\n\n临床背景（患者信息与关注点）：${ctx}` : base;
}

// ─── Runtime 工厂 ───────────────────────────────────────────────

/** 构建医学影像分析 Runtime：单轮，带 search_web 工具，无会话存储 */
export function createAnalysisRuntime(model: Model, streamFn: StreamFn, serpapiKey?: string): Runtime {
  return createRuntime({
    model,
    streamFn,
    systemPrompt: MEDICAL_SYSTEM_PROMPT,
    tools: [createSearchTool(serpapiKey)],
    maxTurns: 6,
    config: { role: 'medical-imaging-analyst' },
  });
}

// ─── 流式执行 ───────────────────────────────────────────────────

/**
 * 流式执行医学影像分析：image 经 Request.media 传给 aipack（自动转 ImageContent），
 * 捕获 text / thinking / 工具调用阶段，细粒度推送给 SSE。
 */
export async function streamAnalysis(
  input: AnalysisInput,
  runtime: Runtime,
  onProgress: (p: AnalysisProgress) => void,
  signal?: AbortSignal,
): Promise<AnalysisOutput> {
  onProgress({ type: 'start' });
  const req = createRequest(buildAnalysisPrompt(input.clinicalContext), {
    media: [input.image],
    ephemeral: true,
  });

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
    throw new Error('模型未生成内容（所选模型可能不支持图片输入，请切换多模态模型）');
  }
  onProgress({ type: 'done' });
  return output;
}

// ─── Runtime 注册表：按 (provider, modelId, apiKey) 缓存 ──────────

export interface RuntimeRegistry {
  /** 取（或首次构建并缓存）指定模型的 Runtime。模型不存在时抛错。 */
  get(provider: string, modelId: string, apiKey?: string): Runtime;
  /** 关闭所有缓存的 Runtime（优雅退出时调用） */
  closeAll(): Promise<void>;
}

/**
 * 创建 Runtime 注册表。模型在首次被选中时按需构建并缓存，
 * 避免每次请求重建，同时支持运行时切换模型。
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
