// starter_ai_agents/ai_finance_agent/frontend/src/components/ChatMessage.tsx
// 聊天消息气泡:user 右对齐;assistant 含思考链折叠 + 工具调用徽标 + Markdown 风格正文。
import { useEffect, useRef, useState } from 'react';
import type { ChatMsg } from '../api';

/** 工具名 → 展示徽标 */
const TOOL_ICONS: Record<string, string> = {
  get_stock_quote: '📈',
  get_stock_history: '📊',
  search_web: '🔍',
};

interface ChatMessageProps {
  msg: ChatMsg;
}

export function ChatMessage({ msg }: ChatMessageProps) {
  const [showThinking, setShowThinking] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

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
          {msg.text ? (
            <pre className="md-pre">{msg.text}</pre>
          ) : !msg.done ? (
            <span className="status-line">
              <span className="spinner" />
              正在查询行情 / 搜索资讯…
            </span>
          ) : null}
          {!msg.done && msg.text && <span className="caret" />}
        </div>
      </div>
    </div>
  );
}
