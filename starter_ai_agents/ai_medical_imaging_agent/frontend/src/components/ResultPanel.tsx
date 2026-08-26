// starter_ai_agents/ai_medical_imaging_agent/frontend/src/components/ResultPanel.tsx
// 诊断报告面板：思考链（可折叠）+ 工具调用徽标 + Markdown 报告流式渲染 + 免责声明。
import { useEffect, useRef, useState } from 'react';
import type { ToolCallEntry } from '../api';
import { Markdown } from './Markdown';

interface ResultPanelProps {
  phase: 'idle' | 'processing' | 'running' | 'done';
  text: string;
  thinking: string;
  toolCalls: ToolCallEntry[];
  error: string | null;
}

export function ResultPanel({ phase, text, thinking, toolCalls, error }: ResultPanelProps) {
  const [showThinking, setShowThinking] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 流式输出时自动滚动到底部
  useEffect(() => {
    const el = bodyRef.current;
    if (el && phase === 'running') el.scrollTop = el.scrollHeight;
  }, [text, thinking, phase]);

  const hasResult = text || thinking || toolCalls.length > 0;

  return (
    <section className={`card result-card ${error ? 'card--error' : ''}`}>
      <div className="result-head">
        <h2>{phase === 'done' && !error ? '✅ 诊断报告' : '4 · 诊断报告'}</h2>
        <div className="tool-badges">
          {toolCalls.map((t, i) => (
            <span key={`${t.name}-${i}`} className={`tool-badge tool-badge--${t.status}`}>
              🔍 {t.name}
              {t.status === 'running' ? '…' : ' ✓'}
            </span>
          ))}
        </div>
      </div>

      {thinking && (
        <div className="thinking-block">
          <button type="button" className="thinking-toggle" onClick={() => setShowThinking((v) => !v)}>
            {showThinking ? '▾' : '▸'} 思考链（{thinking.length} 字）
          </button>
          {showThinking && <pre className="thinking-body">{thinking}</pre>}
        </div>
      )}

      {error && <pre className="error-text">{error}</pre>}

      {!error && (
        <div className="result-body" ref={bodyRef}>
          {text ? (
            <>
              <Markdown text={text} />
              {phase === 'running' && <span className="caret" />}
            </>
          ) : phase === 'running' || phase === 'processing' ? (
            <span className="status-line">
              <span className="spinner" />
              {phase === 'processing' ? '正在预处理影像文件…' : '模型分析中，先读片，再检索医学文献撰写报告…'}
            </span>
          ) : hasResult ? null : (
            <span className="placeholder">上传医学影像并点击「开始分析」后，诊断报告将在此流式生成</span>
          )}
        </div>
      )}

      {text && phase === 'done' && !error && (
        <p className="disclaimer-note">
          ⚠️ 本报告由 AI 生成，仅供教育与参考，不能替代执业医师诊断；请务必由专业医疗人员复核后再做任何医疗决策。
        </p>
      )}
    </section>
  );
}
