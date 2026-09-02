/**
 * rag_tutorials/ai_hybrid_rag/src/pipeline.ts
 *
 * 问答编排（对应源应用的完整链路）：
 *   1. 混合检索：BM25 关键词 + TF-IDF 向量双通道 → RRF 融合取候选
 *   2. LLM 相关性重排：Grader 逐片段评估 yes/no（等价 Cohere Reranker /
 *      ai_blog_search 的 grade_documents）；评估失败时降级用融合分数
 *   3. 回答：有相关片段 → RAG 上下文流式作答；无相关片段 → 通用知识兜底
 *      （等价源应用 handle_fallback 的 Claude 直答）
 *
 * 多轮对话：服务端内存维护 sessionId → 问答历史，每轮把最近历史 +
 * 本轮上下文编排成单次 ephemeral 请求（与源应用 formatted_messages 一致）。
 */
import { createRequest, type Runtime } from '@aipack-ai/agent';
import type { HybridStore, SearchHit } from './hybrid.js';
import type { RuntimePair } from './runtime.js';

// ─── 类型 ─────────────────────────────────────────────────────────

/** 候选片段摘要（推送给前端展示检索细节） */
export interface CandidateInfo {
  rank: number;
  source: string;
  /** RRF 融合分数 */
  score: number;
  /** BM25 通道得分（未进该通道名次的片段为 null） */
  keywordScore: number | null;
  /** TF-IDF 向量通道得分（未进该通道名次的片段为 null） */
  vectorScore: number | null;
  /** 片段预览（前 160 字符） */
  preview: string;
  /** LLM 评估结果：true 相关 / false 不相关 / null 未评估 */
  relevant: boolean | null;
}

/** SSE 进度事件（经 server 转译为 stage/delta/error） */
export type ChatEvent =
  | { type: 'search_start' }
  | { type: 'search_done'; candidates: CandidateInfo[] }
  | { type: 'grade_start'; count: number }
  | { type: 'grade_done'; graded: boolean; relevantCount: number; candidates: CandidateInfo[] }
  | { type: 'answer_start'; mode: 'rag' | 'fallback'; contextCount: number }
  | { type: 'answer_delta'; kind: 'text' | 'thinking'; delta: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface PipelineParams {
  candidateK: number;
  contextK: number;
  rrfK: number;
  gradeEnabled: boolean;
}

export interface PipelineContext {
  store: HybridStore;
  runtimes: RuntimePair;
  params: PipelineParams;
}

export interface ChatInput {
  question: string;
  /** 最近问答历史（不含本轮），由 server 维护 */
  history: ChatTurn[];
}

/** 评估提示词中单个片段的截断长度 */
const GRADE_CHUNK_CHARS = 400;
/** 注入上下文的单片段截断长度 */
const CONTEXT_CHUNK_CHARS = 1600;
/** 历史轮数上限（避免请求过长） */
const MAX_HISTORY_TURNS = 3;

// ─── 主流程 ───────────────────────────────────────────────────────

/**
 * 执行完整问答链路：混合检索 → 相关性重排 → 流式回答。
 * 通过 onEvent 把阶段事件推送给 SSE；signal 用于客户端断开时中止。
 * 返回完整回答文本（含 thinking 不计入回答）。
 */
export async function answerQuestion(
  input: ChatInput,
  ctx: PipelineContext,
  onEvent: (e: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<string> {
  const question = input.question.trim();
  if (!question) throw new Error('问题不能为空');
  const { store, runtimes, params } = ctx;

  // ── 阶段 1：混合检索（BM25 + TF-IDF → RRF）───────────────────
  onEvent({ type: 'search_start' });
  const hits = store.hybridSearch(question, params.candidateK, params.rrfK);
  const candidates: CandidateInfo[] = hits.map((h, i) => toCandidate(h, i));
  onEvent({ type: 'search_done', candidates });
  if (signal?.aborted) throw new Error('aborted');

  // ── 阶段 2：LLM 相关性重排（可关；失败降级用融合名次）─────────
  let relevantHits: SearchHit[];
  if (params.gradeEnabled && hits.length > 0) {
    onEvent({ type: 'grade_start', count: hits.length });
    let graded: number[] | null;
    try {
      graded = await gradeCandidates(runtimes.grader, question, hits, signal);
    } catch (err) {
      // 评估失败（模型错误/断开）→ 降级：直接用融合名次
      if (signal?.aborted) throw new Error('aborted');
      console.warn('[pipeline] 相关性评估失败，降级用融合名次:', (err as Error).message);
      graded = null;
    }
    if (graded) {
      const gradedSet = new Set(graded);
      candidates.forEach((c) => {
        c.relevant = gradedSet.has(c.rank);
      });
      relevantHits = hits.filter((_, i) => gradedSet.has(i + 1));
      onEvent({ type: 'grade_done', graded: true, relevantCount: relevantHits.length, candidates });
    } else {
      relevantHits = hits.slice(0, params.contextK);
      onEvent({ type: 'grade_done', graded: false, relevantCount: relevantHits.length, candidates });
    }
  } else {
    relevantHits = hits.slice(0, params.contextK);
    if (hits.length > 0) {
      onEvent({ type: 'grade_done', graded: false, relevantCount: relevantHits.length, candidates });
    }
  }
  if (signal?.aborted) throw new Error('aborted');

  // ── 阶段 3：流式回答（RAG / 通用知识兜底）─────────────────────
  const mode: 'rag' | 'fallback' = relevantHits.length > 0 ? 'rag' : 'fallback';
  onEvent({ type: 'answer_start', mode, contextCount: relevantHits.length });
  const message = composeMessage(question, input.history, mode === 'rag' ? relevantHits : []);
  const answer = await streamAnswer(runtimes.answer, message, onEvent, signal);
  onEvent({ type: 'done' });
  return answer;
}

// ─── 相关性评估 ───────────────────────────────────────────────────

/**
 * LLM 逐片段评估相关性：把问题 + 编号片段交给 Grader，解析「编号:yes」行。
 * 返回相关片段的编号数组（1 起）；解析失败返回 null（调用方降级）。
 */
async function gradeCandidates(
  grader: Runtime,
  question: string,
  hits: SearchHit[],
  signal?: AbortSignal,
): Promise<number[] | null> {
  const parts: string[] = [`用户问题：${question}`, '', '候选文档片段：'];
  hits.forEach((h, i) => {
    const preview = h.text.length > GRADE_CHUNK_CHARS ? h.text.slice(0, GRADE_CHUNK_CHARS) + '…' : h.text;
    parts.push(`--- 片段 ${i + 1}（来源：${h.source}）---`, preview, '');
  });
  parts.push('请逐片段评估相关性（每行一个，格式「编号:yes」或「编号:no」）。');

  // ephemeral 不落盘，避免轮询会话累积
  const result = await grader.run(createRequest(parts.join('\n'), { ephemeral: true }));
  if (signal?.aborted) throw new Error('aborted');
  if (!result.success) {
    throw new Error(result.error || '相关性评估失败');
  }

  // 解析输出：容忍多余标点/空白/代码块包裹
  const relevant: number[] = [];
  const seen = new Set<number>();
  for (const m of result.content.matchAll(/(\d+)\s*[:：]\s*(yes|no)/gi)) {
    const idx = parseInt(m[1], 10);
    const ok = m[2].toLowerCase() === 'yes';
    if (ok && idx >= 1 && idx <= hits.length && !seen.has(idx)) {
      seen.add(idx);
      relevant.push(idx);
    }
  }
  if (seen.size === 0 && !/yes|no/i.test(result.content)) {
    return null; // 完全无法解析 → 降级
  }
  return relevant;
}

// ─── 消息编排 ─────────────────────────────────────────────────────

/**
 * 把历史 + 参考片段 + 问题编排为单次请求消息（等价源应用的
 * formatted_messages + RAG_SYSTEM_PROMPT 组合）。
 */
function composeMessage(question: string, history: ChatTurn[], contextHits: SearchHit[]): string {
  const parts: string[] = [];

  if (history.length > 0) {
    parts.push('[对话历史]');
    for (const turn of history.slice(-MAX_HISTORY_TURNS * 2)) {
      parts.push(`${turn.role === 'user' ? '用户' : '助手'}：${turn.content}`);
    }
    parts.push('');
  }

  if (contextHits.length > 0) {
    parts.push('[参考片段]');
    contextHits.forEach((h, i) => {
      const text = h.text.length > CONTEXT_CHUNK_CHARS ? h.text.slice(0, CONTEXT_CHUNK_CHARS) + '…' : h.text;
      parts.push(`--- 片段 ${i + 1}（来源：${h.source}）---`, text, '');
    });
  } else {
    parts.push('[本次未检索到与问题相关的知识库文档，请基于通用知识回答]', '');
  }

  parts.push('[用户问题]', question);
  return parts.join('\n');
}

// ─── 流式回答 ─────────────────────────────────────────────────────

/** 流式生成回答：增量推送 text / thinking，返回完整正文 */
async function streamAnswer(
  answer: Runtime,
  message: string,
  onEvent: (e: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<string> {
  const req = createRequest(message, { ephemeral: true });
  let answerText = '';
  let thinkingText = '';
  for await (const chunk of answer.stream(req)) {
    if (signal?.aborted) throw new Error('aborted');
    if (chunk.type === 'text' && chunk.content) {
      answerText += chunk.content;
      onEvent({ type: 'answer_delta', kind: 'text', delta: chunk.content });
    } else if (chunk.type === 'thinking' && chunk.content) {
      thinkingText += chunk.content;
      onEvent({ type: 'answer_delta', kind: 'thinking', delta: chunk.content });
    } else if (chunk.type === 'error') {
      throw new Error(chunk.content || '生成回答时出错');
    }
  }
  if (!answerText.trim() && !thinkingText.trim()) {
    throw new Error('模型未生成内容，请重试或更换模型');
  }
  return answerText;
}

// ─── 工具 ─────────────────────────────────────────────────────────

/** SearchHit（融合名次 i+1）→ 前端候选摘要 */
function toCandidate(h: SearchHit, index: number): CandidateInfo {
  return {
    rank: index + 1,
    source: h.source,
    score: round(h.score),
    keywordScore: h.keywordScore != null ? round(h.keywordScore) : null,
    vectorScore: h.vectorScore != null ? round(h.vectorScore) : null,
    preview: h.text.length > 160 ? h.text.slice(0, 160) + '…' : h.text,
    relevant: null,
  };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}
