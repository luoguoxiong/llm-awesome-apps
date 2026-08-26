// starter_ai_agents/ai_web_scraping_agent/frontend/src/App.tsx
// 主状态机:URL + 抽取指令 → 模型选择 → SSE 流式抽取渲染。
//
// 迁移自 awesome-llm-apps/starter_ai_agents/web_scraping_ai_agent(Streamlit + ScrapeGraphAI):
//   源应用 SmartScraperGraph(prompt + source=URL)本地抓取并抽取结构化数据;
//   本实现由 aipack Agent 调用 scrape_web 工具(三层降级)完成抓取,
//   再按指令输出结构化 JSON,前端自动提取并格式化展示 + 一键复制。
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchConfig,
  streamScrape,
  apiKeyStorageKey,
  type ServerConfig,
  type ToolCallEntry,
} from './api';
import { ModelPicker } from './components/ModelPicker';
import { ResultPanel } from './components/ResultPanel';

/** 示例抽取指令(对齐源 README 的四大用例) */
const EXAMPLE_PROMPTS = [
  { label: '🛒 电商:产品信息', value: '提取所有产品的名称、价格和库存状态' },
  { label: '📰 内容:文章字段', value: '提取文章的标题、作者、发布日期和主要内容' },
  { label: '⚔️ 竞品:定价方案', value: '提取各定价方案的名称、价格、包含功能和限制' },
  { label: '📇 线索:联系方式', value: '提取公司名称、联系邮箱和电话号码' },
];

type Phase = 'idle' | 'running' | 'done';

export default function App() {
  // ── 服务配置与模型选择 ─────────────────────────────────────
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [modelValue, setModelValue] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [configError, setConfigError] = useState<string | null>(null);

  // ── 抓取输入 ───────────────────────────────────────────────
  const [url, setUrl] = useState('');
  const [prompt, setPrompt] = useState('');

  // ── 抽取状态 ───────────────────────────────────────────────
  const [phase, setPhase] = useState<Phase>('idle');
  const [text, setText] = useState('');
  const [thinking, setThinking] = useState('');
  const [toolCalls, setToolCalls] = useState<ToolCallEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const busy = phase === 'running';

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

  const handleApiKeyChange = useCallback(
    (value: string) => {
      setApiKey(value);
      const provider = modelValue.slice(0, modelValue.indexOf(':'));
      if (provider) localStorage.setItem(apiKeyStorageKey(provider), value);
    },
    [modelValue],
  );

  // ── 执行抓取抽取(SSE) ─────────────────────────────────────
  const run = useCallback(async () => {
    if (!config) return;
    const u = url.trim();
    if (!u) {
      setError('请输入目标网页 URL');
      return;
    }
    if (!/^https?:\/\//i.test(u)) {
      setError('URL 必须以 http:// 或 https:// 开头');
      return;
    }
    const p = prompt.trim();
    if (!p) {
      setError('请输入抽取指令(如"提取产品名称、价格和库存状态")');
      return;
    }

    // 校验 Key:服务器未配置且用户未输入 → 提示
    const provider = modelValue.slice(0, modelValue.indexOf(':'));
    const modelInfo = config.models.find((m) => `${m.provider}:${m.modelId}` === modelValue);
    if (!modelInfo?.available && !apiKey.trim()) {
      setError(`请输入 API Key(${modelInfo?.envVar || `${provider.toUpperCase()}_API_KEY`}),或在服务器 .env 配置`);
      return;
    }

    // 重置结果状态
    setError(null);
    setText('');
    setThinking('');
    setToolCalls([]);
    setPhase('running');

    const ac = new AbortController();
    abortRef.current = ac;

    const [prov, mid] = modelValue.split(':');
    try {
      await streamScrape(
        { url: u, prompt: p, model: { provider: prov, modelId: mid, apiKey: apiKey.trim() || undefined } },
        {
          signal: ac.signal,
          onStage: (stage, toolName) => {
            if (stage === 'tool_start' && toolName) {
              setToolCalls((prev) => [...prev, { name: toolName, status: 'running' }]);
            } else if (stage === 'tool_end' && toolName) {
              setToolCalls((prev) =>
                prev.map((t, i) => (i === prev.length - 1 && t.name === toolName ? { ...t, status: 'done' } : t)),
              );
            }
          },
          onDelta: (deltaKind, delta) => {
            if (deltaKind === 'text') setText((prev) => prev + delta);
            else setThinking((prev) => prev + delta);
          },
          onError: (message) => setError(message),
        },
      );
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setError((e as Error).message || '抓取失败');
      }
    } finally {
      setPhase((prev) => (prev === 'running' ? 'done' : prev));
      abortRef.current = null;
    }
  }, [config, url, prompt, modelValue, apiKey]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setPhase('done');
  }, []);

  if (configError) {
    return (
      <div className="page">
        <header className="hero">
          <div className="hero__overlay">
            <h1>Web Scraping AI Agent</h1>
          </div>
        </header>
        <main className="container">
          <div className="card card--error">
            <h2>⚠️ 服务不可用</h2>
            <pre className="error-text">{configError}</pre>
            <p className="status">请确认后端已启动(pnpm --filter ai-web-scraping-agent dev,端口 3004)。</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="hero">
        <div className="hero__overlay">
          <h1>🕷️ Web Scraping AI Agent</h1>
          <p className="hero__sub">
            输入网址和一句自然语言指令——AI 自动抓取页面正文,抽取结构化数据(JSON),支持电商、内容、竞品、线索等场景。
          </p>
        </div>
      </header>

      <main className="container">
        {!config ? (
          <div className="card">
            <p className="status">正在连接后端服务…</p>
          </div>
        ) : (
          <>
            <section className="card">
              <h2>1 · 目标网页</h2>
              <label className="field field--grow">
                <span>URL</span>
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/pricing"
                  disabled={busy}
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
            </section>

            <section className="card">
              <h2>2 · 抽取指令(自然语言)</h2>
              <textarea
                className="prompt-input"
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="想从网页中抽取什么?如:提取所有产品的名称、价格和库存状态"
                disabled={busy}
              />
              <div className="example-chips">
                {EXAMPLE_PROMPTS.map((ex) => (
                  <button
                    key={ex.label}
                    type="button"
                    className={`chip ${prompt === ex.value ? 'chip--active' : ''}`}
                    onClick={() => setPrompt(ex.value)}
                    disabled={busy}
                    title={ex.value}
                  >
                    {ex.label}
                  </button>
                ))}
              </div>
              <div className="actions">
                <button type="button" className="btn btn--primary" onClick={() => void run()} disabled={busy}>
                  {busy ? '抓取抽取中…' : '🕷️ 抓取并抽取'}
                </button>
                {busy && (
                  <button type="button" className="btn" onClick={stop}>
                    停止
                  </button>
                )}
              </div>
            </section>

            <ModelPicker
              config={config}
              value={modelValue}
              onChange={setModelValue}
              apiKey={apiKey}
              onApiKeyChange={handleApiKeyChange}
              disabled={busy}
            />

            <ResultPanel
              phase={phase}
              text={text}
              thinking={thinking}
              toolCalls={toolCalls}
              error={error}
            />
          </>
        )}

        <footer className="footer">
          基于 aipack Runtime(scrape_web 工具三层降级)· 输出结构化 JSON · 迁移自 awesome-llm-apps
        </footer>
      </main>
    </div>
  );
}
