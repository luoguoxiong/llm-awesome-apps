// starter_ai_agents/ai_breakup_recovery_agent/frontend/src/components/AgentCard.tsx
// 单个 Agent 的结果卡片:标题(emoji + 名称 + 副标题)+ 状态徽标 +
// 工具调用条目 + 流式 Markdown 正文。
import { type ReactNode } from 'react';
import { Markdown } from './Markdown';
import type { AgentId, ToolCallEntry } from '../api';

export interface AgentCardState {
  status: 'pending' | 'running' | 'done';
  text: string;
  thinking: string;
  toolCalls: ToolCallEntry[];
}

interface AgentCardProps {
  id: AgentId;
  emoji: string;
  title: string;
  subtitle: string;
  state: AgentCardState;
  /** 全局运行中(父组件 phase === 'running') */
  active: boolean;
}

export function AgentCard({ id, emoji, title, subtitle, state, active }: AgentCardProps): ReactNode {
  const { status, text, thinking, toolCalls } = state;
  const started = status !== 'pending';

  return (
    <section className={`card agent-card agent-card--${id} agent-card--${status}`}>
      <header className="agent-card__head">
        <span className="agent-card__emoji">{emoji}</span>
        <div className="agent-card__titles">
          <h3 className="agent-card__title">{title}</h3>
          <p className="agent-card__sub">{subtitle}</p>
        </div>
        <span className={`agent-badge agent-badge--${status}`}>
          {status === 'pending' && (active ? '排队中' : '待开始')}
          {status === 'running' && '陪伴中…'}
          {status === 'done' && '已完成'}
        </span>
      </header>

      {toolCalls.length > 0 && (
        <div className="tool-chips">
          {toolCalls.map((t, i) => (
            <span key={i} className={`tool-chip tool-chip--${t.status}`}>
              {t.status === 'running' ? '⏳' : '✓'} {t.name}
            </span>
          ))}
        </div>
      )}

      {thinking && <details className="thinking-details">
        <summary>思考过程</summary>
        <pre className="thinking-pre">{thinking}</pre>
      </details>}

      {started ? (
        <div className="agent-card__body">
          {text ? (
            <Markdown text={text} />
          ) : (
            <p className="agent-card__placeholder">
              {status === 'running' ? '正在倾听与构思…' : '（本段无输出）'}
            </p>
          )}
        </div>
      ) : (
        <p className="agent-card__placeholder agent-card__placeholder--idle">点击「开始陪伴」后,这里会出现 TA 的回应</p>
      )}
    </section>
  );
}
