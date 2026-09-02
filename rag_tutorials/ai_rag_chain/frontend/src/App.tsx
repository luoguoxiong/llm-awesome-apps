// rag_tutorials/ai_rag_chain/frontend/src/App.tsx
// RAG 问答主状态机:知识库管理(上传/清空)+ 提问 → 检索 → 流式回答 + 引用片段展示。
//
// 迁移自 awesome-llm-apps/rag_tutorials/rag_chain(PharmaQuery,Streamlit):
//   源应用为 Chroma 向量库 + Gemini 嵌入/生成的基础 RAG 链;
//   本实现为 React 聊天界面,服务端 TF-IDF 本地检索 + aipack 流式生成,
//   每次提问独立检索(对齐源应用的单轮 RAG Chain 行为),并新增引用片段可视化。
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchConfig,
  streamQuery,
  apiKeyStorageKey,
  type ServerConfig,
  type ChatMsg,
  type DbStats,
  type SourceHit,
} from './api';
import { ModelPicker } from './components/ModelPicker';
import { DocUploader } from './components/DocUploader';
import { ChatMessage } from './components/ChatMessage';

const EXAMPLE_QUESTIONS = [
  '知识库里涵盖了哪些主题?',
  '文档中提到了哪些 AI 应用?',
  '总结一下已上传文档的核心结论',
];

let msgSeq = 0;
function makeMsg(role: 'user' | 'assistant'): ChatMsg {
  msgSeq += 1;
  return { id: `m${msgSeq}`, role, text: '', sources: [], done: role === 'user' };
}

export default function App() {
  // ── 服务配置与模型选择 ─────────────────────────────────────
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [modelValue, setModelValue] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [configError, setConfigError] = useState<string | null>(null);

  // ── 知识库状态 ─────────────────────────────────────────────
  const [db, setDb] = useState<DbStats>({ chunkCount: 0, sourceCount: 0, sources: [] });

  // ── 问答状态 ───────────────────────────────────────────────
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // ── 初始化:拉取配置 ────────────────────────────────────────
  useEffect(() => {
    fetchConfig()
      .then((c) => {
        setConfig(c);
        setDb(c.db);
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

  // ── 提问(SSE RAG 链) ──────────────────────────────────────
  const ask = useCallback(async () => {
    if (!config || running) return;
    const text = input.trim();
    if (!text) return;

    // 知识库为空:提示先上传文档(对齐源应用"请先上传文件"的引导)
    if (db.chunkCount === 0) {
      const userMsg = { ...makeMsg('user'), text };
      const errMsg: ChatMsg = {
        ...makeMsg('assistant'),
        text: '⚠️ 知识库为空。请先在上方"知识库"卡片上传文档(PDF/TXT/MD),再提问。',
        done: true,
      };
      setMessages((prev) => [...prev, userMsg, errMsg]);
      setInput('');
      return;
    }

    // 校验 Key:服务器未配置且用户未输入 → 提示
    const provider = modelValue.slice(0, modelValue.indexOf(':'));
    const modelInfo = config.models.find((m) => `${m.provider}:${m.modelId}` === modelValue);
    if (!modelInfo?.available && !apiKey.trim()) {
      const userMsg = { ...makeMsg('user'), text };
      const errMsg: ChatMsg = {
        ...makeMsg('assistant'),
        text: `⚠️ 请先在上方"模型与 Key"卡片输入 API Key(${modelInfo?.envVar || `${provider.toUpperCase()}_API_KEY`}),或在服务器 .env 配置后重启。`,
        done: true,
      };
      setMessages((prev) => [...prev, userMsg, errMsg]);
      setInput('');
      return;
    }

    const userMsg = { ...makeMsg('user'), text };
    const assistantMsg = makeMsg('assistant');
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput('');
    setRunning(true);

    const ac = new AbortController();
    abortRef.current = ac;

    const [prov, mid] = modelValue.split(':');
    try {
      await streamQuery(
        { question: text, model: { provider: prov, modelId: mid, apiKey: apiKey.trim() || undefined } },
        {
          signal: ac.signal,
          onSources: (hits: SourceHit[]) => {
            patchLast({ sources: hits });
          },
          onDelta: (delta) => {
            patchLast((m) => ({ text: m.text + delta }));
          },
          onError: (message) => {
            patchLast((m) => ({ text: m.text ? `${m.text}\n\n⚠️ ${message}` : `⚠️ ${message}` }));
          },
        },
      );
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        const msg = (e as Error).message || '问答失败';
        patchLast((m) => ({ text: m.text ? `${m.text}\n\n⚠️ ${msg}` : `⚠️ ${msg}` }));
      }
    } finally {
      patchLast({ done: true });
      setRunning(false);
      abortRef.current = null;
    }
  }, [config, running, input, modelValue, apiKey, db.chunkCount, patchLast]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setRunning(false);
  }, []);

  const clearChat = useCallback(() => {
    if (running) stop();
    setMessages([]);
    setInput('');
  }, [running, stop]);

  if (configError) {
    return (
      <div className="page">
        <header className="hero hero--compact">
          <div className="hero__overlay">
            <h1>AI RAG Chain</h1>
          </div>
        </header>
        <main className="container">
          <div className="card card--error">
            <h2>⚠️ 服务不可用</h2>
            <pre className="error-text">{configError}</pre>
            <p className="status">请确认后端已启动(pnpm --filter ai-rag-chain dev,端口 3013)。</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="hero hero--compact">
        <div className="hero__overlay">
          <h1>📚 AI RAG Chain</h1>
          <p className="hero__sub">
            基础 RAG 检索链——上传文档建立知识库 → 提问时本地 TF-IDF 相似检索 top-{config?.topK ?? 5} 片段 →
            仅基于检索上下文流式作答,引用片段可展开溯源。
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

            <DocUploader db={db} onDbChange={setDb} disabled={running} />

            <section className="card chat-card">
              <div className="chat-head">
                <h2>知识库问答</h2>
                <button type="button" className="btn btn--ghost btn--sm" onClick={clearChat} disabled={running}>
                  ✚ 新提问
                </button>
              </div>

              <div className="chat-list">
                {messages.length === 0 && (
                  <div className="chat-empty">
                    <div className="chat-empty__title">先上传文档,再试试这些问题 👇</div>
                    <div className="example-chips">
                      {EXAMPLE_QUESTIONS.map((q) => (
                        <button key={q} type="button" className="chip" onClick={() => setInput(q)}>
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
                      void ask();
                    }
                  }}
                  placeholder="基于知识库提问,如:文档的核心观点是什么?(Enter 发送,Shift+Enter 换行)"
                  disabled={running}
                />
                <div className="chat-input__actions">
                  <button type="button" className="btn btn--primary" onClick={() => void ask()} disabled={running || !input.trim()}>
                    提问
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
          基于 aipack Runtime(本地 TF-IDF 检索 + 上下文流式生成)· 每次提问独立检索 · 迁移自 awesome-llm-apps/rag_chain
        </footer>
      </main>
    </div>
  );
}
