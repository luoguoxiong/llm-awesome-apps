/**
 * starter_ai_agents/ai_breakup_recovery_agent/src/runtime.ts
 *
 * 分手恢复陪伴团队(基于 @aipack-ai/agent,四 Agent 顺序接力,单次请求无多轮会话):
 *   - therapist 🤗 共情陪伴师:接住情绪,验证感受,温柔安慰与鼓励
 *   - closure   ✍️ 告别仪式师:代写"不会寄出的信" + 情感释放练习 + 告别仪式
 *   - routine   📅 恢复计划师:7 天恢复挑战 + 自我关怀 + 社交媒体戒断 + 歌单
 *   - honesty   💪 毒舌真相官:直白复盘关系问题与成长机会(带 search_web 工具)
 *   - 输入:用户的感受文字(可选)+ 聊天截图(data URI base64,可选;两者至少一项)
 *   - 截图经 Request.media 传给每个 Agent(多模态模型可读取对话情绪语境)
 *
 * 迁移自 awesome-llm-apps/starter_ai_agents/ai_breakup_recovery_agent
 * (源应用:Agno + Gemini 2.0 Flash + Streamlit,四 Agent 依次执行各出一段)。
 */
import {
  createRuntime,
  createRequest,
  type Model,
  type StreamFn,
  type Runtime,
  type Tool,
} from '@aipack-ai/agent';
import { createSearchTool } from './tools/search.js';

// ─── Agent 定义 ───────────────────────────────────────────────────

export type AgentId = 'therapist' | 'closure' | 'routine' | 'honesty';

export interface AgentSpec {
  id: AgentId;
  /** 展示名(前端卡片标题,前后端约定一致) */
  title: string;
  emoji: string;
  systemPrompt: string;
  tools: Tool[];
  maxTurns: number;
  /** 面向用户处境的任务指令(源应用四段 prompt 的中文化) */
  buildUserPrompt: (story: string, hasMedia: boolean) => string;
}

const AGENTS: AgentSpec[] = [
  {
    id: 'therapist',
    title: '共情陪伴',
    emoji: '🤗',
    systemPrompt: `你是一位温暖的共情陪伴师,陪伴刚刚经历分手的用户。你的职责:
1. 先接住情绪:无条件接纳并验证用户此刻的感受,不评判、不说教、不急着给建议
2. 温柔的幽默:在合适时机用轻柔的幽默化解沉重,但不消解对方的痛苦
3. 分享可共鸣的经历:用"很多人在分手后也会…"的方式让用户知道自己并不孤单
4. 给出安慰与鼓励的话语,肯定用户值得被好好对待
5. 结合用户上传的聊天截图,理解对话中的情绪语境(如有)

语气温暖、口语化、有同理心;用 Markdown 组织回复,关键安抚句加粗。用中文回复(除非用户用其他语言)。`,
    tools: [],
    maxTurns: 1,
    buildUserPrompt: (story, hasMedia) => `请基于以下内容,给出共情的情感支持回复:
${story ? `用户的自述:${story}\n` : ''}${hasMedia ? '(用户上传了聊天截图,请结合截图中的对话理解情绪语境)\n' : ''}
回复请包含:
1. 对感受的验证与接纳
2. 温柔的安慰话语
3. 可共鸣的相似经历
4. 鼓励的话`,
  },
  {
    id: 'closure',
    title: '告别仪式',
    emoji: '✍️',
    systemPrompt: `你是一位"告别仪式"专家,帮助用户为这段关系好好画上句号。你的职责:
1. 代写 2-3 封"永远不会寄出的信":把没说出口的话、raw 而真实的情绪写下来(明知不寄出,只为释放)
2. 设计 3 个情感释放小练习(书写、撕毁、仪式感的动作等)
3. 提供 2-3 个有仪式感的告别仪式建议
4. 给出"向前走"的阶段性策略

信件用 Markdown 引用块呈现并加标题,语气真挚、不矫饰、不过度文艺。用中文回复(除非用户用其他语言)。`,
    tools: [],
    maxTurns: 1,
    buildUserPrompt: (story, hasMedia) => `请基于以下内容,帮助用户完成情感告别:
${story ? `用户的感受:${story}\n` : ''}${hasMedia ? '(用户上传了聊天截图,可从中提炼未说出口的话)\n' : ''}
请提供:
1. 2-3 封"不会寄出的信"模板(引用块 + 标题)
2. 3 个情感释放练习
3. 2-3 个告别仪式建议
4. 向前走的策略`,
  },
  {
    id: 'routine',
    title: '七天恢复计划',
    emoji: '📅',
    systemPrompt: `你是一位恢复计划师,为用户设计切实可行的 7 天分手恢复挑战。你的职责:
1. 第 1-7 天每天一个主题(如:允许悲伤日 / 断联日 / 自我关怀日 / 重连世界日 / 新尝试日…),难度渐进
2. 每天包含:一个小挑战 + 一项自我关怀任务 + 一句当日箴言
3. 给出社交媒体戒断策略(取关 / 静音 / App 限时等)
4. 推荐 8-12 首赋能歌单(给出歌名与歌手,风格多元)

计划要具体、可执行、贴合用户处境;优先用 Markdown 表格组织每日计划。用中文回复(除非用户用其他语言)。`,
    tools: [],
    maxTurns: 1,
    buildUserPrompt: (story, hasMedia) => `请基于以下内容,设计一份 7 天分手恢复计划:
${story ? `用户当前的状态:${story}\n` : ''}${hasMedia ? '(用户上传了聊天截图,可参考其中的相处模式调整计划)\n' : ''}
计划请包含:
1. 每日活动与挑战(表格)
2. 每日自我关怀任务
3. 社交媒体使用指南
4. 8-12 首提振心情的歌单`,
  },
  {
    id: 'honesty',
    title: '毒舌真相',
    emoji: '💪',
    systemPrompt: `你是一位"毒舌真相官",用直白、不粉饰的方式帮用户看清现实。你的职责:
1. 对这段关系给出客观、直接的复盘:哪里出了问题、为什么会走到分手
2. 指出用户叙述里可能的盲区与自我欺骗(如美化回忆、过度自责、沉没成本谬误)
3. 给出成长机会:这次经历教会了什么、下次可以怎么做
4. 给出立刻行动的步骤

语言可以犀利,但必须基于事实、有建设性,不为刻薄而刻薄。
需要佐证观点时(分手恢复期研究、关系心理学等)可调用 search_web 搜索客观依据。
用 Markdown 组织回复,关键结论加粗。用中文回复(除非用户用其他语言)。`,
    tools: [],
    maxTurns: 4,
    buildUserPrompt: (story, hasMedia) => `请基于以下内容,给出直白、客观的反馈:
${story ? `用户的情况:${story}\n` : ''}${hasMedia ? '(用户上传了聊天截图,请从中客观分析对话暴露的问题)\n' : ''}
反馈请包含:
1. 对关系的客观分析
2. 用户的盲区与成长机会
3. 对未来的展望
4. 可立刻行动的步骤`,
  },
];

// ─── 类型 ─────────────────────────────────────────────────────────

export interface RecoveryInput {
  /** 用户感受自述(可为空,与截图至少一项) */
  story: string;
  /** 聊天截图(data URI base64) */
  media: string[];
}

/** SSE 进度事件(经 server 转译为 stage/delta/error) */
export interface RecoveryProgress {
  type: 'start' | 'agent_start' | 'delta' | 'tool_start' | 'tool_end' | 'agent_end' | 'done' | 'error';
  /** 事件归属的 Agent */
  agent?: AgentId;
  /** delta 类型:正文 / 思考链 */
  kind?: 'text' | 'thinking';
  /** delta 增量文本 */
  delta?: string;
  /** tool_start / tool_end 时的工具名 */
  toolName?: string;
  /** error 时的错误信息 */
  message?: string;
}

export interface AgentOutput {
  text: string;
  thinking: string;
}

export type RecoveryOutput = Record<AgentId, AgentOutput>;

// ─── 流式执行 ─────────────────────────────────────────────────────

/**
 * 流式执行一次完整的恢复陪伴:四 Agent 顺序接力,每个 Agent 的
 * text / thinking / 工具调用事件都携带 agent 标识,细粒度推送给 SSE。
 * 每次请求新建 Runtime(一次性任务,对齐源应用流程),结束即关闭。
 */
export async function streamRecoveryTeam(
  input: RecoveryInput,
  model: Model,
  streamFn: StreamFn,
  serpapiKey: string | undefined,
  onProgress: (p: RecoveryProgress) => void,
  signal?: AbortSignal,
): Promise<RecoveryOutput> {
  const story = input.story.trim();
  const hasMedia = input.media.length > 0;
  const output: RecoveryOutput = {
    therapist: { text: '', thinking: '' },
    closure: { text: '', thinking: '' },
    routine: { text: '', thinking: '' },
    honesty: { text: '', thinking: '' },
  };

  onProgress({ type: 'start' });

  for (const spec of AGENTS) {
    if (signal?.aborted) throw new Error('aborted');
    onProgress({ type: 'agent_start', agent: spec.id });

    // 毒舌真相官挂载 search_web 工具(源应用仅该 Agent 带 DuckDuckGoTools)
    const tools = spec.id === 'honesty' ? [createSearchTool(serpapiKey)] : [];
    const runtime: Runtime = createRuntime({
      model,
      streamFn,
      systemPrompt: spec.systemPrompt,
      tools,
      maxTurns: spec.maxTurns,
      config: { role: spec.id },
    });

    try {
      const req = createRequest(spec.buildUserPrompt(story, hasMedia), {
        media: input.media,
        ephemeral: true,
      });

      for await (const chunk of runtime.stream(req)) {
        if (signal?.aborted) throw new Error('aborted');
        if (chunk.type === 'text' && chunk.content) {
          output[spec.id].text += chunk.content;
          onProgress({ type: 'delta', agent: spec.id, kind: 'text', delta: chunk.content });
        } else if (chunk.type === 'thinking' && chunk.content) {
          output[spec.id].thinking += chunk.content;
          onProgress({ type: 'delta', agent: spec.id, kind: 'thinking', delta: chunk.content });
        } else if (chunk.type === 'tool_start' && chunk.toolName) {
          onProgress({ type: 'tool_start', agent: spec.id, toolName: chunk.toolName });
        } else if (chunk.type === 'tool_end' && chunk.toolName) {
          onProgress({ type: 'tool_end', agent: spec.id, toolName: chunk.toolName });
        } else if (chunk.type === 'error') {
          throw new Error(chunk.content || `${spec.title}执行出错`);
        }
      }
    } finally {
      await runtime.close().catch(() => undefined);
    }

    onProgress({ type: 'agent_end', agent: spec.id });
  }

  const anyOutput = AGENTS.some((a) => output[a.id].text.trim() || output[a.id].thinking.trim());
  if (!anyOutput) {
    throw new Error('模型未生成任何内容,请重试或更换模型');
  }
  onProgress({ type: 'done' });
  return output;
}
