// starter_ai_agents/ai_insurance_advisor_agent/frontend/src/components/ReportPanel.tsx
// Agent 流式报告面板:工具调用徽标 + 思考链折叠 + Markdown 报告渲染 + 下载。
import { useEffect, useRef, useState } from 'react';
import { Markdown } from './Markdown';
import type { ToolCallEntry } from '../api';

/** 工具名 → 展示徽标 */
const TOOL_ICONS: Record<string, string> = {
  compute_coverage: '🧮',
  search_web: '🔍',
};

export interface ReportState {
  text: string;
  thinking: string;
  toolCalls: ToolCallEntry[];
  done: boolean;
  error: string | null;
}

interface ReportPanelProps {
  report: ReportState;
  running: boolean;
  onStop: () => void;
}

export function ReportPanel({ report, running, onStop }: ReportPanelProps) {
  const [showThinking, setShowThinking] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 流式输出时自动滚动
  useEffect(() => {
    const el = bodyRef.current;
    if (el && !report.done) el.scrollTop = el.scrollHeight;
  }, [report.text, report.thinking, report.done]);

  const downloadReport = () => {
    const blob = new Blob([report.text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `保险保障建议报告_${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="card report-card">
      <div className="chat-head">
        <h2>Agent 保障建议报告</h2>
        <div className="chat-head__actions">
          {report.done && report.text && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={downloadReport}>
              ⬇ 下载 Markdown
            </button>
          )}
          {running && (
            <button type="button" className="btn btn--sm" onClick={onStop}>
              停止
            </button>
          )}
        </div>
      </div>

      {report.toolCalls.length > 0 && (
        <div className="tool-badges report-tool-badges">
          {report.toolCalls.map((t, i) => (
            <span key={`${t.name}-${i}`} className={`tool-badge tool-badge--${t.status}`}>
              {TOOL_ICONS[t.name] ?? '🛠'} {t.name}
              {t.status === 'running' ? '…' : ' ✓'}
            </span>
          ))}
        </div>
      )}

      {report.thinking && (
        <div className="thinking-block">
          <button type="button" className="thinking-toggle" onClick={() => setShowThinking((v) => !v)}>
            {showThinking ? '▾' : '▸'} 思考链({report.thinking.length} 字)
          </button>
          {showThinking && <pre className="thinking-body">{report.thinking}</pre>}
        </div>
      )}

      <div className="report-body" ref={bodyRef}>
        {report.text ? (
          <>
            <Markdown text={report.text} />
            {!report.done && <span className="caret" />}
          </>
        ) : running ? (
          <span className="status-line">
            <span className="spinner" />
            正在计算保额 / 检索定期寿险产品…
          </span>
        ) : report.error ? (
          <div className="error-text">{report.error}</div>
        ) : (
          <p className="status">
            提交客户资料后,Agent 会先调用确定性保额计算工具,再检索当地定期寿险产品,最后生成结构化保障建议报告。
          </p>
        )}
      </div>
    </section>
  );
}
