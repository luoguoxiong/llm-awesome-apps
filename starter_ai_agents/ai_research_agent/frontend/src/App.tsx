// starter_ai_agents/ai_research_agent/frontend/src/App.tsx
// 主状态机:主题输入 → SSE 流式研究(计划/搜索/HN/深读/事实收集)→ 双栏展示:
// 左栏研究过程(工具时间线 + 事实列表),右栏报告(Markdown 渲染 + 下载 .md)。
//
// 迁移自 awesome-llm-apps 的两个源应用(按 PLAN 合并):
//   - starter_ai_agents/openai_research_agent(Triage→Research→Editor 三 Agent,
//     Research Process / Report 双标签页 + 事实收集 + 报告下载)
//   - advanced_ai_agents/multi_agent_apps/multi_agent_researcher(HackerNews 团队研究)
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchConfig,
  runResearch,
  apiKeyStorageKey,
  nextRunId,
  type ServerConfig,
  type ResearchRun,
} from './api';
import { ModelPicker } from './components/ModelPicker';
import { Markdown } from './components/Markdown';
import { ResearchProcess } from './components/ResearchProcess';

const EXAMPLE_TOPICS = [
  '2025 年大语言模型智能体(AI Agent)的发展现状与趋势',
  'Rust 在后端 Web 开发中的采用情况与生态成熟度',
  '全球电动车电池技术路线对比:磷酸铁锂 vs 三元锂 vs 固态电池',
];

export default function App() {
  // ── 服务配置与模型选择 ─────────────────────────────────────
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [modelValue, setModelValue] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [configError, setConfigError] = useState<string | null>(null);

  // ── 研究状态 ───────────────────────────────────────────────
  const [topic, setTopic] = useState('');
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<ResearchRun | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const reportBottomRef = useRef<HTMLDivElement>(null);

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

  // ── 报告流式时滚动到底部 ────────────────────────────────────
  useEffect(() => {
    if (running) reportBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [run?.text, running]);

  const handleApiKeyChange = useCallback(
    (value: string) => {
      setApiKey(value);
      const provider = modelValue.slice(0, modelValue.indexOf(':'));
      if (provider) localStorage.setItem(apiKeyStorageKey(provider), value);
    },
    [modelValue],
  );

  /** 更新当前 run */
  const patchRun = useCallback((patch: Partial<ResearchRun> | ((r: ResearchRun) => Partial<ResearchRun>)) => {
    setRun((prev) => {
      if (!prev) return prev;
      const p = typeof patch === 'function' ? patch(prev) : patch;
      return { ...prev, ...p };
    });
  }, []);

  // ── 启动研究 ───────────────────────────────────────────────
  const start = useCallback(
    async (topicOverride?: string) => {
      if (!config || running) return;
      const t = (topicOverride ?? topic).trim();
      if (!t) return;

      // 校验 Key:服务器未配置且用户未输入 → 提示
      const provider = modelValue.slice(0, modelValue.indexOf(':'));
      const modelInfo = config.models.find((m) => `${m.provider}:${m.modelId}` === modelValue);
      if (!modelInfo?.available && !apiKey.trim()) {
        setRun({
          id: nextRunId(),
          topic: t,
          text: '',
          thinking: '',
          toolCalls: [],
          facts: [],
          done: true,
          error: `请先在"模型与 Key"卡片输入 API Key(${modelInfo?.envVar || `${provider.toUpperCase()}_API_KEY`}),或在服务器 .env 配置后重启。`,
        });
        return;
      }

      setRun({ id: nextRunId(), topic: t, text: '', thinking: '', toolCalls: [], facts: [], done: false });
      setRunning(true);

      const ac = new AbortController();
      abortRef.current = ac;

      const [prov, mid] = modelValue.split(':');
      try {
        await runResearch(
          t,
          { provider: prov, modelId: mid, apiKey: apiKey.trim() || undefined },
          {
            signal: ac.signal,
            onStage: (stage, toolName) => {
              if (stage === 'tool_start' && toolName) {
                patchRun((r) => ({ toolCalls: [...r.toolCalls, { name: toolName, status: 'running' }] }));
              } else if (stage === 'tool_end' && toolName) {
                patchRun((r) => ({
                  toolCalls: r.toolCalls.map((tc, i) =>
                    i === r.toolCalls.length - 1 && tc.name === toolName && tc.status === 'running'
                      ? { ...tc, status: 'done' }
                      : tc,
                  ),
                }));
              }
            },
            onDelta: (kind, delta) => {
              if (kind === 'text') patchRun((r) => ({ text: r.text + delta }));
              else patchRun((r) => ({ thinking: r.thinking + delta }));
            },
            onFact: (fact) => {
              patchRun((r) => ({ facts: [...r.facts, fact] }));
            },
            onError: (message) => {
              patchRun({ error: message });
            },
          },
        );
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          patchRun({ error: (e as Error).message || '研究失败' });
        }
      } finally {
        patchRun({ done: true });
        setRunning(false);
        abortRef.current = null;
      }
    },
    [config, running, topic, modelValue, apiKey, patchRun],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setRunning(false);
  }, []);

  /** 下载报告为 .md 文件 */
  const downloadReport = useCallback(() => {
    if (!run?.text) return;
    const blob = new Blob([run.text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    // 标题取报告首个一级/二级标题,否则用主题
    const titleMatch = run.text.match(/^#\s+(.+)$/m) || run.text.match(/^##\s+(.+)$/m);
    const title = (titleMatch ? titleMatch[1] : run.topic).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    a.href = url;
    a.download = `${title}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [run]);

  /** 报告字数(中文按字符计) */
  const wordCount = useMemo(() => (run?.text ? run.text.replace(/\s/g, '').length : 0), [run?.text]);

  if (configError) {
    return (
      <div className="page">
        <header className="hero hero--compact">
          <div className="hero__overlay">
            <h1>AI Research Agent</h1>
          </div>
        </header>
        <main className="container">
          <div className="card card--error">
            <h2>⚠️ 服务不可用</h2>
            <pre className="error-text">{configError}</pre>
            <p className="status">请确认后端已启动(pnpm --filter ai-research-agent dev,端口 3007)。</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="hero hero--compact">
        <div className="hero__overlay">
          <h1>🔍 AI Research Agent</h1>
          <p className="hero__sub">
            输入任意研究主题,Agent 自动制定计划、多源搜索(Web + HackerNews)、深读文章、收集事实,产出带引用来源的深度研究报告。
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
            {/* ── 主题输入 ── */}
            <section className="card topic-card">
              <h2>研究主题</h2>
              <div className="topic-row">
                <input
                  className="topic-input"
                  type="text"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void start();
                  }}
                  placeholder="如:2025 年 AI Agent 的发展现状与趋势"
                  disabled={running}
                  maxLength={500}
                />
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void start()}
                  disabled={running || !topic.trim()}
                >
                  {running ? '研究中…' : '开始研究'}
                </button>
                {running && (
                  <button type="button" className="btn" onClick={stop}>
                    停止
                  </button>
                )}
              </div>
              <div className="example-chips">
                {EXAMPLE_TOPICS.map((t) => (
                  <button key={t} type="button" className="chip" onClick={() => void start(t)} disabled={running}>
                    {t}
                  </button>
                ))}
              </div>
            </section>

            <ModelPicker
              config={config}
              value={modelValue}
              onChange={setModelValue}
              apiKey={apiKey}
              onApiKeyChange={handleApiKeyChange}
              disabled={running}
            />

            {/* ── 双栏:研究过程 | 报告 ── */}
            <div className="split">
              <section className="card process-card">
                <h2>研究过程</h2>
                <ResearchProcess run={run} />
              </section>

              <section className="card report-card">
                <div className="report-head">
                  <h2>研究报告</h2>
                  {run?.text && (
                    <div className="report-head__actions">
                      <span className="report-meta">{wordCount.toLocaleString()} 字</span>
                      <button type="button" className="btn btn--ghost btn--sm" onClick={downloadReport} disabled={running}>
                        ⬇ 下载 .md
                      </button>
                    </div>
                  )}
                </div>

                {run?.error && !run.text && <pre className="error-text">{run.error}</pre>}

                {run?.text ? (
                  <div className="report-body">
                    <Markdown text={run.text} />
                    {!run.done && <span className="caret" />}
                    <div ref={reportBottomRef} />
                  </div>
                ) : (
                  run && !run.error && (
                    <div className="process-empty">
                      {running ? (
                        <span className="status-line">
                          <span className="spinner" /> Agent 正在收集信息,报告将在此流式生成…
                        </span>
                      ) : (
                        '暂无报告。'
                      )}
                    </div>
                  )
                )}

                {!run && <div className="process-empty">报告将在此展示(支持标题/列表/表格/链接,可下载 .md)。</div>}
              </section>
            </div>
          </>
        )}

        <footer className="footer">
          基于 aipack Runtime(四层降级搜索 + HackerNews + 网页深读 + 事实收集)· 迁移自 awesome-llm-apps
        </footer>
      </main>
    </div>
  );
}
