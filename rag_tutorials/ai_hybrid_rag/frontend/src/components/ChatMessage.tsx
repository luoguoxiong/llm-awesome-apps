// rag_tutorials/ai_hybrid_rag/frontend/src/components/ChatMessage.tsx
// 聊天消息气泡：user 右对齐；assistant 含
//   - 阶段时间线（检索 → 评估 → 生成，流式中实时推进）
//   - 检索详情折叠面板（候选片段、双通道得分、相关性判定）
//   - 思考链折叠
//   - 正文分段渲染：Markdown 表格 → HTML 表格，其余等宽文本
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMsg } from '../api';

interface ChatMessageProps {
  msg: ChatMsg;
}

export function ChatMessage({ msg }: ChatMessageProps) {
  const [showThinking, setShowThinking] = useState(false);
  const [showRetrieval, setShowRetrieval] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 流式输出时自动滚动
  useEffect(() => {
    const el = bodyRef.current;
    if (el && !msg.done) el.scrollTop = el.scrollHeight;
  }, [msg.text, msg.thinking, msg.done]);

  if (msg.role === 'user') {
    return (
      <div className="chat-row chat-row--user">
        <div className="bubble bubble--user">
          <pre>{msg.text}</pre>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-row chat-row--assistant">
      <div className="bubble bubble--assistant">
        <div className="bubble__head">
          <span className="bubble__avatar">🔍</span>
          {msg.trace && <TraceTimeline trace={msg.trace} />}
        </div>

        {msg.trace && msg.trace.candidates.length > 0 && (
          <div className="retrieval-block">
            <button type="button" className="retrieval-toggle" onClick={() => setShowRetrieval((v) => !v)}>
              {showRetrieval ? '▾' : '▸'} 检索详情（{msg.trace.candidates.length} 个候选片段
              {msg.trace.graded === false ? '，评估降级' : ''}
              {msg.trace.relevantCount != null ? `，${msg.trace.relevantCount} 个相关` : ''}）
            </button>
            {showRetrieval && <RetrievalList trace={msg.trace} />}
          </div>
        )}

        {msg.thinking && (
          <div className="thinking-block">
            <button type="button" className="thinking-toggle" onClick={() => setShowThinking((v) => !v)}>
              {showThinking ? '▾' : '▸'} 思考链（{msg.thinking.length} 字）
            </button>
            {showThinking && <pre className="thinking-body">{msg.thinking}</pre>}
          </div>
        )}

        <div className="bubble__body" ref={bodyRef}>
          {msg.text.length === 0 && !msg.done ? (
            <span className="status-line">
              <span className="spinner" />
              {msg.trace ? traceHint(msg.trace) : '正在处理…'}
            </span>
          ) : (
            <MarkdownText text={msg.text} />
          )}
          {!msg.done && msg.text && <span className="caret" />}
        </div>
      </div>
    </div>
  );
}

/** 阶段时间线徽标 */
function TraceTimeline({ trace }: { trace: NonNullable<ChatMsg['trace']> }) {
  const stage = trace.stage;
  return (
    <div className="tool-badges">
      <span className={`tool-badge ${stage === 'searching' ? 'tool-badge--running' : 'tool-badge--done'}`}>
        🔎 混合检索{stage === 'searching' ? '…' : ' ✓'}
      </span>
      <span
        className={`tool-badge ${
          stage === 'grading' ? 'tool-badge--running' : hasGrade(trace) ? 'tool-badge--done' : 'tool-badge--skip'
        }`}
      >
        ⚖️ 相关性评估{stage === 'grading' ? '…' : hasGrade(trace) ? ' ✓' : ' —'}
      </span>
      <span className={`tool-badge ${stage === 'answering' ? 'tool-badge--running' : stage === 'done' ? 'tool-badge--done' : ''}`}>
        {trace.mode === 'fallback' ? '💡 通用知识兜底' : '📝 生成回答'}
        {stage === 'answering' ? '…' : stage === 'done' ? ' ✓' : ''}
      </span>
    </div>
  );
}

/** 是否已进入/跳过评估阶段（grade_done 已到达） */
function hasGrade(trace: NonNullable<ChatMsg['trace']>): boolean {
  return trace.graded != null || trace.stage === 'answering' || trace.stage === 'done';
}

function traceHint(trace: NonNullable<ChatMsg['trace']>): string {
  if (trace.stage === 'searching') return '正在混合检索（BM25 + 向量 → RRF 融合）…';
  if (trace.stage === 'grading') return '正在评估候选片段相关性…';
  return '正在生成回答…';
}

/** 检索详情列表：每个候选的来源、双通道得分与相关性判定 */
function RetrievalList({ trace }: { trace: NonNullable<ChatMsg['trace']> }) {
  return (
    <div className="retrieval-list">
      {trace.candidates.map((c) => (
        <div key={c.rank} className={`retrieval-item ${c.relevant === true ? 'retrieval-item--hit' : c.relevant === false ? 'retrieval-item--miss' : ''}`}>
          <div className="retrieval-item__head">
            <span className="retrieval-item__rank">#{c.rank}</span>
            <span className="retrieval-item__source" title={c.source}>
              {c.source}
            </span>
            <span className="retrieval-item__scores">
              RRF {c.score}
              {c.keywordScore != null ? ` · BM25 ${c.keywordScore}` : ''}
              {c.vectorScore != null ? ` · 向量 ${c.vectorScore}` : ''}
            </span>
            {c.relevant != null && (
              <span className={`retrieval-item__grade ${c.relevant ? 'retrieval-item__grade--yes' : 'retrieval-item__grade--no'}`}>
                {c.relevant ? '相关 ✓' : '不相关 ✗'}
              </span>
            )}
          </div>
          <div className="retrieval-item__preview">{c.preview}</div>
        </div>
      ))}
    </div>
  );
}

/** 轻量 Markdown 渲染：表格行（| 开头）→ HTML 表格，其余行等宽文本 */
function MarkdownText({ text }: { text: string }) {
  const blocks = useMemo(() => splitTableBlocks(text), [text]);
  return (
    <>
      {blocks.map((b, i) =>
        b.type === 'table' ? (
          <div className="table-wrap" key={i}>
            <table className="md-table">
              <thead>
                <tr>
                  {b.header.map((h, j) => (
                    <th key={j}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>
                    {r.map((c, k) => (
                      <td key={k}>{c}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <pre className="md-pre" key={i}>
            {b.text}
          </pre>
        ),
      )}
    </>
  );
}

type Block = { type: 'table'; header: string[]; rows: string[][] } | { type: 'text'; text: string };

/** 把文本切分为 表格块 / 文本块 */
function splitTableBlocks(text: string): Block[] {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: Block[] = [];
  let textBuf: string[] = [];
  let tableBuf: string[] = [];

  const flushText = () => {
    if (textBuf.length) {
      blocks.push({ type: 'text', text: textBuf.join('\n') });
      textBuf = [];
    }
  };
  const flushTable = () => {
    if (tableBuf.length) {
      const rows = tableBuf.map(parseTableRow).filter((r): r is string[] => r != null);
      // 第一行为表头，第二行若为分隔行（|---|）则丢弃
      const header = rows[0] ?? [];
      const rest = rows.length > 1 && rows[1].every((c) => /^:?-{2,}:?$/.test(c.trim())) ? rows.slice(2) : rows.slice(1);
      blocks.push({ type: 'table', header, rows: rest });
      tableBuf = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 2) {
      flushText();
      tableBuf.push(trimmed);
    } else {
      flushTable();
      textBuf.push(line);
    }
  }
  flushText();
  flushTable();
  return blocks;
}

/** 解析单行表格 "| a | b |" → ['a','b'] */
function parseTableRow(line: string): string[] | null {
  const inner = line.slice(1, -1);
  const cells: string[] = [];
  let cur = '';
  let escaped = false;
  for (const ch of inner) {
    if (escaped) {
      cur += ch;
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
    } else if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}
