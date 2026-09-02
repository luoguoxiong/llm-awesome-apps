// rag_tutorials/ai_hybrid_rag/frontend/src/App.tsx
// 主状态机：文档摄取（上传 .txt/.md + 粘贴文本 + URL 抓取 + 示例文档）
// → 索引管理（来源列表 / 删除 / 清空）→ 多轮对话问答（sessionId 维持上下文）
// → SSE 流式回复（检索/评估阶段时间线 + 候选片段详情 + Markdown 渲染）。
//
// 迁移自 awesome-llm-apps/rag_tutorials 的三个源应用（按 PLAN 合并为本应用）：
//   - hybrid_search_rag（RAGLite + PostgreSQL + Cohere 重排）
//     → 零依赖混合检索：BM25 + TF-IDF 双通道 RRF 融合 + LLM 相关性重排
//   - local_hybrid_search_rag（本地 LLM 变体）→ 模型下拉 + OpenAI 兼容接入覆盖
//   - ai_blog_search（LangGraph 博客检索）→ URL 摄取 + 相关性门控 + 示例数据集
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchConfig,
  fetchDocuments,
  ingestText,
  ingestUrl,
  removeDocuments,
  streamChat,
  apiKeyStorageKey,
  newSessionId,
  type ServerConfig,
  type StoreStats,
  type CandidateInfo,
  type ChatMsg,
  type RetrievalTrace,
} from './api';
import { ModelPicker } from './components/ModelPicker';
import { ChatMessage } from './components/ChatMessage';

const EXAMPLE_QUESTIONS = [
  '混合检索为什么比单一向量检索效果好？',
  'RRF 融合是怎么工作的？',
  'RAG 常见的失败模式有哪些？',
  'LangGraph 的核心概念是什么？',
];

/** 支持上传的纯文本类文件（PDF 解析在批次 4 ai_chat_pdf 统一实现） */
const ACCEPT_EXT = '.txt,.md,.markdown';

let msgSeq = 0;
function makeMsg(role: 'user' | 'assistant', text = ''): ChatMsg {
  msgSeq += 1;
  return { id: `m${msgSeq}`, role, text, thinking: '', trace: null, done: role === 'user' };
}

export default function App() {
  // ── 服务配置与模型选择 ─────────────────────────────────────
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [modelValue, setModelValue] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [configError, setConfigError] = useState<string | null>(null);

  // ── 文档摄取 / 索引状态 ────────────────────────────────────
  const [stats, setStats] = useState<StoreStats | null>(null);
  const [ingesting, setIngesting] = useState(false);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [ingestNotice, setIngestNotice] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [pasteName, setPasteName] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── 会话状态 ───────────────────────────────────────────────
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const sessionIdRef = useRef<string>(newSessionId());

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // ── 初始化：拉取配置 ────────────────────────────────────────
  useEffect(() => {
    fetchConfig()
      .then((c) => {
        setConfig(c);
        setStats(c.stats);
        setModelValue(`${c.provider}:${c.model}`);
      })
      .catch((e) => setConfigError(`无法连接后端服务：${(e as Error).message}`));
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

  // ── 文档摄取 ───────────────────────────────────────────────
  const runIngest = useCallback(async (task: () => Promise<{ name: string; added: number; skipped: number; stats: StoreStats }>) => {
    if (ingesting) return;
    setIngesting(true);
    setIngestError(null);
    setIngestNotice(null);
    try {
      const r = await task();
      setStats(r.stats);
      setIngestNotice(`✅ 已摄取「${r.name}」：新增 ${r.added} 块${r.skipped > 0 ? `，跳过重复 ${r.skipped} 块` : ''}`);
    } catch (e) {
      setIngestError((e as Error).message || '摄取失败');
    } finally {
      setIngesting(false);
    }
  }, [ingesting]);

  /** 上传 .txt/.md 文件（前端读为文本后提交） */
  const handleFile = useCallback(async (file: File | undefined | null) => {
    if (!file) return;
    await runIngest(async () => {
      const content = await file.text();
      if (!content.trim()) throw new Error('文件内容为空');
      return ingestText(file.name, content);
    });
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [runIngest]);

  /** 粘贴文本摄取 */
  const handlePaste = useCallback(async () => {
    if (!pasteText.trim()) return;
    await runIngest(() => ingestText(pasteName.trim() || '粘贴文本', pasteText));
    setPasteText('');
    setPasteName('');
  }, [pasteText, pasteName, runIngest]);

  /** URL 摄取（服务端抓取） */
  const handleUrl = useCallback(async () => {
    if (!urlInput.trim()) return;
    await runIngest(() => ingestUrl(urlInput.trim()));
    setUrlInput('');
  }, [urlInput, runIngest]);

  /** 载入示例文档（合并自 ai_blog_search 的示例数据集，随前端静态资源分发） */
  const handleSample = useCallback(async () => {
    await runIngest(async () => {
      const res = await fetch('sample-docs.md');
      if (!res.ok) throw new Error(`示例文档加载失败（HTTP ${res.status}）`);
      const content = await res.text();
      return ingestText('示例：LLM Agent 与 RAG 知识库', content);
    });
  }, [runIngest]);

  /** 删除来源 / 清空索引 */
  const handleRemove = useCallback(async (name?: string) => {
    try {
      const r = await removeDocuments(name);
      setStats(r.stats);
      setIngestNotice(name ? `已删除「${name}」（${r.removed} 块）` : `已清空索引（${r.removed} 块）`);
    } catch (e) {
      setIngestError((e as Error).message || '删除失败');
    }
  }, []);

  /** 更新最后一条 assistant 消息 */
  const patchLast = useCallback((patch: Partial<ChatMsg> | ((m: ChatMsg) => Partial<ChatMsg>)) => {
    setMessages((prev) => {
      if (prev.length === 0 || prev[prev.length - 1].role !== 'assistant') return prev;
      const last = prev[prev.length - 1];
      const p = typeof patch === 'function' ? patch(last) : patch;
      return [...prev.slice(0, -1), { ...last, ...p }];
    });
  }, []);

  // ── 发送消息（SSE 多轮） ────────────────────────────────────
  const send = useCallback(async () => {
    if (!config || running) return;
    const text = input.trim();
    if (!text) return;

    // 校验 Key：服务器未配置且用户未输入 → 提示
    const provider = modelValue.slice(0, modelValue.indexOf(':'));
    const modelInfo = config.models.find((m) => `${m.provider}:${m.modelId}` === modelValue);
    if (!modelInfo?.available && !apiKey.trim()) {
      const userMsg = makeMsg('user', text);
      const errMsg: ChatMsg = {
        ...makeMsg('assistant'),
        text: `⚠️ 请先在上方"模型与 Key"卡片输入 API Key（${modelInfo?.envVar || `${provider.toUpperCase()}_API_KEY`}），或在服务器 .env 配置后重启。`,
        done: true,
      };
      setMessages((prev) => [...prev, userMsg, errMsg]);
      setInput('');
      return;
    }

    const userMsg = makeMsg('user', text);
    const assistantMsg: ChatMsg = { ...makeMsg('assistant'), trace: { stage: 'searching', candidates: [], graded: null, relevantCount: null, mode: null, contextCount: null } };
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
          onStage: (stage, data) => {
            if (stage === 'search_done' && Array.isArray(data.candidates)) {
              const candidates = data.candidates as CandidateInfo[];
              patchLast((m) => ({ trace: m.trace ? { ...m.trace, candidates } : m.trace }));
            } else if (stage === 'grade_start') {
              patchLast((m) => ({ trace: m.trace ? { ...m.trace, stage: 'grading' } : m.trace }));
            } else if (stage === 'grade_done') {
              patchLast((m) => ({
                trace: m.trace
                  ? {
                      ...m.trace,
                      graded: data.graded === true,
                      relevantCount: typeof data.relevantCount === 'number' ? data.relevantCount : null,
                      candidates: Array.isArray(data.candidates) ? (data.candidates as CandidateInfo[]) : m.trace.candidates,
                    }
                  : m.trace,
              }));
            } else if (stage === 'answer_start') {
              patchLast((m) => ({
                trace: m.trace
                  ? {
                      ...m.trace,
                      stage: 'answering',
                      mode: data.mode === 'fallback' ? 'fallback' : 'rag',
                      contextCount: typeof data.contextCount === 'number' ? data.contextCount : null,
                    }
                  : m.trace,
              }));
            } else if (stage === 'done') {
              patchLast((m) => ({ trace: m.trace ? { ...m.trace, stage: 'done' } : m.trace }));
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
        const msg = (e as Error).message || '问答失败';
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
            <h1>AI Hybrid Search RAG</h1>
          </div>
        </header>
        <main className="container">
          <div className="card card--error">
            <h2>⚠️ 服务不可用</h2>
            <pre className="error-text">{configError}</pre>
            <p className="status">请确认后端已启动（pnpm --filter ai-hybrid-rag dev，端口 3014）。</p>
          </div>
        </main>
      </div>
    );
  }

  const hasDocs = (stats?.totalChunks ?? 0) > 0;

  return (
    <div className="page">
      <header className="hero hero--compact">
        <div className="hero__overlay">
          <h1>🔍 AI Hybrid Search RAG</h1>
          <p className="hero__sub">
            关键词（BM25）+ 向量（TF-IDF）双通道混合检索，RRF 融合 + LLM 相关性重排，
            无相关片段时自动回退通用知识——摄取文档、提问，全过程检索细节透明可见。
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
            {/* ── 文档摄取 ── */}
            <section className="card ingest-card">
              <h2>知识库文档</h2>
              <div className="ingest-row">
                <button type="button" className="btn" onClick={() => fileInputRef.current?.click()} disabled={ingesting}>
                  ⇪ 上传 .txt / .md
                </button>
                <button type="button" className="btn" onClick={() => void handleSample()} disabled={ingesting}>
                  📚 载入示例文档
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPT_EXT}
                  hidden
                  onChange={(e) => void handleFile(e.target.files?.[0])}
                />
                <div className="ingest-url">
                  <input
                    type="url"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleUrl();
                    }}
                    placeholder="粘贴网页/博客 URL，回车摄取…"
                    disabled={ingesting}
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void handleUrl()}
                    disabled={ingesting || !urlInput.trim()}
                  >
                    抓取
                  </button>
                </div>
              </div>
              <div className="ingest-paste">
                <div className="ingest-paste__head">
                  <input
                    type="text"
                    value={pasteName}
                    onChange={(e) => setPasteName(e.target.value)}
                    placeholder="文档标题（可选）"
                    disabled={ingesting}
                  />
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    onClick={() => void handlePaste()}
                    disabled={ingesting || !pasteText.trim()}
                  >
                    摄取文本
                  </button>
                </div>
                <textarea
                  className="ingest-textarea"
                  rows={3}
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder="或直接粘贴文档文本到此处…"
                  disabled={ingesting}
                />
              </div>
              {ingesting && (
                <p className="status-line">
                  <span className="spinner" /> 正在摄取（分块 + 建索引）…
                </p>
              )}
              {ingestNotice && <p className="ingest-notice">{ingestNotice}</p>}
              {ingestError && <pre className="error-text">{ingestError}</pre>}

              {/* ── 索引统计 / 来源管理 ── */}
              {stats && stats.sources.length > 0 && (
                <div className="doc-list">
                  <div className="doc-list__head">
                    <span className="doc-list__title">
                      已索引 {stats.totalChunks.toLocaleString()} 块 · {stats.sources.length} 个来源
                    </span>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => void handleRemove()} disabled={ingesting}>
                      清空全部
                    </button>
                  </div>
                  {stats.sources.map((s) => (
                    <div key={s.name} className="doc-item">
                      <span className="doc-item__icon">📄</span>
                      <span className="doc-item__name" title={s.name}>
                        {s.name}
                      </span>
                      <span className="doc-item__meta">{s.chunkCount} 块</span>
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => void handleRemove(s.name)} disabled={ingesting}>
                        删除
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>

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
                    <div className="chat-empty__title">
                      {hasDocs ? '试试这些问题 👇（也可直接提问你的文档）' : '先摄取文档，或直接提问（将回退通用知识）👇'}
                    </div>
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
                      void send();
                    }
                  }}
                  placeholder="输入问题，如：混合检索的融合策略有哪些？（Enter 发送，Shift+Enter 换行）"
                  disabled={running}
                />
                <div className="chat-input__actions">
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => void send()}
                    disabled={running || !input.trim()}
                  >
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
          基于 aipack Runtime（BM25 + TF-IDF 混合检索 + LLM 重排 + 通用知识兜底）· 迁移自 awesome-llm-apps
        </footer>
      </main>
    </div>
  );
}
