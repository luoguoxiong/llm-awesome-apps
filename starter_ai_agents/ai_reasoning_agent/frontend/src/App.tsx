// starter_ai_agents/ai_reasoning_agent/frontend/src/App.tsx
// 主状态机:加载配置 → 普通/推理双模型选择(独立 Key 联动)→ 并行对比(SSE 流式)
// → 双栏渲染(推理侧含思考链)。
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchConfig,
  streamCompare,
  apiKeyStorageKey,
  type AgentSide,
  type ServerConfig,
  type StageStatus,
} from './api';
import { ModelPicker } from './components/ModelPicker';
import { ComparePanel } from './components/ComparePanel';

/** 内置示例问题(对齐源应用经典计数题 + 常见模型弱点题) */
const SAMPLE_QUESTIONS = [
  "supercalifragilisticexpialidocious 这个单词里有几个字母 'r'?",
  '9.11 和 9.9 哪个更大?请仔细比较。',
  '一个西瓜 10 元,买 3 个送 1 个,30 元最多能买几个西瓜?',
];

interface SideOutput {
  text: string;
  thinking: string;
}

const EMPTY_OUTPUT: SideOutput = { text: '', thinking: '' };
const PENDING_STATUS: Record<AgentSide, StageStatus> = { regular: 'pending', reasoning: 'pending' };

export default function App() {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [regularValue, setRegularValue] = useState('');
  const [reasoningValue, setReasoningValue] = useState('');
  const [regularKey, setRegularKey] = useState('');
  const [reasoningKey, setReasoningKey] = useState('');
  const [question, setQuestion] = useState(SAMPLE_QUESTIONS[0]);

  const [running, setRunning] = useState(false);
  const [outputs, setOutputs] = useState<Record<AgentSide, SideOutput>>({
    regular: EMPTY_OUTPUT,
    reasoning: EMPTY_OUTPUT,
  });
  const [status, setStatus] = useState<Record<AgentSide, StageStatus>>(PENDING_STATUS);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // ── 加载服务配置 ──────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    fetchConfig()
      .then((cfg) => {
        if (cancelled) return;
        setConfig(cfg);
        setRegularValue(`${cfg.defaultRegular.provider}:${cfg.defaultRegular.modelId}`);
        setReasoningValue(`${cfg.defaultReasoning.provider}:${cfg.defaultReasoning.modelId}`);
        // 回填 localStorage 中已保存的 API Key(按 provider)
        const rSaved = localStorage.getItem(apiKeyStorageKey(cfg.defaultRegular.provider));
        if (rSaved) setRegularKey(rSaved);
        const dSaved = localStorage.getItem(apiKeyStorageKey(cfg.defaultReasoning.provider));
        if (dSaved) setReasoningKey(dSaved);
      })
      .catch(() => {
        if (!cancelled) setError('无法连接服务,请确认后端已启动(pnpm --filter ai-reasoning-agent dev)');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── 模型/Key 联动(两侧独立;同一 provider 共享 localStorage 中的 Key)────
  const handleModelChange = (side: AgentSide) => (value: string) => {
    const provider = value.slice(0, value.indexOf(':'));
    const saved = localStorage.getItem(apiKeyStorageKey(provider)) || '';
    if (side === 'regular') {
      setRegularValue(value);
      setRegularKey(saved);
    } else {
      setReasoningValue(value);
      setReasoningKey(saved);
    }
  };

  const handleApiKeyChange = (side: AgentSide) => (value: string) => {
    const providerValue = side === 'regular' ? regularValue : reasoningValue;
    const provider = providerValue.slice(0, providerValue.indexOf(':'));
    localStorage.setItem(apiKeyStorageKey(provider), value);
    if (side === 'regular') setRegularKey(value);
    else setReasoningKey(value);
  };

  // ── 当前选中模型可读名 ────────────────────────────────────────
  const modelLabel = (value: string): string => {
    if (!config || !value) return '…';
    const [p, mid] = value.split(':');
    return config.models.find((m) => m.provider === p && m.modelId === mid)?.modelName ?? mid;
  };

  // ── 服务器是否已配置两侧 Key ──────────────────────────────────
  const providerAvailable = (value: string): boolean => {
    if (!config) return false;
    const p = value.slice(0, value.indexOf(':'));
    return config.models.find((m) => m.provider === p)?.available ?? false;
  };

  // ── 运行对比 ─────────────────────────────────────────────────
  const run = useCallback(async () => {
    const q = question.trim();
    if (!q) {
      setError('请输入问题');
      return;
    }
    if (!config) return;

    // 校验 Key:服务器未配置且用户未输入 → 提示
    const needRegularKey = !providerAvailable(regularValue);
    const needReasoningKey = !providerAvailable(reasoningValue);
    if (needRegularKey && !regularKey.trim()) {
      const p = regularValue.slice(0, regularValue.indexOf(':'));
      setError(`请为普通模型输入 API Key(${p.toUpperCase()}_API_KEY)`);
      return;
    }
    if (needReasoningKey && !reasoningKey.trim()) {
      const p = reasoningValue.slice(0, reasoningValue.indexOf(':'));
      setError(`请为推理模型输入 API Key(${p.toUpperCase()}_API_KEY)`);
      return;
    }

    const parse = (value: string, key: string) => {
      const idx = value.indexOf(':');
      return {
        provider: value.slice(0, idx),
        modelId: value.slice(idx + 1),
        apiKey: key.trim() || undefined,
      };
    };

    // 重置
    setError(null);
    setOutputs({ regular: EMPTY_OUTPUT, reasoning: EMPTY_OUTPUT });
    setStatus(PENDING_STATUS);
    setRunning(true);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      await streamCompare(
        {
          question: q,
          regularModel: parse(regularValue, needRegularKey ? regularKey : ''),
          reasoningModel: parse(reasoningValue, needReasoningKey ? reasoningKey : ''),
        },
        {
          signal: ac.signal,
          onStage(agent, stage) {
            setStatus((s) => ({ ...s, [agent]: stage === 'start' ? 'active' : 'done' }));
          },
          onDelta(agent, kind, delta) {
            setOutputs((o) => ({ ...o, [agent]: { ...o[agent], [kind]: o[agent][kind] + delta } }));
          },
          onDone() {
            setStatus({ regular: 'done', reasoning: 'done' });
          },
          onError(msg) {
            setError(msg);
          },
        },
      );
    } catch (e) {
      const err = e as Error;
      if (err.name !== 'AbortError') {
        setError(err.message || '生成失败');
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [question, config, regularValue, reasoningValue, regularKey, reasoningKey]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setRunning(false);
  }, []);

  return (
    <>
      <header className="hero">
        <div className="hero__overlay">
          <h1>🧠 AI Reasoning Agent</h1>
          <p className="hero__sub">
            普通模型 vs 推理模型 · 双栏并行流式对比 · 推理侧展示完整思考链 · 基于 aipack
          </p>
          {!config ? <div className="status">读取服务状态…</div> : null}
        </div>
      </header>

      <main className="container">
        {config && (
          <div className="pickers">
            <ModelPicker
              label="⚡ 普通模型(快思考)"
              config={config}
              value={regularValue}
              onChange={handleModelChange('regular')}
              apiKey={regularKey}
              onApiKeyChange={handleApiKeyChange('regular')}
              disabled={running}
            />
            <ModelPicker
              label="🧩 推理模型(慢思考)"
              config={config}
              value={reasoningValue}
              onChange={handleModelChange('reasoning')}
              apiKey={reasoningKey}
              onApiKeyChange={handleApiKeyChange('reasoning')}
              disabled={running}
            />
          </div>
        )}

        <section className="card form-card">
          <h2>提出问题</h2>
          <div className="form-row">
            <label className="field field--grow">
              <span>问题</span>
              <textarea
                rows={2}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="例如:计数、逻辑、数学等需要仔细推理的问题"
                disabled={running}
              />
            </label>
          </div>
          <div className="sample-row">
            <span className="sample-label">示例:</span>
            {SAMPLE_QUESTIONS.map((s, i) => (
              <button
                key={i}
                type="button"
                className="btn btn--ghost btn--sm sample-btn"
                onClick={() => setQuestion(s)}
                disabled={running}
                title={s}
              >
                示例 {i + 1}
              </button>
            ))}
          </div>
          <div className="form-row form-row--end">
            <div className="actions">
              {running ? (
                <button className="btn btn--ghost" onClick={cancel}>
                  取消
                </button>
              ) : null}
              <button className="btn btn--primary" onClick={run} disabled={running || !config}>
                {running ? '对比中…' : '开始对比'}
              </button>
            </div>
          </div>
        </section>

        <div className="compare-grid">
          <ComparePanel
            side="regular"
            emoji="⚡"
            title="普通模型 · 直接回答"
            modelLabel={modelLabel(regularValue)}
            status={status.regular}
            text={outputs.regular.text}
            thinking={outputs.regular.thinking}
          />
          <ComparePanel
            side="reasoning"
            emoji="🧩"
            title="推理模型 · 思考链 + 回答"
            modelLabel={modelLabel(reasoningValue)}
            status={status.reasoning}
            text={outputs.reasoning.text}
            thinking={outputs.reasoning.thinking}
          />
        </div>

        {error && (
          <section className="card error-card">
            <h2>⚠️ 出错了</h2>
            <pre className="error-text">{error}</pre>
          </section>
        )}
      </main>

      <footer className="footer">
        <span>
          Powered by{' '}
          <a href="https://github.com/luoguoxiong/aipack" target="_blank" rel="noopener noreferrer">
            aipack
          </a>
        </span>
      </footer>
    </>
  );
}
