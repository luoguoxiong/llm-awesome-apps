// starter_ai_agents/ai_research_agent/frontend/src/components/ResearchProcess.tsx
// 研究过程面板(对齐源应用 openai_research_agent 的 "Research Process" 标签页):
// 工具调用时间线(徽标)+ 实时收集的事实列表(save_important_fact 触发)。
import { useState } from 'react';
import type { ResearchRun } from '../api';

/** 工具名 → 展示图标 */
const TOOL_ICONS: Record<string, string> = {
  search_web: '🌐',
  search_hackernews: '🟠',
  fetch_url: '📖',
  save_important_fact: '📌',
};

interface ResearchProcessProps {
  run: ResearchRun | null;
}

export function ResearchProcess({ run }: ResearchProcessProps) {
  const [showThinking, setShowThinking] = useState(false);

  if (!run) {
    return <div className="process-empty">开始研究后,这里将实时展示搜索、深读与事实收集过程。</div>;
  }

  const doneCount = run.toolCalls.filter((t) => t.status === 'done').length;

  return (
    <div className="process">
      {/* 状态行 */}
      <div className="process-status">
        {run.done ? (
          run.error ? (
            <span className="status-line status-line--err">❌ {run.error}</span>
          ) : (
            <span className="status-line status-line--ok">✅ 研究完成 · {run.facts.length} 条事实 · {doneCount} 次工具调用</span>
          )
        ) : (
          <span className="status-line">
            <span className="spinner" /> 研究进行中 · {doneCount}/{run.toolCalls.length} 次工具调用 · {run.facts.length} 条事实
          </span>
        )}
      </div>

      {/* 思考链(可折叠) */}
      {run.thinking && (
        <div className="thinking-block">
          <button type="button" className="thinking-toggle" onClick={() => setShowThinking((v) => !v)}>
            {showThinking ? '▾' : '▸'} 思考链({run.thinking.length} 字)
          </button>
          {showThinking && <pre className="thinking-body">{run.thinking}</pre>}
        </div>
      )}

      {/* 工具调用时间线 */}
      {run.toolCalls.length > 0 && (
        <div className="process-section">
          <div className="process-section__title">工具调用</div>
          <div className="tool-badges tool-badges--wrap">
            {run.toolCalls.map((t, i) => (
              <span key={`${t.name}-${i}`} className={`tool-badge tool-badge--${t.status}`}>
                {TOOL_ICONS[t.name] ?? '🛠'} {t.name}
                {t.status === 'running' ? '…' : ' ✓'}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 事实收集 */}
      {run.facts.length > 0 && (
        <div className="process-section">
          <div className="process-section__title">收集的事实({run.facts.length})</div>
          <ul className="fact-list">
            {run.facts.map((f, i) => (
              <li key={i} className="fact-item">
                <div className="fact-item__text">{f.fact}</div>
                {f.source !== '未注明' && (
                  <a className="fact-item__source" href={/^https?:\/\//.test(f.source) ? f.source : undefined} target="_blank" rel="noreferrer noopener">
                    {f.source.length > 70 ? `${f.source.slice(0, 67)}…` : f.source}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
