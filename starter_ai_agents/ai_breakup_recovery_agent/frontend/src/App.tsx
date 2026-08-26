// starter_ai_agents/ai_breakup_recovery_agent/frontend/src/App.tsx
// 主状态机:感受自述 + 聊天截图(浏览器压缩)→ 模型选择 → SSE 流式
// 四 Agent 接力渲染(共情 → 告别信 → 7 天计划 → 毒舌真相)。
//
// 迁移自 awesome-llm-apps/starter_ai_agents/ai_breakup_recovery_agent
// (源应用:Streamlit + Agno + Gemini 2.0 Flash,四 Agent 依次执行各出一段;
//  本实现截图在浏览器端压缩为 data URI,经 Request.media 传给多模态模型,
//  毒舌真相 Agent 挂载 search_web 四层降级搜索)。
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchConfig,
  streamRecovery,
  apiKeyStorageKey,
  AGENT_META,
  type AgentId,
  type ServerConfig,
  type ToolCallEntry,
} from './api';
import { estimateDataUriBytes, formatBytes } from './images';
import { ScreenshotUploader } from './components/ScreenshotUploader';
import { ModelPicker } from './components/ModelPicker';
import { AgentCard, type AgentCardState } from './components/AgentCard';

type Phase = 'idle' | 'running' | 'done';

const EMPTY_AGENTS: Record<AgentId, AgentCardState> = {
  therapist: { status: 'pending', text: '', thinking: '', toolCalls: [] },
  closure: { status: 'pending', text: '', thinking: '', toolCalls: [] },
  routine: { status: 'pending', text: '', thinking: '', toolCalls: [] },
  honesty: { status: 'pending', text: '', thinking: '', toolCalls: [] },
};

export default function App() {
  // ── 服务配置与模型选择 ─────────────────────────────────────
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [modelValue, setModelValue] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [configError, setConfigError] = useState<string | null>(null);

  // ── 输入状态 ───────────────────────────────────────────────
  const [story, setStory] = useState('');
  const [screenshots, setScreenshots] = useState<string[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // ── 陪伴结果状态 ──────────────────────────────────────────
  const [phase, setPhase] = useState<Phase>('idle');
  const [agents, setAgents] = useState<Record<AgentId, AgentCardState>>(EMPTY_AGENTS);
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

  // ── 截图管理 ────────────────────────────────────────────────
  const addScreenshots = useCallback((uris: string[]) => {
    setScreenshots((prev) => [...prev, ...uris]);
  }, []);
  const removeScreenshotAt = useCallback((index: number) => {
    setScreenshots((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // ── 执行陪伴(SSE 四 Agent 接力) ──────────────────────────
  const run = useCallback(async () => {
    if (!config) return;
    const s = story.trim();
    if (!s && screenshots.length === 0) {
      setError('请先分享你的感受,或上传聊天截图(至少一项)');
      return;
    }

    // 校验 Key:服务器未配置且用户未输入 → 提示
    const provider = modelValue.slice(0, modelValue.indexOf(':'));
    const modelInfo = config.models.find((m) => `${m.provider}:${m.modelId}` === modelValue);
    if (!modelInfo?.available && !apiKey.trim()) {
      setError(`请输入 API Key(${modelInfo?.envVar || `${provider.toUpperCase()}_API_KEY`}),或在服务器 .env 配置`);
      return;
    }

    // 上传了截图但所选模型不支持图片 → 引导切换多模态模型
    if (screenshots.length > 0 && modelInfo && !modelInfo.multimodal) {
      setError('当前模型不支持图片输入,请在下方模型列表选择带 🖼 标记的多模态模型(如 google/gemini-2.0-flash)');
      return;
    }

    // 重置结果状态
    setError(null);
    setAgents(EMPTY_AGENTS);
    setPhase('running');

    const ac = new AbortController();
    abortRef.current = ac;

    const [p, m] = modelValue.split(':');
    try {
      await streamRecovery(
        { story: s, media: screenshots, model: { provider: p, modelId: m, apiKey: apiKey.trim() || undefined } },
        {
          signal: ac.signal,
          onStage: (stage, agent, toolName) => {
            if (!agent) return; // start / done 整体阶段由流结束推断
            if (stage === 'agent_start') {
              setAgents((prev) => ({ ...prev, [agent]: { ...prev[agent], status: 'running' } }));
            } else if (stage === 'agent_end') {
              setAgents((prev) => ({ ...prev, [agent]: { ...prev[agent], status: 'done' } }));
            } else if (stage === 'tool_start' && toolName) {
              setAgents((prev) => ({
                ...prev,
                [agent]: { ...prev[agent], toolCalls: [...prev[agent].toolCalls, { name: toolName, status: 'running' }] },
              }));
            } else if (stage === 'tool_end' && toolName) {
              setAgents((prev) => ({
                ...prev,
                [agent]: {
                  ...prev[agent],
                  toolCalls: prev[agent].toolCalls.map((t, i) =>
                    i === prev[agent].toolCalls.length - 1 && t.name === toolName ? { ...t, status: 'done' } : t,
                  ),
                },
              }));
            }
          },
          onDelta: (agent, kind, delta) => {
            setAgents((prev) => ({
              ...prev,
              [agent]: { ...prev[agent], [kind]: prev[agent][kind] + delta },
            }));
          },
          onError: (message) => setError(message),
        },
      );
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setError((e as Error).message || '陪伴请求失败');
      }
    } finally {
      setPhase((prev) => (prev === 'running' ? 'done' : prev));
      abortRef.current = null;
    }
  }, [config, story, screenshots, modelValue, apiKey]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setPhase('done');
  }, []);

  const resetAll = useCallback(() => {
    setStory('');
    setScreenshots([]);
    setUploadError(null);
    setAgents(EMPTY_AGENTS);
    setError(null);
    setPhase('idle');
  }, []);

  /** 导出四段回复为 Markdown 文件 */
  const exportMarkdown = useCallback(() => {
    const lines = ['# 分手恢复陪伴报告', '', `生成时间:${new Date().toLocaleString('zh-CN')}`, ''];
    if (story.trim()) {
      lines.push('## 我的自述', '', story.trim(), '');
    }
    for (const meta of AGENT_META) {
      const st = agents[meta.id];
      lines.push(`## ${meta.emoji} ${meta.title}`, '', st.text.trim() || '（无输出）', '');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `breakup-recovery-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [agents, story]);

  const hasAnyResult = AGENT_META.some((meta) => agents[meta.id].text.trim());

  if (configError) {
    return (
      <div className="page">
        <header className="hero">
          <div className="hero__overlay">
            <h1>Breakup Recovery Squad</h1>
          </div>
        </header>
        <main className="container">
          <div className="card card--error">
            <h2>⚠️ 服务不可用</h2>
            <pre className="error-text">{configError}</pre>
            <p className="status">请确认后端已启动(pnpm --filter ai-breakup-recovery-agent dev,端口 3008)。</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="hero">
        <div className="hero__overlay">
          <h1>💔 Breakup Recovery Squad</h1>
          <p className="hero__sub">
            你的 AI 分手恢复团队:共情陪伴师、告别仪式师、恢复计划师和毒舌真相官,
            陪你聊感受、读懂截图、写完没寄出的信,然后好好向前走。
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
              <h2>1 · 你的感受</h2>
              <textarea
                className="story-input"
                rows={5}
                value={story}
                onChange={(e) => setStory(e.target.value)}
                maxLength={4000}
                placeholder="说说发生了什么?你现在感觉怎么样?(可以慢慢写,也可以只传截图)"
                disabled={busy}
              />
              <p className="field-note">{story.length}/4000 · 与截图至少填写一项</p>
            </section>

            <ScreenshotUploader
              screenshots={screenshots}
              onAdd={addScreenshots}
              onRemoveAt={removeScreenshotAt}
              disabled={busy}
              error={uploadError}
              onPickError={setUploadError}
            />

            <ModelPicker
              config={config}
              value={modelValue}
              onChange={setModelValue}
              apiKey={apiKey}
              onApiKeyChange={handleApiKeyChange}
              disabled={busy}
              hasScreenshots={screenshots.length > 0}
            />

            <section className="card actions-card">
              <div className="actions">
                <button type="button" className="btn btn--primary" onClick={() => void run()} disabled={busy}>
                  {busy ? '团队陪伴中…' : '💝 开始陪伴'}
                </button>
                {busy && (
                  <button type="button" className="btn" onClick={stop}>
                    停止
                  </button>
                )}
                {!busy && hasAnyResult && (
                  <>
                    <button type="button" className="btn" onClick={exportMarkdown}>
                      导出 Markdown
                    </button>
                    <button type="button" className="btn btn--ghost" onClick={resetAll}>
                      重新开始
                    </button>
                  </>
                )}
                {screenshots.length > 0 && (
                  <span className="status-inline">
                    已就绪 {screenshots.length} 张截图({formatBytes(estimateDataUriBytes(screenshots))})
                  </span>
                )}
              </div>
              {error && <p className="form-error">{error}</p>}
            </section>

            <div className="agents-grid">
              {AGENT_META.map((meta) => (
                <AgentCard
                  key={meta.id}
                  id={meta.id}
                  emoji={meta.emoji}
                  title={meta.title}
                  subtitle={meta.subtitle}
                  state={agents[meta.id]}
                  active={busy}
                />
              ))}
            </div>
          </>
        )}

        <footer className="footer">
          基于 aipack Runtime(四 Agent 接力 + 聊天截图多模态分析 + search_web 工具)· 迁移自 awesome-llm-apps
        </footer>
      </main>
    </div>
  );
}
