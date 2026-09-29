// foreign_trade_apps/ai_trade_lead_agent/frontend/src/components/PipelinePanel.tsx
// 获客流水线过程面板(左栏):
//   ① 五阶段步骤条(ImportYeti 找进口商 → 供应商核验 → 官网/联系人 → AI 分析 → AI 开发信)
//   ② 工具调用徽标时间线
//   ③ 候选进口商清单(含采购判定徽标)
//   ④ 阶段日志(流式,可折叠)
import { useState } from 'react';
import type { LeadRun, PipelineStage } from '../api';

const STAGE_ORDER: { key: PipelineStage; title: string; icon: string }[] = [
  { key: 'importers', title: 'ImportYeti 找美国进口商', icon: '🔎' },
  { key: 'verify', title: '查供应商 · 判断是否在采购', icon: '🏭' },
  { key: 'contacts', title: 'Google / LinkedIn 找联系人', icon: '📇' },
  { key: 'analysis', title: 'AI 分析客户', icon: '📊' },
  { key: 'email', title: 'AI 生成个性化开发信', icon: '✉️' },
];

/** 工具名 → 展示图标 */
const TOOL_ICONS: Record<string, string> = {
  search_importyeti: '🛃',
  lookup_importer_suppliers: '🏭',
  search_web: '🌐',
  fetch_url: '📖',
  save_importer: '🏢',
  save_verdict: '⚖️',
  save_contact: '📇',
};

const VERDICT_LABEL: Record<string, string> = {
  yes: '确认在采购',
  likely: '很可能在采购',
  unknown: '证据不足',
  no: '已排除',
};

interface PipelinePanelProps {
  run: LeadRun | null;
}

export function PipelinePanel({ run }: PipelinePanelProps) {
  const [showLog, setShowLog] = useState(true);

  if (!run) {
    return (
      <div className="process-empty">
        输入产品关键词后,这里将实时展示:ImportYeti 检索 → 供应商核验 → 联系人查找 → 客户分析 → 开发信生成的全过程。
      </div>
    );
  }

  const currentIdx = run.current ? STAGE_ORDER.findIndex((s) => s.key === run.current) : -1;
  const doneCount = run.toolCalls.filter((t) => t.status === 'done').length;
  const leads = run.order.map((id) => run.leads[id]).filter(Boolean);

  return (
    <div className="process">
      {/* 状态行 */}
      <div className="process-status">
        {run.done ? (
          run.error ? (
            <span className="status-line status-line--err">❌ {run.error}</span>
          ) : (
            <span className="status-line status-line--ok">
              ✅ 完成 · {leads.length} 家线索 · {doneCount} 次工具调用
            </span>
          )
        ) : (
          <span className="status-line">
            <span className="spinner" /> 进行中 · {doneCount}/{run.toolCalls.length} 次工具调用 · {leads.length} 家线索
          </span>
        )}
      </div>

      {/* 五阶段步骤条 */}
      <div className="stage-steps">
        {STAGE_ORDER.map((s, i) => {
          const status = run.done || (currentIdx >= 0 && i < currentIdx) ? 'done' : i === currentIdx ? 'active' : 'pending';
          return (
            <div key={s.key} className={`stage-step stage-step--${status}`}>
              <span className="stage-step__dot">{status === 'done' ? '✓' : s.icon}</span>
              <span className="stage-step__title">{s.title}</span>
            </div>
          );
        })}
      </div>

      {/* 工具调用 */}
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

      {/* 候选进口商 */}
      {leads.length > 0 && (
        <div className="process-section">
          <div className="process-section__title">候选进口商({leads.length})</div>
          <ul className="lead-mini-list">
            {leads.map((l) => (
              <li key={l.id} className="lead-mini">
                <span className="lead-mini__name">{l.name}</span>
                {l.verdict && (
                  <span className={`verdict-badge verdict-badge--${l.verdict}`}>{VERDICT_LABEL[l.verdict] ?? l.verdict}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 日志 */}
      {run.log && (
        <div className="process-section">
          <button type="button" className="thinking-toggle" onClick={() => setShowLog((v) => !v)}>
            {showLog ? '▾' : '▸'} 过程日志({run.log.length} 字)
          </button>
          {showLog && <pre className="thinking-body log-body">{run.log}</pre>}
        </div>
      )}
    </div>
  );
}
