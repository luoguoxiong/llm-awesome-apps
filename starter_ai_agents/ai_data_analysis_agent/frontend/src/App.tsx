// starter_ai_agents/ai_data_analysis_agent/frontend/src/App.tsx
// 主状态机:数据集上传(CSV/Excel)→ 结构预览 → 多轮对话问答(sessionId 维持上下文)
// → SSE 流式回复(Markdown 表格 + ECharts 图表)。
//
// 迁移自 awesome-llm-apps/starter_ai_agents/ai_data_analysis_agent(Streamlit + DuckDB SQL 问答)
// 与 ai_data_visualisation_agent(Streamlit + E2B 沙箱 matplotlib 图表),两应用合并为本应用:
//   - SQL 问答 → 结构化查询工具 get_data_summary / query_data
//   - 沙箱图表 → ```echarts 代码块约定 + 前端 ECharts 渲染(免 E2B/沙箱 Key)
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchConfig,
  uploadDataset,
  streamChat,
  apiKeyStorageKey,
  newSessionId,
  type ServerConfig,
  type DatasetInfo,
  type ChatMsg,
} from './api';
import { ModelPicker } from './components/ModelPicker';
import { ChatMessage } from './components/ChatMessage';

const EXAMPLE_QUESTIONS = [
  '这份数据有哪些列?各列的类型和统计概览',
  '各分类的销售额对比如何?用柱状图展示',
  '找出数值最大的前 10 条记录',
  '按月份汇总数量趋势,画一条折线图',
];

const TYPE_BADGE: Record<string, { label: string; cls: string }> = {
  number: { label: '数值', cls: 'column-chip--number' },
  date: { label: '日期', cls: 'column-chip--date' },
  string: { label: '文本', cls: 'column-chip--string' },
};

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

  // ── 数据集状态 ─────────────────────────────────────────────
  const [dataset, setDataset] = useState<DatasetInfo | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  // ── 上传数据集 ──────────────────────────────────────────────
  const handleFile = useCallback(async (file: File | undefined | null) => {
    if (!file || uploading) return;
    setUploading(true);
    setUploadError(null);
    try {
      const info = await uploadDataset(file);
      setDataset(info);
      // 新数据集 → 新会话,清空历史消息
      setMessages([]);
      sessionIdRef.current = newSessionId();
    } catch (e) {
      setUploadError((e as Error).message || '上传失败');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [uploading]);

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

    // 数据集校验
    if (!dataset) {
      setMessages((prev) => [
        ...prev,
        makeMsg('user', text),
        { ...makeMsg('assistant'), text: '⚠️ 请先上传数据集(CSV / Excel),再进行提问。', done: true },
      ]);
      setInput('');
      return;
    }

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
          datasetId: dataset.id,
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
        const msg = (e as Error).message || '分析失败';
        patchLast((m) => ({ text: m.text ? `${m.text}\n\n⚠️ ${msg}` : `⚠️ ${msg}` }));
      }
    } finally {
      patchLast({ done: true });
      setRunning(false);
      abortRef.current = null;
    }
  }, [config, running, input, dataset, modelValue, apiKey, patchLast]);

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
            <h1>AI Data Analysis Agent</h1>
          </div>
        </header>
        <main className="container">
          <div className="card card--error">
            <h2>⚠️ 服务不可用</h2>
            <pre className="error-text">{configError}</pre>
            <p className="status">请确认后端已启动(pnpm --filter ai-data-analysis-agent dev,端口 3006)。</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="hero hero--compact">
        <div className="hero__overlay">
          <h1>📊 AI Data Analysis Agent</h1>
          <p className="hero__sub">
            上传 CSV / Excel,用自然语言提问——Agent 自动查询统计并生成 Markdown 表格与 ECharts 图表(免沙箱、免额外 Key)。
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
            {/* ── 数据集上传 / 预览 ── */}
            {!dataset ? (
              <section className="card upload-card">
                <h2>上传数据集</h2>
                <div
                  className={`upload-zone ${dragOver ? 'upload-zone--over' : ''}`}
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    void handleFile(e.dataTransfer.files?.[0]);
                  }}
                >
                  {uploading ? (
                    <span className="status-line">
                      <span className="spinner" /> 正在解析数据…
                    </span>
                  ) : (
                    <>
                      <div className="upload-zone__icon">📄</div>
                      <div>点击选择或拖拽文件到此处</div>
                      <div className="upload-zone__hint">支持 .csv / .tsv / .xlsx / .xls,最大 15MB,最大 5 万行</div>
                    </>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,.tsv,.txt,.xlsx,.xls"
                    hidden
                    onChange={(e) => void handleFile(e.target.files?.[0])}
                  />
                </div>
                {uploadError && <pre className="error-text">{uploadError}</pre>}
              </section>
            ) : (
              <section className="card data-card">
                <div className="data-head">
                  <h2>
                    📄 {dataset.name}
                    <span className="data-meta">
                      {dataset.rowCount.toLocaleString()} 行 × {dataset.columns.length} 列
                      {dataset.truncated ? '(超出 5 万行已截断)' : ''}
                    </span>
                  </h2>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                  >
                    ⇪ 换一份数据
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,.tsv,.txt,.xlsx,.xls"
                    hidden
                    onChange={(e) => void handleFile(e.target.files?.[0])}
                  />
                </div>

                <div className="column-chips">
                  {dataset.columns.map((c) => {
                    const badge = TYPE_BADGE[c.type] ?? TYPE_BADGE.string;
                    return (
                      <span key={c.name} className={`column-chip ${badge.cls}`} title={`缺失 ${c.missing} · 唯一值 ${c.unique}`}>
                        {c.name} <em>{badge.label}</em>
                      </span>
                    );
                  })}
                </div>

                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        {dataset.columns.map((c) => (
                          <th key={c.name}>{c.name}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {dataset.preview.map((row, i) => (
                        <tr key={i}>
                          {dataset.columns.map((c) => (
                            <td key={c.name}>{cellText(row[c.name])}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="data-foot">预览前 {dataset.preview.length} 行 · 完整数据已载入分析引擎</div>
                {uploadError && <pre className="error-text">{uploadError}</pre>}
              </section>
            )}

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
                <button type="button" className="btn btn--ghost btn--sm" onClick={newSession} disabled={running || !dataset}>
                  ✚ 新对话
                </button>
              </div>

              <div className="chat-list">
                {messages.length === 0 && (
                  <div className="chat-empty">
                    <div className="chat-empty__title">
                      {dataset ? '试试这些问题 👇' : '上传数据集后开始提问 👆'}
                    </div>
                    {dataset && (
                      <div className="example-chips">
                        {EXAMPLE_QUESTIONS.map((q) => (
                          <button key={q} type="button" className="chip" onClick={() => setInput(q)}>
                            {q}
                          </button>
                        ))}
                      </div>
                    )}
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
                  placeholder={
                    dataset
                      ? '输入分析问题,如:各分类的销售额对比?(Enter 发送,Shift+Enter 换行)'
                      : '请先上传数据集…'
                  }
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
          基于 aipack Runtime(数据集解析 + 结构化查询工具 + ECharts 约定)· 迁移自 awesome-llm-apps
        </footer>
      </main>
    </div>
  );
}

function cellText(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'number') {
    return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  return String(v);
}
