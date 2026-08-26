// starter_ai_agents/ai_data_analysis_agent/frontend/src/components/ChatMessage.tsx
// 聊天消息气泡:user 右对齐;assistant 含思考链折叠 + 工具徽标
// + 正文分段渲染:```echarts 块 → ECharts 图表,Markdown 表格 → HTML 表格,其余等宽文本。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMsg } from '../api';
import { EChartBlock, parseEchartOption } from './EChartBlock';

/** 工具名 → 展示徽标 */
const TOOL_ICONS: Record<string, string> = {
  get_data_summary: '📋',
  query_data: '🔎',
};

/** 正文分段:text(普通文本/表格)或 echarts(图表 JSON) */
interface Segment {
  type: 'text' | 'echarts';
  content: string;
  /** echarts 块是否已闭合(流式中未闭合的块不渲染) */
  closed: boolean;
}

/** 提取 ```echarts 代码块(容忍流式中未闭合的块) */
function parseSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  const re = /```echarts[ \t]*\n?([\s\S]*?)(```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segments.push({ type: 'text', content: text.slice(last, m.index), closed: true });
    segments.push({ type: 'echarts', content: m[1], closed: m[2] === '```' });
    last = m.index + m[0].length;
    // 空匹配保护
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < text.length) segments.push({ type: 'text', content: text.slice(last), closed: true });
  return segments;
}

interface ChatMessageProps {
  msg: ChatMsg;
}

export function ChatMessage({ msg }: ChatMessageProps) {
  const [showThinking, setShowThinking] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const segments = useMemo(() => parseSegments(msg.text), [msg.text]);

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
          <span className="bubble__avatar">📊</span>
          {msg.toolCalls.length > 0 && (
            <div className="tool-badges">
              {msg.toolCalls.map((t, i) => (
                <span key={`${t.name}-${i}`} className={`tool-badge tool-badge--${t.status}`}>
                  {TOOL_ICONS[t.name] ?? '🛠'} {t.name}
                  {t.status === 'running' ? '…' : ' ✓'}
                </span>
              ))}
            </div>
          )}
        </div>

        {msg.thinking && (
          <div className="thinking-block">
            <button type="button" className="thinking-toggle" onClick={() => setShowThinking((v) => !v)}>
              {showThinking ? '▾' : '▸'} 思考链({msg.thinking.length} 字)
            </button>
            {showThinking && <pre className="thinking-body">{msg.thinking}</pre>}
          </div>
        )}

        <div className="bubble__body" ref={bodyRef}>
          {segments.length === 0 && !msg.done ? (
            <span className="status-line">
              <span className="spinner" />
              正在查询数据…
            </span>
          ) : (
            segments.map((seg, i) =>
              seg.type === 'echarts' ? (
                <EChartSegment key={i} raw={seg.content} closed={seg.closed} done={msg.done} />
              ) : (
                <MarkdownText key={i} text={seg.content} />
              ),
            )
          )}
          {!msg.done && msg.text && <span className="caret" />}
        </div>
      </div>
    </div>
  );
}

/** echarts 段:done + 闭合后解析渲染;流式中显示占位 */
function EChartSegment({ raw, closed, done }: { raw: string; closed: boolean; done: boolean }) {
  const { option, error } = useMemo(() => parseEchartOption(raw), [raw]);

  if (!closed || !done) {
    return (
      <div className="echart-placeholder">
        <span className="spinner" /> 图表生成中…
      </div>
    );
  }
  if (error || option == null) {
    return (
      <div className="echart-error">
        ⚠️ {error || '图表配置为空'}(模型输出的 JSON 不合法,可重试或换个问法)
      </div>
    );
  }
  return <EChartBlock option={option} />;
}

/** 轻量 Markdown 渲染:表格行(| 开头)→ HTML 表格,其余行等宽文本 */
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
      // 第一行为表头,第二行若为分隔行(|---|)则丢弃
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
