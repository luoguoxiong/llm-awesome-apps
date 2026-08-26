/**
 * starter_ai_agents/ai_insurance_advisor_agent/src/runtime.ts
 *
 * 人寿保险保障顾问 Agent(基于 @aipack-ai/agent,表单驱动单轮报告):
 *   - 输入:客户资料 JSON(前端表单组装)
 *   - 工具:compute_coverage(确定性保额计算) / search_web(定期寿险产品搜索)
 *   - 模式:ephemeral 单轮请求(源应用为表单提交 → 单次报告,无多轮对话)
 *
 * 迁移自 awesome-llm-apps/starter_ai_agents/ai_life_insurance_advisor_agent
 * (源应用:OpenAI GPT-5-mini + E2B 沙箱 run_python_code + Firecrawl 搜索;
 *  本实现以本地确定性 compute_coverage 工具替代 E2B(同一公式,免沙箱/免 Key)、
 *  四层降级 search_web 替代 Firecrawl,报告结构沿用源应用的
 *  保额结论/计算明细/产品参考/假设说明四段式,并改流式 Markdown 输出)。
 */
import {
  createRuntime,
  createRequest,
  type Model,
  type StreamFn,
  type Runtime,
} from '@aipack-ai/agent';
import { buildModel } from './config.js';
import { createCoverageTool } from './tools/coverage.js';
import { createSearchTool } from './tools/search.js';
import { createHash } from 'node:crypto';

// ─── 系统提示词 ─────────────────────────────────────────────────

const ADVISOR_SYSTEM_PROMPT = `你是一位保守稳健的人寿保险保障顾问(AI Insurance Advisor)。工作流程(严格遵守):
1. 收到客户资料后,必须先调用 compute_coverage 工具计算推荐保额——这是确定性数学工具,禁止自行心算或估算保额数字
2. 然后调用 search_web(1~2 次)搜索客户所在地区的定期寿险产品与市场信息,搜索词可结合保额区间(如 "定期寿险 中国 保额100万 2025")
3. 基于 1 的计算结果与 2 的搜索结果,输出中文 Markdown 报告,结构如下:
   ## 保障建议结论
   推荐保额(必须与 compute_coverage 结果完全一致)+ 2~3 句核心理由
   ## 计算明细
   Markdown 表格:年收入 / 收入替代年限 / 实际折现率 / 年金系数 / 折现收入替代需求 / 债务偿还需求 / 资产与已有保额抵扣 / 推荐保额,数字全部取自 compute_coverage 结果
   ## 定期寿险产品参考
   最多 3 个产品或购买渠道建议,来自 search_web 结果(名称/要点/链接/来源);若搜索不可用,明确说明"未能获取实时产品信息"并给出一般性选购建议,不得编造具体产品
   ## 假设与说明
   收入替代年限、实际折现率(默认 2%)、模型局限性(未考虑通胀外的教育专项费用等)
   报告末尾附一行免责声明:"本报告仅供教育参考,不构成持牌保险或财务建议,请与合格专业人士及保险公司核实。"
- 所有保额数字必须与工具结果一致,不得编造;金额展示时附货币单位
- 建议保守稳健,不推荐明显超出客户需求的保额
- 用中文撰写报告(客户资料中的地区/货币字段原样保留)`;

// ─── 类型 ───────────────────────────────────────────────────────

/** 客户资料(前端表单 → API body.profile) */
export interface ClientProfile {
  age: number;
  annual_income: number;
  dependents: number;
  location: string;
  total_debt: number;
  available_savings: number;
  existing_life_insurance: number;
  income_replacement_years: number;
  currency: string;
}

export interface AdviseInput {
  profile: ClientProfile;
}

/** SSE 进度事件(经 server 转译为 stage/delta/error) */
export interface AdviseProgress {
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

export interface AdviseOutput {
  text: string;
  thinking: string;
}

// ─── Runtime 工厂 ───────────────────────────────────────────────

/** 构建保障顾问 Runtime:单轮报告 + 计算/搜索两工具 */
export function createAdvisorRuntime(model: Model, streamFn: StreamFn, serpapiKey?: string): Runtime {
  return createRuntime({
    model,
    streamFn,
    systemPrompt: ADVISOR_SYSTEM_PROMPT,
    tools: [createCoverageTool(), createSearchTool(serpapiKey)],
    maxTurns: 8,
    config: { role: 'insurance-advisor' },
  });
}

// ─── 流式执行 ───────────────────────────────────────────────────

/** 组装发往 LLM 的客户资料提示词(对齐源应用的 user_prompt 拼装方式) */
function buildProfilePrompt(profile: ClientProfile): string {
  const payload = {
    ...profile,
    request_timestamp: new Date().toISOString(),
  };
  return (
    '你将收到一份客户资料 JSON。请按工作流程先调用 compute_coverage 计算推荐保额,' +
    '再调用 search_web 检索客户所在地区的定期寿险产品,最后产出结构化保障建议报告。\n' +
    `客户资料 JSON: ${JSON.stringify(payload)}`
  );
}

/**
 * 流式执行一次保障建议生成:ephemeral 单轮(无会话历史),
 * 捕获 text / thinking / 工具调用阶段,细粒度推送给 SSE。
 */
export async function streamAdvise(
  input: AdviseInput,
  runtime: Runtime,
  onProgress: (p: AdviseProgress) => void,
  signal?: AbortSignal,
): Promise<AdviseOutput> {
  onProgress({ type: 'start' });
  // ephemeral(无 sessionKey):表单驱动的单轮报告任务,不保留会话历史
  const req = createRequest(buildProfilePrompt(input.profile), { ephemeral: true });

  const output: AdviseOutput = { text: '', thinking: '' };
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
      throw new Error(chunk.content || '报告生成出错');
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
export function createRuntimeRegistry(serpapiKey?: string): RuntimeRegistry {
  const cache = new Map<string, Runtime>();
  return {
    get(provider, modelId, apiKey) {
      const keyTag = apiKey ? `u:${createHash('sha256').update(apiKey).digest('hex').slice(0, 8)}` : 'env';
      const cacheKey = `${provider}/${modelId}:${keyTag}`;
      let runtime = cache.get(cacheKey);
      if (!runtime) {
        const { model, streamFn } = buildModel(provider, modelId, apiKey);
        runtime = createAdvisorRuntime(model, streamFn, serpapiKey);
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
