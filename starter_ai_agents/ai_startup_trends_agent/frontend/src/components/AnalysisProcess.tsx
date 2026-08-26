// starter_ai_agents/ai_startup_trends_agent/frontend/src/components/AnalysisProcess.tsx
// 分析过程面板:三阶段进度条(新闻收集 → 摘要整理 → 趋势分析,对齐源应用三 Agent 接力)
// + 工具调用时间线(徽标)+ 实时收集的文章摘要列表(save_article_summary 触发)。
import { useState } from 'react';
import type { AnalysisPhase, TrendRun } from '../api';

/** 工具名 → 展示图标 */
const TOOL_ICONS: Record<string, string> = {
  search_web: '🌐',
  fetch_url: '📖',
  save_article_summary: '📝',
};

/** 三阶段定义(索引即顺序) */
const PHASES: Array<{ key: AnalysisPhase; icon: string; label: string; hint: string }> = [
  { key: 'collect', icon: '📰', label: '新闻收集', hint: '多角度搜索领域动态/融资/市场分析' },
  { key: 'summarize', icon: '📝', label: '摘要整理', hint: '深读高价值文章并保存摘要' },
  { key: 'analyze', icon: '🚀', label: '趋势分析', hint: '识别趋势与潜在创业机会' },
];

interface AnalysisProcessProps {
  run: TrendRun | null;
}

export function AnalysisProcess({ run }: AnalysisProcessProps) {
  const [showThinking, setShowThinking] = useState(false);

  if (!run) {
    return <div className="process-empty">开始分析后,这里将实时展示三阶段进度、工具调用与文章摘要。</div>;
  }

  const phaseIdx = PHASES.findIndex((p) => p.key === run.phase);
  const doneCount = run.toolCalls.filter((t) => t.status === 'done').length;

  return (
    <div className="process">
      {/* 状态行 */}
      <div className="process-status">
        {run.done ? (
          run.error ? (
            <span className="status-line status-line--err">❌ {run.error}</span>
          ) : (
            <span className="status-line status-line--ok">✅ 分析完成 · {run.summaries.length} 篇文章摘要 · {doneCount} 次工具调用</span>
          )
        ) : (
          <span className="status-line">
            <span className="spinner" /> 分析进行中 · {doneCount}/{run.toolCalls.length} 次工具调用 · {run.summaries.length} 篇摘要
          </span>
        )}
      </div>

      {/* 三阶段进度条 */}
      <div className="phase-steps">
        {PHASES.map((p, i) => {
          const state = run.done && !run.error && i <= phaseIdx ? 'done' : i < phaseIdx ? 'done' : i === phaseIdx ? 'active' : 'pending';
          const busy = state === 'active' && !run.done;
          return (
            <div key={p.key} className={`phase-step phase-step--${state}`}>
              <span className="phase-step__icon">
                {busy ? <span className="spinner spinner--sm" /> : state === 'done' ? '✓' : p.icon}
              </span>
              <div className="phase-step__text">
                <span className="phase-step__label">{p.label}</span>
                <span className="phase-step__hint">{p.hint}</span>
              </div>
            </div>
          );
        })}
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

      {/* 文章摘要收集 */}
      {run.summaries.length > 0 && (
        <div className="process-section">
          <div className="process-section__title">文章摘要({run.summaries.length})</div>
          <ul className="summary-list">
            {run.summaries.map((s, i) => (
              <li key={i} className="summary-item">
                <div className="summary-item__title">
                  {i + 1}. {s.title}
                </div>
                <div className="summary-item__text">{s.summary}</div>
                {s.source !== '未注明' && (
                  <a
                    className="summary-item__source"
                    href={/^https?:\/\//.test(s.source) ? s.source : undefined}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {s.source.length > 70 ? `${s.source.slice(0, 67)}…` : s.source}
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
