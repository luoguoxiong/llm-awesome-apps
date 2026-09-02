// rag_tutorials/ai_rag_chain/frontend/src/components/ChatMessage.tsx
// 聊天消息气泡:user 右对齐;assistant 含检索引用片段(可折叠,展示来源与相似度)+ 流式正文。
import { useEffect, useRef, useState } from 'react';
import type { ChatMsg } from '../api';

interface ChatMessageProps {
  msg: ChatMsg;
}

export function ChatMessage({ msg }: ChatMessageProps) {
  const [showSources, setShowSources] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 流式输出时自动滚动
  useEffect(() => {
    const el = bodyRef.current;
    if (el && !msg.done) el.scrollTop = el.scrollHeight;
  }, [msg.text, msg.done]);

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
          <span className="bubble__avatar">📚</span>
          {msg.sources.length > 0 && (
            <button
              type="button"
              className="sources-toggle"
              onClick={() => setShowSources((v) => !v)}
            >
              {showSources ? '▾' : '▸'} 检索引用 {msg.sources.length} 段
            </button>
          )}
        </div>

        {msg.sources.length > 0 && showSources && (
          <div className="sources-panel">
            {msg.sources.map((s) => (
              <div key={s.index} className="source-hit">
                <div className="source-hit__meta">
                  <span className="source-hit__index">#{s.index}</span>
                  <span className="source-hit__name" title={s.source}>
                    {s.source}
                  </span>
                  <span className="source-hit__score">相似度 {s.score.toFixed(3)}</span>
                </div>
                <pre className="source-hit__text">{s.text}</pre>
              </div>
            ))}
          </div>
        )}

        <div className="bubble__body" ref={bodyRef}>
          {msg.text ? (
            <pre className="md-pre">{msg.text}</pre>
          ) : !msg.done ? (
            <span className="status-line">
              <span className="spinner" />
              正在检索知识库 / 生成回答…
            </span>
          ) : null}
          {!msg.done && msg.text && <span className="caret" />}
        </div>
      </div>
    </div>
  );
}
