// starter_ai_agents/ai_multimodal_agent/frontend/src/components/ResultPanel.tsx
// 分析结果面板:思考链(可折叠)+ 工具调用徽标 + 正文流式渲染。
import { useEffect, useRef, useState } from 'react';
import type { ToolCallEntry } from '../api';

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
        <h2>{phase === 'done' && !error ? '✅ 分析结果' : '4 · 分析结果'}</h2>
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
            {showThinking ? '▾' : '▸'} 思考链({thinking.length} 字)
          </button>
          {showThinking && <pre className="thinking-body">{thinking}</pre>}
        </div>
      )}

      {error && <pre className="error-text">{error}</pre>}

      {!error && (
        <div className="result-body" ref={bodyRef}>
          {text ? (
            <pre>{text}</pre>
          ) : phase === 'running' || phase === 'processing' ? (
            <span className="status-line">
              <span className="spinner" />
              {phase === 'processing' ? '正在预处理媒体文件…' : '模型分析中,先观察图片,再结合 web 搜索作答…'}
            </span>
          ) : hasResult ? null : (
            <span className="placeholder">上传图片/视频并提问后,分析结果将在此流式展示</span>
          )}
          {phase === 'running' && text && <span className="caret" />}
        </div>
      )}
    </section>
  );
}
