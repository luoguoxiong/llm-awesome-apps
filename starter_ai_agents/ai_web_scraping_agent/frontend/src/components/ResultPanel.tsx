// starter_ai_agents/ai_web_scraping_agent/frontend/src/components/ResultPanel.tsx
// 抽取结果面板:思考链(可折叠)+ 工具调用徽标 + 正文流式渲染
// + 完成后自动提取 JSON 代码块(格式化展示 + 一键复制)。
import { useEffect, useMemo, useRef, useState } from 'react';
import { extractJsonBlock, type ToolCallEntry } from '../api';

interface ResultPanelProps {
  phase: 'idle' | 'running' | 'done';
  text: string;
  thinking: string;
  toolCalls: ToolCallEntry[];
  error: string | null;
}

export function ResultPanel({ phase, text, thinking, toolCalls, error }: ResultPanelProps) {
  const [showThinking, setShowThinking] = useState(false);
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 流式输出时自动滚动到底部
  useEffect(() => {
    const el = bodyRef.current;
    if (el && phase === 'running') el.scrollTop = el.scrollHeight;
  }, [text, thinking, phase]);

  // 完成后从输出中提取结构化 JSON(对齐源应用 SmartScraperGraph 的结构化输出)
  const extractedJson = useMemo(() => {
    if (phase !== 'done' || !text) return null;
    const raw = extractJsonBlock(text);
    if (!raw) return null;
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return null;
    }
  }, [phase, text]);

  const copyJson = async () => {
    if (!extractedJson) return;
    try {
      await navigator.clipboard.writeText(extractedJson);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用时忽略
    }
  };

  const hasResult = text || thinking || toolCalls.length > 0;

  return (
    <section className={`card result-card ${error ? 'card--error' : ''}`}>
      <div className="result-head">
        <h2>{phase === 'done' && !error ? '✅ 抽取结果' : '4 · 抽取结果'}</h2>
        <div className="tool-badges">
          {toolCalls.map((t, i) => (
            <span key={`${t.name}-${i}`} className={`tool-badge tool-badge--${t.status}`}>
              🕷️ {t.name}
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

      {extractedJson && (
        <div className="json-block">
          <div className="json-block__head">
            <span>📦 结构化数据(JSON)</span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void copyJson()}>
              {copied ? '✅ 已复制' : '📋 复制 JSON'}
            </button>
          </div>
          <pre className="json-body">{extractedJson}</pre>
        </div>
      )}

      {!error && (
        <div className="result-body" ref={bodyRef}>
          {text ? (
            <pre>{text}</pre>
          ) : phase === 'running' ? (
            <span className="status-line">
              <span className="spinner" />
              Agent 正在抓取网页并抽取结构化数据…
            </span>
          ) : hasResult ? null : (
            <span className="placeholder">输入 URL 与抽取指令后,结构化数据将在此流式展示</span>
          )}
          {phase === 'running' && text && <span className="caret" />}
        </div>
      )}
    </section>
  );
}
