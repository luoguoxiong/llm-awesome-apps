// starter_ai_agents/ai_medical_imaging_agent/frontend/src/App.tsx
// 主状态机：影像上传（浏览器压缩）→ 可选临床背景 → 模型选择 → SSE 流式诊断报告渲染。
//
// 迁移自 awesome-llm-apps/starter_ai_agents/ai_medical_imaging_agent（Streamlit）：
//   源应用上传医学影像交给 Gemini 2.5 Pro + DuckDuckGo 搜索，按固定 5 段结构
//   （影像类型与部位/关键发现/诊断评估/患者友好解释/研究背景）生成报告；
//   本实现将固定分析提示词内置到 aipack Runtime 系统提示，临床背景作为
//   可选补充信息随请求发送，报告以 Markdown 流式渲染。
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchConfig,
  streamAnalyze,
  apiKeyStorageKey,
  type ServerConfig,
  type ToolCallEntry,
} from './api';
import { fileToCompressedDataUri, estimateDataUriBytes, formatBytes } from './image';
import { ImageUploader } from './components/ImageUploader';
import { ModelPicker } from './components/ModelPicker';
import { ResultPanel } from './components/ResultPanel';

type Phase = 'idle' | 'processing' | 'running' | 'done';

export default function App() {
  // ── 服务配置与模型选择 ─────────────────────────────────────
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [modelValue, setModelValue] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [configError, setConfigError] = useState<string | null>(null);

  // ── 影像状态 ───────────────────────────────────────────────
  const [file, setFile] = useState<File | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);

  // ── 分析状态 ───────────────────────────────────────────────
  const [clinicalContext, setClinicalContext] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [text, setText] = useState('');
  const [thinking, setThinking] = useState('');
  const [toolCalls, setToolCalls] = useState<ToolCallEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const busy = phase === 'processing' || phase === 'running';

  // ── 初始化：拉取配置 ────────────────────────────────────────
  useEffect(() => {
    fetchConfig()
      .then((c) => {
        setConfig(c);
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

  const handleApiKeyChange = useCallback(
    (value: string) => {
      setApiKey(value);
      const provider = modelValue.slice(0, modelValue.indexOf(':'));
      if (provider) localStorage.setItem(apiKeyStorageKey(provider), value);
    },
    [modelValue],
  );

  // ── 影像选择：浏览器端压缩 ───────────────────────────────────
  const processFile = useCallback(async (f: File) => {
    setMediaError(null);
    if (!f.type.startsWith('image/')) {
      setFile(null);
      setImage(null);
      setMediaError(`不支持的文件类型 "${f.type || '未知'}"。请上传 PNG/JPG/WebP 等常见图片格式（DICOM 请先转换为 PNG/JPG）`);
      return;
    }
    setFile(f);
    setImage(null);
    setPhase('processing');
    try {
      const dataUri = await fileToCompressedDataUri(f);
      setImage(dataUri);
      setPhase('idle');
    } catch (e) {
      setImage(null);
      setPhase('idle');
      setMediaError(`影像预处理失败：${(e as Error).message}`);
    }
  }, []);

  // ── 执行分析（SSE） ─────────────────────────────────────────
  const run = useCallback(async () => {
    if (!config || !image) {
      setError('请先上传医学影像');
      return;
    }

    // 校验 Key：服务器未配置且用户未输入 → 提示
    const provider = modelValue.slice(0, modelValue.indexOf(':'));
    const modelInfo = config.models.find((m) => `${m.provider}:${m.modelId}` === modelValue);
    if (!modelInfo?.available && !apiKey.trim()) {
      setError(`请输入 API Key（${modelInfo?.envVar || `${provider.toUpperCase()}_API_KEY`}），或在服务器 .env 配置`);
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

    const [p, m] = modelValue.split(':');
    try {
      await streamAnalyze(
        {
          image,
          clinicalContext: clinicalContext.trim() || undefined,
          model: { provider: p, modelId: m, apiKey: apiKey.trim() || undefined },
        },
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
        setError((e as Error).message || '分析失败');
      }
    } finally {
      setPhase((prev) => (prev === 'running' ? 'done' : prev));
      abortRef.current = null;
    }
  }, [config, image, clinicalContext, modelValue, apiKey]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setPhase('done');
  }, []);

  const resetAll = useCallback(() => {
    setFile(null);
    setImage(null);
    setMediaError(null);
    setClinicalContext('');
  }, []);

  if (configError) {
    return (
      <div className="page">
        <header className="hero">
          <div className="hero__overlay">
            <h1>医学影像分析 Agent</h1>
          </div>
        </header>
        <main className="container">
          <div className="card card--error">
            <h2>⚠️ 服务不可用</h2>
            <pre className="error-text">{configError}</pre>
            <p className="status">请确认后端已启动（pnpm --filter ai-medical-imaging-agent dev，端口 3012）。</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="hero">
        <div className="hero__overlay">
          <h1>🩻 医学影像分析 Agent</h1>
          <p className="hero__sub">
            上传 X 光 / CT / MRI / 超声等医学影像，AI 以放射科专家视角输出 5 段式结构化诊断报告：影像类型与部位 ·
            关键发现 · 诊断评估 · 患者友好解释 · 研究背景（联网检索医学文献）。
          </p>
        </div>
      </header>

      <main className="container">
        <div className="disclaimer-banner">
          ⚠️ <strong>免责声明</strong>：本工具仅供教育与信息参考，所有分析结果应由执业医疗专业人员复核，
          请勿仅凭本分析做出任何医疗决策。
        </div>

        {!config ? (
          <div className="card">
            <p className="status">正在连接后端服务…</p>
          </div>
        ) : (
          <>
            <ImageUploader
              file={file}
              image={image}
              processing={phase === 'processing'}
              disabled={phase === 'running'}
              onPick={(f) => void processFile(f)}
              onClear={resetAll}
            />

            {mediaError && (
              <div className="card card--error">
                <pre className="error-text">{mediaError}</pre>
              </div>
            )}

            <section className="card">
              <h2>2 · 临床背景（可选）</h2>
              <textarea
                className="question-input"
                rows={3}
                value={clinicalContext}
                onChange={(e) => setClinicalContext(e.target.value)}
                placeholder="补充患者信息可提高分析质量，如：65 岁男性，咳嗽两周伴发热，关注肺部是否有感染征象"
                disabled={phase === 'running'}
              />
              <div className="actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void run()}
                  disabled={busy || !image}
                >
                  {phase === 'running' ? '分析中…' : '🔍 开始分析'}
                </button>
                {phase === 'running' && (
                  <button type="button" className="btn" onClick={stop}>
                    停止
                  </button>
                )}
                {image && (
                  <span className="status-inline">影像已就绪（{formatBytes(estimateDataUriBytes(image))}）</span>
                )}
              </div>
            </section>

            <ModelPicker
              config={config}
              value={modelValue}
              onChange={setModelValue}
              apiKey={apiKey}
              onApiKeyChange={handleApiKeyChange}
              disabled={phase === 'running'}
            />

            <ResultPanel
              phase={phase === 'processing' ? 'processing' : phase}
              text={text}
              thinking={thinking}
              toolCalls={toolCalls}
              error={error}
            />
          </>
        )}

        <footer className="footer">
          基于 aipack Runtime（多模态读片 + search_web 医学文献检索）· 仅供教育参考 · 迁移自 awesome-llm-apps
        </footer>
      </main>
    </div>
  );
}
