// foreign_trade_apps/ai_trade_lead_agent/frontend/src/App.tsx
// 主状态机:产品关键词输入 → SSE 流式获客流水线 → 双栏展示:
// 左栏流水线过程(五阶段步骤条 + 工具徽标 + 候选清单 + 日志),
// 右栏客户卡片(核验结论 / 供应商 / 官网联系人 / AI 分析 / AI 开发信,可复制与导出)。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchConfig,
  runLeads,
  apiKeyStorageKey,
  nextRunId,
  type ServerConfig,
  type LeadRun,
  type Lead,
  type PipelineStage,
} from './api';
import { ModelPicker } from './components/ModelPicker';
import { PipelinePanel } from './components/PipelinePanel';
import { LeadCards } from './components/LeadCards';

const EXAMPLE_KEYWORDS = ['yoga mat', 'stainless steel tumbler', 'LED desk lamp', 'pet collar'];

export default function App() {
  // ── 服务配置与模型选择 ─────────────────────────────────────
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [modelValue, setModelValue] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [configError, setConfigError] = useState<string | null>(null);

  // ── 输入 ───────────────────────────────────────────────────
  const [keyword, setKeyword] = useState('');
  const [market, setMarket] = useState('United States');
  const [sellerProfile, setSellerProfile] = useState('');
  const [maxLeads, setMaxLeads] = useState(5);

  // ── 运行状态 ───────────────────────────────────────────────
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<LeadRun | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── 初始化:拉取配置 ────────────────────────────────────────
  useEffect(() => {
    fetchConfig()
      .then((c) => {
        setConfig(c);
        setModelValue(`${c.provider}:${c.model}`);
        setMaxLeads(c.defaultLeads || 5);
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

  /** 更新当前 run */
  const patchRun = useCallback((patch: Partial<LeadRun> | ((r: LeadRun) => Partial<LeadRun>)) => {
    setRun((prev) => {
      if (!prev) return prev;
      const p = typeof patch === 'function' ? patch(prev) : patch;
      return { ...prev, ...p };
    });
  }, []);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2000);
  }, []);

  // ── 启动流水线 ─────────────────────────────────────────────
  const start = useCallback(
    async (keywordOverride?: string) => {
      if (!config || running) return;
      const kw = (keywordOverride ?? keyword).trim();
      if (!kw) return;

      // 校验 Key:服务器未配置且用户未输入 → 提示
      const provider = modelValue.slice(0, modelValue.indexOf(':'));
      const modelInfo = config.models.find((m) => `${m.provider}:${m.modelId}` === modelValue);
      if (!modelInfo?.available && !apiKey.trim()) {
        setRun({
          id: nextRunId(),
          keyword: kw,
          leads: {},
          order: [],
          log: '',
          stages: {},
          current: null,
          analysis: {},
          emails: {},
          toolCalls: [],
          done: true,
          error: `请先在"模型与 Key"卡片输入 API Key(${modelInfo?.envVar || `${provider.toUpperCase()}_API_KEY`}),或在服务器 .env 配置后重启。`,
        });
        return;
      }

      setRun({
        id: nextRunId(),
        keyword: kw,
        leads: {},
        order: [],
        log: '',
        stages: {},
        current: null,
        analysis: {},
        emails: {},
        toolCalls: [],
        done: false,
      });
      setRunning(true);

      const ac = new AbortController();
      abortRef.current = ac;

      const [prov, mid] = modelValue.split(':');
      try {
        await runLeads(
          { keyword: kw, market: market.trim() || 'United States', sellerProfile: sellerProfile.trim(), maxLeads },
          { provider: prov, modelId: mid, apiKey: apiKey.trim() || undefined },
          {
            signal: ac.signal,
            onStage: (stage, label, leadId) => {
              if (stage === 'start') return;
              patchRun((r) => ({
                current: stage === 'done' ? 'done' : (stage as PipelineStage),
                stages: { ...r.stages, [stage]: label ?? r.stages[stage] ?? '' },
                // 单客户阶段:在日志中标记一行
                log: leadId ? r.log + `\n▸ ${label ?? stage}\n` : r.log,
              }));
            },
            onLog: (delta) => patchRun((r) => ({ log: r.log + delta })),
            onDelta: (target, leadId, delta) => {
              patchRun((r) =>
                target === 'analysis'
                  ? { analysis: { ...r.analysis, [leadId]: (r.analysis[leadId] ?? '') + delta } }
                  : { emails: { ...r.emails, [leadId]: (r.emails[leadId] ?? '') + delta } },
              );
            },
            onLead: (lead: Lead) => {
              patchRun((r) => ({
                leads: { ...r.leads, [lead.id]: lead },
                order: r.order.includes(lead.id) ? r.order : [...r.order, lead.id],
              }));
            },
            onTool: (phase, toolName) => {
              patchRun((r) => {
                if (phase === 'start') return { toolCalls: [...r.toolCalls, { name: toolName, status: 'running' }] };
                return {
                  toolCalls: r.toolCalls.map((tc, i) =>
                    i === r.toolCalls.length - 1 && tc.name === toolName && tc.status === 'running'
                      ? { ...tc, status: 'done' }
                      : tc,
                  ),
                };
              });
            },
            onError: (message) => patchRun({ error: message }),
          },
        );
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          patchRun({ error: (e as Error).message || '获客流水线失败' });
        }
      } finally {
        patchRun({ done: true, current: 'done' });
        setRunning(false);
        abortRef.current = null;
      }
    },
    [config, running, keyword, market, sellerProfile, maxLeads, modelValue, apiKey, patchRun],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setRunning(false);
  }, []);

  // ── 复制开发信 ─────────────────────────────────────────────
  const copyEmail = useCallback(
    (text: string, label: string) => {
      void navigator.clipboard
        .writeText(text)
        .then(() => showToast(`已复制 ${label} 的开发信`))
        .catch(() => showToast('复制失败,请手动选择文本'));
    },
    [showToast],
  );

  // ── 导出全部客户报告(.md)─────────────────────────────────
  const exportMarkdown = useCallback(() => {
    if (!run) return;
    const leads = run.order.map((id) => run.leads[id]).filter(Boolean);
    const lines: string[] = [
      `# 外贸获客报告:${run.keyword}`,
      '',
      `- 目标市场:${market || 'United States'}`,
      `- 线索数量:${leads.length}`,
      `- 生成时间:${new Date().toLocaleString()}`,
      '',
    ];
    for (const l of leads) {
      lines.push(`## ${l.name}`);
      lines.push('');
      lines.push(`- 地区:${[l.city, l.country].filter(Boolean).join(', ') || '未知'}`);
      lines.push(`- 采购判定:${l.verdict ?? '未知'}${l.verdictReason ? ` — ${l.verdictReason}` : ''}`);
      if (l.suppliers?.length) lines.push(`- 供应商/产地:${l.suppliers.join('、')}`);
      if (l.contact?.website) lines.push(`- 官网:${l.contact.website}`);
      if (l.contact?.linkedin) lines.push(`- LinkedIn:${l.contact.linkedin}`);
      if (l.contact?.emails?.length) lines.push(`- 邮箱:${l.contact.emails.join('、')}`);
      if (l.contact?.people?.length) lines.push(`- 关键人:${l.contact.people.join(';')}`);
      lines.push('');
      if (run.analysis[l.id]) lines.push(run.analysis[l.id], '');
      if (run.emails[l.id]) lines.push('### 开发信', '', run.emails[l.id], '');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `外贸获客-${run.keyword.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)}.md`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('已导出 Markdown 报告');
  }, [run, market, showToast]);

  /** 已完成开发信的客户数 */
  const emailCount = useMemo(() => (run ? Object.keys(run.emails).length : 0), [run]);

  if (configError) {
    return (
      <div className="page">
        <header className="hero hero--compact">
          <div className="hero__overlay">
            <h1>AI 外贸获客 Agent</h1>
          </div>
        </header>
        <main className="container">
          <div className="card card--error">
            <h2>⚠️ 服务不可用</h2>
            <pre className="error-text">{configError}</pre>
            <p className="status">请确认后端已启动(pnpm --filter ai-trade-lead-agent dev,端口 3013)。</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="hero hero--compact">
        <div className="hero__overlay">
          <h1>🌍 AI 外贸获客 Agent</h1>
          <p className="hero__sub">
            输入产品关键词:Agent 自动走完 ImportYeti 找美国进口商 → 查供应商判断是否在采购 → Google/LinkedIn 找官网与联系人 →
            AI 客户分析 → AI 生成个性化开发信。
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
            {/* ── 关键词与参数 ── */}
            <section className="card topic-card">
              <h2>产品关键词</h2>
              <div className="topic-row">
                <input
                  className="topic-input"
                  type="text"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void start();
                  }}
                  placeholder="英文关键词效果更佳,如 yoga mat / stainless steel tumbler"
                  disabled={running}
                  maxLength={200}
                />
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void start()}
                  disabled={running || !keyword.trim()}
                >
                  {running ? '获客中…' : '开始获客'}
                </button>
                {running && (
                  <button type="button" className="btn" onClick={stop}>
                    停止
                  </button>
                )}
              </div>
              <div className="example-chips">
                {EXAMPLE_KEYWORDS.map((k) => (
                  <button key={k} type="button" className="chip" onClick={() => void start(k)} disabled={running}>
                    {k}
                  </button>
                ))}
              </div>
              <div className="form-row">
                <label className="field">
                  <span>目标市场</span>
                  <input
                    type="text"
                    value={market}
                    onChange={(e) => setMarket(e.target.value)}
                    disabled={running}
                    maxLength={80}
                  />
                </label>
                <label className="field">
                  <span>候选进口商数量</span>
                  <select value={maxLeads} onChange={(e) => setMaxLeads(Number(e.target.value))} disabled={running}>
                    {[3, 5, 8, 10].map((n) => (
                      <option key={n} value={n}>
                        {n} 家
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field field--grow">
                  <span>我方公司/优势(用于个性化开发信,可选)</span>
                  <input
                    type="text"
                    value={sellerProfile}
                    onChange={(e) => setSellerProfile(e.target.value)}
                    placeholder="如:宁波 XX 家居,14 年瑜伽垫代工,BSCI/GRS 认证,MOQ 500"
                    disabled={running}
                    maxLength={300}
                  />
                </label>
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

            {/* ── 双栏:流水线过程 | 客户卡片 ── */}
            <div className="split">
              <section className="card process-card">
                <h2>获客流水线</h2>
                <PipelinePanel run={run} />
              </section>

              <section className="card report-card">
                <div className="report-head">
                  <h2>客户与开发信</h2>
                  {run && Object.keys(run.leads).length > 0 && (
                    <div className="report-head__actions">
                      <span className="report-meta">{emailCount} 封开发信</span>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={exportMarkdown}
                        disabled={running}
                      >
                        ⬇ 导出 .md
                      </button>
                    </div>
                  )}
                </div>
                {run?.error && Object.keys(run.leads).length === 0 && <pre className="error-text">{run.error}</pre>}
                <LeadCards run={run} onCopy={copyEmail} />
              </section>
            </div>
          </>
        )}

        <footer className="footer">
          基于 aipack Runtime(ImportYeti 海关数据 + 多层降级检索 + 官网抓取 + 结构化线索库)· 原创外贸获客应用
        </footer>
      </main>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
