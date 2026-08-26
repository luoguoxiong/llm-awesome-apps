// starter_ai_agents/ai_mixture_of_agents/frontend/src/App.tsx
// 主状态机:问题输入 + 参考模型多选(跨 provider,最多 N 个)+ 聚合模型单选
// + 按 provider 的 API Key 输入 → SSE 流式 MoA:
//   阶段 1:各参考模型并行流式回答(网格面板)
//   阶段 2:聚合模型批判性综合,流式输出最终回答(高亮大卡)
//
// 迁移自 awesome-llm-apps/starter_ai_agents/mixture_of_agents
// (源应用:Together AI Key + 4 固定开源模型并行 + Mixtral 聚合流式,
//  expander 展示各模型回答;本实现:27 内置模型自由组合 + 双通道 Key + 并行流式面板)。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchConfig,
  runMixture,
  apiKeyStorageKey,
  type ServerConfig,
  type RefResult,
  type AggregateState,
  type ModelSpec,
} from './api';
import { ModelMultiSelect } from './components/ModelMultiSelect';
import { Markdown } from './components/Markdown';

const EXAMPLE_PROMPTS = [
  '量子计算在未来十年会对密码学产生什么影响?',
  '比较 Rust 和 Go 在后端开发中的取舍',
  '解释大语言模型的"涌现能力"及其争议',
];

/** modelKey(`${provider}:${modelId}`) → 展示名 */
function modelLabel(config: ServerConfig | null, modelKey: string): string {
  const info = config?.models.find((m) => `${m.provider}:${m.modelId}` === modelKey);
  return info ? info.modelName : modelKey;
}

export default function App() {
  // ── 服务配置与选择 ─────────────────────────────────────────
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  /** 选中的参考 modelKey 列表 */
  const [refSelection, setRefSelection] = useState<string[]>([]);
  /** 聚合 modelKey */
  const [aggregator, setAggregator] = useState('');
  /** 按 provider 的 API Key(前端输入,localStorage 持久化) */
  const [keys, setKeys] = useState<Record<string, string>>({});

  // ── 运行状态 ───────────────────────────────────────────────
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const [refResults, setRefResults] = useState<RefResult[]>([]);
  const [aggregate, setAggregate] = useState<AggregateState>({ status: 'idle', text: '' });
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // ── 初始化:拉取配置 + 默认选择 ─────────────────────────────
  useEffect(() => {
    fetchConfig()
      .then((c) => {
        setConfig(c);
        // 默认参考模型:目录中存在的默认组合
        const defaults = c.defaultReferences
          .map((d) => `${d.provider}:${d.modelId}`)
          .filter((key) => c.models.some((m) => `${m.provider}:${m.modelId}` === key));
        setRefSelection(defaults.slice(0, c.maxReferences));
        setAggregator(`${c.defaultModel.provider}:${c.defaultModel.modelId}`);
        // 预加载各 provider 的 Key(localStorage)
        const loaded: Record<string, string> = {};
        for (const m of c.models) {
          if (!(m.provider in loaded)) {
            loaded[m.provider] = localStorage.getItem(apiKeyStorageKey(m.provider)) || '';
          }
        }
        setKeys(loaded);
      })
      .catch((e) => setConfigError(`无法连接后端服务:${(e as Error).message}`));
  }, []);

  // ── 聚合回答流式时滚动到底 ──────────────────────────────────
  useEffect(() => {
    if (running) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [aggregate.text, running]);

  /** 涉及的 provider(参考 + 聚合,去重) */
  const involvedProviders = useMemo(() => {
    const set = new Map<string, string>(); // provider → providerName
    if (!config) return set;
    for (const key of [...refSelection, aggregator]) {
      const info = config.models.find((m) => `${m.provider}:${m.modelId}` === key);
      if (info) set.set(info.provider, info.providerName);
    }
    return set;
  }, [config, refSelection, aggregator]);

  const handleKeyChange = useCallback((provider: string, value: string) => {
    setKeys((prev) => ({ ...prev, [provider]: value }));
    localStorage.setItem(apiKeyStorageKey(provider), value);
  }, []);

  const toggleRef = useCallback(
    (modelKey: string) => {
      setRefSelection((prev) =>
        prev.includes(modelKey) ? prev.filter((k) => k !== modelKey) : prev.length < (config?.maxReferences ?? 6) ? [...prev, modelKey] : prev,
      );
    },
    [config],
  );

  /** 构造提交给后端的模型选择(带该 provider 的用户 Key) */
  const buildSpec = useCallback(
    (modelKey: string): ModelSpec => {
      const [provider, modelId] = modelKey.split(':');
      return { provider, modelId, apiKey: keys[provider]?.trim() || undefined };
    },
    [keys],
  );

  // ── 执行 MoA ───────────────────────────────────────────────
  const ask = useCallback(
    async (promptOverride?: string) => {
      if (!config || running) return;
      const p = (promptOverride ?? prompt).trim();
      if (!p) return;
      if (refSelection.length === 0) {
        setError('请至少选择 1 个参考模型');
        return;
      }

      setRunning(true);
      setError(null);
      setAggregate({ status: 'idle', text: '' });
      setRefResults(
        refSelection.map((key) => ({
          modelKey: key,
          label: modelLabel(config, key),
          status: 'pending' as const,
          text: '',
        })),
      );

      const ac = new AbortController();
      abortRef.current = ac;

      const patchRef = (modelKey: string, patch: Partial<RefResult>) => {
        setRefResults((prev) => prev.map((r) => (r.modelKey === modelKey ? { ...r, ...patch } : r)));
      };

      try {
        await runMixture(
          p,
          refSelection.map(buildSpec),
          buildSpec(aggregator),
          {
            signal: ac.signal,
            onStage: (stage, data) => {
              if (stage === 'ref_start') {
                patchRef(String(data.modelKey), { status: 'running' });
              } else if (stage === 'ref_end') {
                const err = typeof data.error === 'string' ? data.error : null;
                patchRef(String(data.modelKey), { status: err ? 'error' : 'done', error: err ?? undefined });
              } else if (stage === 'aggregate_start') {
                setAggregate({ status: 'running', text: '' });
              }
            },
            onRefDelta: (modelKey, delta) => {
              setRefResults((prev) => prev.map((r) => (r.modelKey === modelKey ? { ...r, text: r.text + delta } : r)));
            },
            onDelta: (_kind, delta) => {
              setAggregate((prev) => ({ ...prev, text: prev.text + delta }));
            },
            onError: (message) => {
              setAggregate((prev) => (prev.status === 'idle' ? prev : { ...prev, status: 'error', error: message }));
              setError(message);
            },
          },
        );
        setAggregate((prev) => (prev.status === 'running' ? { ...prev, status: 'done' } : prev));
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          setError((e as Error).message || 'MoA 执行失败');
        }
      } finally {
        setRunning(false);
        abortRef.current = null;
      }
    },
    [config, running, prompt, refSelection, aggregator, buildSpec],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setRunning(false);
  }, []);

  const doneRefs = refResults.filter((r) => r.status === 'done').length;

  if (configError) {
    return (
      <div className="page">
        <header className="hero hero--compact">
          <div className="hero__overlay">
            <h1>AI Mixture-of-Agents</h1>
          </div>
        </header>
        <main className="container">
          <div className="card card--error">
            <h2>⚠️ 服务不可用</h2>
            <pre className="error-text">{configError}</pre>
            <p className="status">请确认后端已启动(pnpm --filter ai-mixture-of-agents dev,端口 3008)。</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="hero hero--compact">
        <div className="hero__overlay">
          <h1>🧩 AI Mixture-of-Agents</h1>
          <p className="hero__sub">
            同一问题发给多个模型并行回答,再由聚合模型批判性综合成单一高质量回答——集众家之长,减少单模型偏差。
          </p>
        </div>
      </header>

      <main className="container container--wide">
        {!config ? (
          <div className="card">
            <p className="status">正在连接后端服务…</p>
          </div>
        ) : (
          <>
            {/* ── 问题输入 ── */}
            <section className="card">
              <h2>你的问题</h2>
              <div className="prompt-row">
                <input
                  className="prompt-input"
                  type="text"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void ask();
                  }}
                  placeholder="向多个模型同时提问…"
                  disabled={running}
                  maxLength={4000}
                />
                <button type="button" className="btn btn--primary" onClick={() => void ask()} disabled={running || !prompt.trim()}>
                  {running ? '执行中…' : `Ask ${refSelection.length + 1} 个模型`}
                </button>
                {running && (
                  <button type="button" className="btn" onClick={stop}>
                    停止
                  </button>
                )}
              </div>
              <div className="example-chips">
                {EXAMPLE_PROMPTS.map((p) => (
                  <button key={p} type="button" className="chip" onClick={() => void ask(p)} disabled={running}>
                    {p}
                  </button>
                ))}
              </div>
            </section>

            {/* ── 参考模型多选 ── */}
            <section className="card">
              <div className="card-head">
                <h2>参考模型(并行回答)</h2>
                <span className="card-head__meta">
                  {refSelection.length}/{config.maxReferences} 已选 · {doneRefs} 完成
                </span>
              </div>
              <ModelMultiSelect
                models={config.models}
                selected={refSelection}
                onToggle={toggleRef}
                max={config.maxReferences}
                disabled={running}
              />
            </section>

            {/* ── 聚合模型 + API Keys ── */}
            <div className="split-config">
              <section className="card">
                <h2>聚合模型(综合最终回答)</h2>
                <label className="field">
                  <span>Aggregator</span>
                  <select value={aggregator} onChange={(e) => setAggregator(e.target.value)} disabled={running}>
                    {groupByProvider(config).map(([provider, g]) => (
                      <optgroup key={provider} label={g.name}>
                        {g.items.map((m) => (
                          <option key={`${m.provider}:${m.modelId}`} value={`${m.provider}:${m.modelId}`}>
                            {m.modelName}
                            {m.reasoning ? ' ✨' : ''}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <p className="picker-meta">聚合模型会收到各参考模型的回答,批判性评估后产出最终回复。</p>
              </section>

              <section className="card">
                <h2>API Keys(按 provider)</h2>
                {involvedProviders.size === 0 ? (
                  <p className="picker-meta">选择模型后,此处显示需要 Key 的 provider。</p>
                ) : (
                  <div className="key-list">
                    {[...involvedProviders.entries()].map(([provider, name]) => {
                      const info = config.models.find((m) => m.provider === provider);
                      const serverReady = info?.available ?? false;
                      return (
                        <label key={provider} className="field">
                          <span>
                            {name}{' '}
                            <span className={`hint ${serverReady ? 'hint--ok' : ''}`}>
                              {serverReady ? '✅ 已用服务器配置' : `需要 ${info?.envVar}`}
                            </span>
                          </span>
                          <input
                            type="password"
                            value={serverReady ? '' : keys[provider] || ''}
                            placeholder={serverReady ? '已用服务器配置,无需输入' : `输入 ${info?.envVar}`}
                            onChange={(e) => handleKeyChange(provider, e.target.value)}
                            disabled={running || serverReady}
                            autoComplete="off"
                            spellCheck={false}
                          />
                        </label>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>

            {/* ── 错误 ── */}
            {error && <pre className="error-text">{error}</pre>}

            {/* ── 结果:参考模型网格 + 聚合回答 ── */}
            {refResults.length > 0 && (
              <>
                <section className="results-section">
                  <h2 className="results-title">各模型回答(并行)</h2>
                  <div className="ref-grid">
                    {refResults.map((r) => (
                      <div key={r.modelKey} className={`ref-card ref-card--${r.status}`}>
                        <div className="ref-card__head">
                          <span className="ref-card__name">{r.label}</span>
                          <span className={`ref-card__status ref-card__status--${r.status}`}>
                            {r.status === 'pending' && '等待中'}
                            {r.status === 'running' && (
                              <>
                                <span className="spinner" /> 生成中
                              </>
                            )}
                            {r.status === 'done' && '✓ 完成'}
                            {r.status === 'error' && '✗ 失败'}
                          </span>
                        </div>
                        <div className="ref-card__body">
                          {r.error ? <span className="ref-card__error">{r.error}</span> : r.text ? <Markdown text={r.text} /> : <span className="ref-card__placeholder">…</span>}
                          {r.status === 'running' && r.text && <span className="caret" />}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>

                {aggregate.status !== 'idle' && (
                  <section className="card agg-card">
                    <div className="agg-head">
                      <h2>综合回答</h2>
                      <span className="agg-model">
                        聚合模型:{modelLabel(config, aggregator)}
                        {aggregate.status === 'done' && ' · 完成'}
                      </span>
                    </div>
                    {aggregate.error && <pre className="error-text">{aggregate.error}</pre>}
                    {aggregate.text ? (
                      <div className="agg-body">
                        <Markdown text={aggregate.text} />
                        {aggregate.status === 'running' && <span className="caret" />}
                        <div ref={bottomRef} />
                      </div>
                    ) : (
                      aggregate.status === 'running' && (
                        <div className="status-line">
                          <span className="spinner" /> 参考模型回答完毕,正在综合…
                        </div>
                      )
                    )}
                  </section>
                )}
              </>
            )}

            {refResults.length === 0 && (
              <section className="card">
                <p className="status">选择参考模型并提问后,这里将并行展示各模型回答与综合结果。</p>
              </section>
            )}

            <footer className="footer">
              基于 aipack(N 路并行生成 + 聚合模型批判性综合)· 迁移自 awesome-llm-apps mixture_of_agents
            </footer>
          </>
        )}
      </main>
    </div>
  );
}

/** 模型目录按 provider 分组 */
function groupByProvider(config: ServerConfig): Array<[string, { name: string; items: typeof config.models }]> {
  const map = new Map<string, { name: string; items: typeof config.models }>();
  for (const m of config.models) {
    if (!map.has(m.provider)) map.set(m.provider, { name: m.providerName, items: [] });
    map.get(m.provider)!.items.push(m);
  }
  return [...map.entries()];
}
