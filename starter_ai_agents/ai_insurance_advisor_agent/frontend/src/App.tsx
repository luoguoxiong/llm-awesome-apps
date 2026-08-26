// starter_ai_agents/ai_insurance_advisor_agent/frontend/src/App.tsx
// 主状态机:客户资料表单 → 本地保额计算(即时)+ Agent 流式报告(SSE)。
//
// 迁移自 awesome-llm-apps/starter_ai_agents/ai_life_insurance_advisor_agent(Streamlit 表单):
//   源应用:表单提交 → Agno Agent(E2B 沙箱算保额 + Firecrawl 搜产品)→ JSON 结果渲染;
//   本实现:同一表单字段,保额本地公式即时计算(等价源应用的 compute_local_breakdown),
//   Agent 报告经 /api/advise SSE 流式生成,保额数字由 compute_coverage 工具保证确定性。
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchConfig,
  streamAdvise,
  apiKeyStorageKey,
  type ServerConfig,
  type ClientProfile,
  type ToolCallEntry,
} from './api';
import { ModelPicker } from './components/ModelPicker';
import { ProfileForm, DEFAULT_PROFILE } from './components/ProfileForm';
import { CoverageCard } from './components/CoverageCard';
import { ReportPanel, type ReportState } from './components/ReportPanel';

const EMPTY_REPORT: ReportState = { text: '', thinking: '', toolCalls: [], done: false, error: null };

export default function App() {
  // ── 服务配置与模型选择 ─────────────────────────────────────
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [modelValue, setModelValue] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [configError, setConfigError] = useState<string | null>(null);

  // ── 客户资料表单 ───────────────────────────────────────────
  const [profile, setProfile] = useState<ClientProfile>(DEFAULT_PROFILE);

  // ── 报告状态 ───────────────────────────────────────────────
  const [report, setReport] = useState<ReportState>(EMPTY_REPORT);
  const [running, setRunning] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

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

  const patchProfile = useCallback((patch: Partial<ClientProfile>) => {
    setProfile((prev) => ({ ...prev, ...patch }));
  }, []);

  /** 更新报告状态 */
  const patchReport = useCallback((patch: Partial<ReportState> | ((r: ReportState) => Partial<ReportState>)) => {
    setReport((prev) => {
      const p = typeof patch === 'function' ? patch(prev) : patch;
      return { ...prev, ...p };
    });
  }, []);

  // ── 提交表单:本地计算立即展示 + Agent 报告流式生成 ──────────
  const submit = useCallback(async () => {
    if (!config || running) return;
    setSubmitted(true);
    setReport(EMPTY_REPORT);

    // 校验 Key:服务器未配置且用户未输入 → 本地计算照常展示,报告区给出引导
    const provider = modelValue.slice(0, modelValue.indexOf(':'));
    const modelInfo = config.models.find((m) => `${m.provider}:${m.modelId}` === modelValue);
    if (!modelInfo?.available && !apiKey.trim()) {
      setReport({
        ...EMPTY_REPORT,
        done: true,
        error:
          `⚠️ 未配置 ${modelInfo?.envVar || `${provider.toUpperCase()}_API_KEY`}:上方保额计算仍有效(本地公式),` +
          '但要生成完整报告(计算明细 + 产品检索),请在"模型与 Key"卡片输入 API Key,或在服务器 .env 配置后重启。',
      });
      return;
    }

    setRunning(true);
    const ac = new AbortController();
    abortRef.current = ac;

    const [prov, mid] = modelValue.split(':');
    try {
      await streamAdvise(
        {
          profile,
          model: { provider: prov, modelId: mid, apiKey: apiKey.trim() || undefined },
        },
        {
          signal: ac.signal,
          onStage: (stage, toolName) => {
            if (stage === 'tool_start' && toolName) {
              patchReport((r) => ({ toolCalls: [...r.toolCalls, { name: toolName, status: 'running' }] as ToolCallEntry[] }));
            } else if (stage === 'tool_end' && toolName) {
              patchReport((r) => ({
                toolCalls: r.toolCalls.map((t, i) =>
                  i === r.toolCalls.length - 1 && t.name === toolName ? { ...t, status: 'done' } : t,
                ),
              }));
            }
          },
          onDelta: (kind, delta) => {
            if (kind === 'text') patchReport((r) => ({ text: r.text + delta }));
            else patchReport((r) => ({ thinking: r.thinking + delta }));
          },
          onError: (message) => {
            patchReport((r) => ({ error: r.error ? `${r.error}\n${message}` : message }));
          },
        },
      );
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        const msg = (e as Error).message || '报告生成失败';
        patchReport((r) => ({ error: r.error ? `${r.error}\n${msg}` : msg }));
      }
    } finally {
      patchReport({ done: true });
      setRunning(false);
      abortRef.current = null;
    }
  }, [config, running, profile, modelValue, apiKey, patchReport]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setRunning(false);
  }, []);

  if (configError) {
    return (
      <div className="page">
        <header className="hero hero--compact">
          <div className="hero__overlay">
            <h1>AI 保险保障顾问</h1>
          </div>
        </header>
        <main className="container">
          <div className="card card--error">
            <h2>⚠️ 服务不可用</h2>
            <pre className="error-text">{configError}</pre>
            <p className="status">请确认后端已启动(pnpm --filter ai-insurance-advisor-agent dev,端口 3009)。</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="hero hero--compact">
        <div className="hero__overlay">
          <h1>🛡️ AI 保险保障顾问</h1>
          <p className="hero__sub">
            填写客户资料,即刻获得定期寿险保额建议——收入替代折现模型本地确定性计算 + Agent 检索当地产品并流式生成结构化报告。
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
            <ModelPicker
              config={config}
              value={modelValue}
              onChange={setModelValue}
              apiKey={apiKey}
              onApiKeyChange={handleApiKeyChange}
              disabled={running}
            />

            <ProfileForm profile={profile} onChange={patchProfile} onSubmit={() => void submit()} running={running} />

            {submitted && (
              <>
                <CoverageCard profile={profile} />
                <ReportPanel report={report} running={running} onStop={stop} />
              </>
            )}
          </>
        )}

        <footer className="footer">
          基于 aipack Runtime(确定性保额工具 + 四层降级搜索)· 本应用仅供教育参考,不构成持牌保险或财务建议 · 迁移自
          awesome-llm-apps
        </footer>
      </main>
    </div>
  );
}
