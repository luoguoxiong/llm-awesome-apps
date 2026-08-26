// starter_ai_agents/ai_reasoning_agent/frontend/src/components/ComparePanel.tsx
// 对比双栏之一:状态头 + 思考链(可折叠,仅推理侧)+ 正文 <pre> 逐字流式渲染。
import { useEffect, useRef, useState } from 'react';
import type { AgentSide, StageStatus } from '../api';

interface ComparePanelProps {
  side: AgentSide;
  emoji: string;
  title: string;
  /** 当前选中模型的可读名(如 DeepSeek Reasoner) */
  modelLabel: string;
  status: StageStatus;
  text: string;
  thinking: string;
}

export function ComparePanel({ side, emoji, title, modelLabel, status, text, thinking }: ComparePanelProps) {
  const bodyRef = useRef<HTMLPreElement>(null);
  const thinkingRef = useRef<HTMLPreElement>(null);
  // 思考链默认展开,流式观看推理过程;用户可手动折叠
  const [thinkingOpen, setThinkingOpen] = useState(true);

  // 生成中自动滚动到底部
  useEffect(() => {
    if (status === 'active' && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [text, status]);

  useEffect(() => {
    if (status === 'active' && thinkingOpen && thinkingRef.current) {
      thinkingRef.current.scrollTop = thinkingRef.current.scrollHeight;
    }
  }, [thinking, status, thinkingOpen]);

  return (
    <section className={`card panel-card panel-card--${side} panel-card--${status}`} data-side={side}>
      <div className="panel-head">
        <span className="panel-emoji">{emoji}</span>
        <div className="panel-head-text">
          <h2 className="panel-title">{title}</h2>
          <span className="panel-model">{modelLabel}</span>
        </div>
        <span className={`panel-status panel-status--${status}`}>
          {status === 'done' ? '✓ 完成' : status === 'active' ? '生成中…' : '待开始'}
        </span>
      </div>

      {thinking ? (
        <div className="thinking">
          <button type="button" className="thinking-toggle" onClick={() => setThinkingOpen((v) => !v)}>
            <span className="thinking-arrow">{thinkingOpen ? '▾' : '▸'}</span>
            🧩 思考链
            <span className="thinking-count">{thinking.length} 字符</span>
          </button>
          {thinkingOpen ? (
            <pre ref={thinkingRef} className="thinking-body">
              {thinking}
            </pre>
          ) : null}
        </div>
      ) : null}

      {text ? (
        <pre ref={bodyRef} className="panel-body">
          {text}
        </pre>
      ) : (
        <p className="panel-placeholder">{status === 'pending' ? '等待开始…' : '准备中…'}</p>
      )}
    </section>
  );
}
