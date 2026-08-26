// starter_ai_agents/ai_finance_agent/frontend/src/App.tsx
// 聊天式主状态机:多轮对话(sessionId 维持上下文)+ 流式回复渲染。
//
// 迁移自 awesome-llm-apps/starter_ai_agents/xai_finance_agent(Agno AgentOS playground):
//   源应用为 Grok + YFinance + DuckDuckGo 的对话式 playground;
//   本实现为 React 聊天界面,aipack Runtime 按 sessionKey 维护会话,
//   "新对话"按钮切换 sessionId 开启全新会话(对齐 playground 的会话体验)。
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchConfig,
  streamChat,
  apiKeyStorageKey,
  newSessionId,
  type ServerConfig,
  type ChatMsg,
} from './api';
import { ModelPicker } from './components/ModelPicker';
import { ChatMessage } from './components/ChatMessage';

const EXAMPLE_QUESTIONS = [
  'AAPL 现在多少钱?今天表现如何?',
  '对比 AAPL 和 MSFT 近 30 天的表现',
  'NVDA 最近有什么新闻和分析师观点?',
  '当前美联储利率政策对科技股有什么影响?',
];

let msgSeq = 0;
function makeMsg(role: 'user' | 'assistant', text = ''): ChatMsg {
  msgSeq += 1;
  return { id: `m${msgSeq}`, role, text, thinking: '', toolCalls: [], done: role === 'user' };
}

export default function App() {
  // ── 服务配置与模型选择 ─────────────────────────────────────
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [modelValue, setModelValue] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [configError, setConfigError] = useState<string | null>(null);

  // ── 会话状态 ───────────────────────────────────────────────
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const sessionIdRef = useRef<string>(newSessionId());

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // ── 初始化:拉取配置 ────────────────────────────────────────
  useEffect(() => {
    fetchConfig()
      .then((c) => {
        setConfig(c);
        setModelValue(`${c.provider}:${c.model}`);
      })
      .catch((e) => setConfigError(`无法连接后端服务:${(e as Error).message}`));
  }, []);

  // ── 模型切换时按 provider 联动 localStorage 的 API Key ───────
  useEffect(() => {
    if (!modelValue) return;
    const provider = modelValue.slice(0, modelValue.indexOf(':'));
    setApiKey(localStorage.getItem(apiKeyStorageKey(provider)) || '');
  }, [modelValue]);

  // ── 新消息时滚动到底部 ──────────────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleApiKeyChange = useCallback(
    (value: string) => {
      setApiKey(value);
      const provider = modelValue.slice(0, modelValue.indexOf(':'));
      if (provider) localStorage.setItem(apiKeyStorageKey(provider), value);
    },
    [modelValue],
  );

  /** 更新最后一条 assistant 消息 */
  const patchLast = useCallback((patch: Partial<ChatMsg> | ((m: ChatMsg) => Partial<ChatMsg>)) => {
    setMessages((prev) => {
      if (prev.length === 0 || prev[prev.length - 1].role !== 'assistant') return prev;
      const last = prev[prev.length - 1];
      const p = typeof patch === 'function' ? patch(last) : patch;
      return [...prev.slice(0, -1), { ...last, ...p }];
    });
  }, []);

  // ── 发送消息(SSE 多轮) ────────────────────────────────────
  const send = useCallback(async () => {
    if (!config || running) return;
    const text = input.trim();
    if (!text) return;

    // 校验 Key:服务器未配置且用户未输入 → 提示
    const provider = modelValue.slice(0, modelValue.indexOf(':'));
    const modelInfo = config.models.find((m) => `${m.provider}:${m.modelId}` === modelValue);
    if (!modelInfo?.available && !apiKey.trim()) {
      const userMsg = makeMsg('user', text);
      const errMsg: ChatMsg = {
        ...makeMsg('assistant'),
        text: `⚠️ 请先在上方"模型与 Key"卡片输入 API Key(${modelInfo?.envVar || `${provider.toUpperCase()}_API_KEY`}),或在服务器 .env 配置后重启。`,
        done: true,
      };
      setMessages((prev) => [...prev, userMsg, errMsg]);
      setInput('');
      return;
    }

    const userMsg = makeMsg('user', text);
    const assistantMsg = makeMsg('assistant');
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput('');
    setRunning(true);

    const ac = new AbortController();
    abortRef.current = ac;

    const [prov, mid] = modelValue.split(':');
    try {
      await streamChat(
        {
          message: text,
          sessionId: sessionIdRef.current,
          model: { provider: prov, modelId: mid, apiKey: apiKey.trim() || undefined },
        },
        {
          signal: ac.signal,
          onSession: (sid) => {
            sessionIdRef.current = sid;
          },
          onStage: (stage, toolName) => {
            if (stage === 'tool_start' && toolName) {
              patchLast((m) => ({ toolCalls: [...m.toolCalls, { name: toolName, status: 'running' }] }));
            } else if (stage === 'tool_end' && toolName) {
              patchLast((m) => ({
                toolCalls: m.toolCalls.map((t, i) =>
                  i === m.toolCalls.length - 1 && t.name === toolName ? { ...t, status: 'done' } : t,
                ),
              }));
            }
          },
          onDelta: (kind, delta) => {
            if (kind === 'text') patchLast((m) => ({ text: m.text + delta }));
            else patchLast((m) => ({ thinking: m.thinking + delta }));
          },
          onError: (message) => {
            patchLast((m) => ({ text: m.text ? `${m.text}\n\n⚠️ ${message}` : `⚠️ ${message}` }));
          },
        },
      );
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        const msg = (e as Error).message || '对话失败';
        patchLast((m) => ({ text: m.text ? `${m.text}\n\n⚠️ ${msg}` : `⚠️ ${msg}` }));
      }
    } finally {
      patchLast({ done: true });
      setRunning(false);
      abortRef.current = null;
    }
  }, [config, running, input, modelValue, apiKey, patchLast]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setRunning(false);
  }, []);

  const newSession = useCallback(() => {
    if (running) stop();
    sessionIdRef.current = newSessionId();
    setMessages([]);
    setInput('');
  }, [running, stop]);

  if (configError) {
    return (
      <div className="page">
        <header className="hero hero--compact">
          <div className="hero__overlay">
            <h1>AI Finance Agent</h1>
          </div>
        </header>
        <main className="container">
          <div className="card card--error">
            <h2>⚠️ 服务不可用</h2>
            <pre className="error-text">{configError}</pre>
            <p className="status">请确认后端已启动(pnpm --filter ai-finance-agent dev,端口 3005)。</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="hero hero--compact">
        <div className="hero__overlay">
          <h1>📊 AI Finance Agent</h1>
          <p className="hero__sub">
            多轮对话式金融分析——实时行情(Yahoo → 腾讯财经 → Stooq 免 Key 降级)、历史走势统计、财经资讯搜索,数据用表格、观点用要点。
          </p>
        </div>
      </header>

      <main className="container container--chat">
        {!config ? (
          <div className="card">
            <p className="status">正在连接后端服务…</p>
          </div>
        ) : (
          <>
            <ModelPicker
              config={config}
              value={modelValue}
              onChange={setModelValue}
              apiKey={apiKey}
              onApiKeyChange={handleApiKeyChange}
              disabled={running}
            />

            <section className="card chat-card">
              <div className="chat-head">
                <h2>对话</h2>
                <button type="button" className="btn btn--ghost btn--sm" onClick={newSession} disabled={running}>
                  ✚ 新对话
                </button>
              </div>

              <div className="chat-list">
                {messages.length === 0 && (
                  <div className="chat-empty">
                    <div className="chat-empty__title">试试这些问题 👇</div>
                    <div className="example-chips">
                      {EXAMPLE_QUESTIONS.map((q) => (
                        <button
                          key={q}
                          type="button"
                          className="chip"
                          onClick={() => setInput(q)}
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {messages.map((m) => (
                  <ChatMessage key={m.id} msg={m} />
                ))}
                <div ref={bottomRef} />
              </div>

              <div className="chat-input-row">
                <textarea
                  className="chat-input"
                  rows={2}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  placeholder="输入金融问题,如:AAPL 现在多少钱?近 3 个月走势如何?(Enter 发送,Shift+Enter 换行)"
                  disabled={running}
                />
                <div className="chat-input__actions">
                  <button type="button" className="btn btn--primary" onClick={() => void send()} disabled={running || !input.trim()}>
                    发送
                  </button>
                  {running && (
                    <button type="button" className="btn" onClick={stop}>
                      停止
                    </button>
                  )}
                </div>
              </div>
            </section>
          </>
        )}

        <footer className="footer">
          基于 aipack Runtime(多轮会话 + 行情/搜索三工具)· 数据仅供参考,不构成投资建议 · 迁移自 awesome-llm-apps
        </footer>
      </main>
    </div>
  );
}
