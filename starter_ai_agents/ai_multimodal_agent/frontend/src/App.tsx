// starter_ai_agents/ai_multimodal_agent/frontend/src/App.tsx
// 主状态机:媒体上传(图片压缩/视频抽帧)→ 模型选择 → SSE 流式分析渲染。
//
// 迁移自 awesome-llm-apps/starter_ai_agents/multimodal_ai_agent(Streamlit):
//   源应用上传视频交给 Gemini 2.5;本实现视频在浏览器端抽帧(见 frames.ts),
//   以多帧图片 + 问题发给后端,aipack Runtime 经 Request.media 传给多模态模型,
//   并挂载 search_web 工具实现 README 声称的 web research 能力。
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchConfig,
  streamAnalyze,
  apiKeyStorageKey,
  type ServerConfig,
  type ToolCallEntry,
} from './api';
import { fileToCompressedDataUri, extractVideoFrames, estimateDataUriBytes, formatBytes } from './frames';
import { MediaUploader, type MediaKind } from './components/MediaUploader';
import { ModelPicker } from './components/ModelPicker';
import { ResultPanel } from './components/ResultPanel';

const EXAMPLE_QUESTIONS = [
  '画面里有什么?请详细描述',
  '识别画面中的地标/物品,并搜索介绍它的背景',
  '按时间顺序总结这段视频发生了什么',
];

type Phase = 'idle' | 'processing' | 'running' | 'done';

export default function App() {
  // ── 服务配置与模型选择 ─────────────────────────────────────
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [modelValue, setModelValue] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [configError, setConfigError] = useState<string | null>(null);

  // ── 媒体状态 ───────────────────────────────────────────────
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<MediaKind | null>(null);
  const [frames, setFrames] = useState<string[]>([]);
  const [frameCount, setFrameCount] = useState(6);
  const [mediaError, setMediaError] = useState<string | null>(null);

  // ── 分析状态 ───────────────────────────────────────────────
  const [question, setQuestion] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [text, setText] = useState('');
  const [thinking, setThinking] = useState('');
  const [toolCalls, setToolCalls] = useState<ToolCallEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const busy = phase === 'processing' || phase === 'running';

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

  // ── 媒体选择:图片压缩 / 视频抽帧 ────────────────────────────
  const processFile = useCallback(
    async (f: File, videoFrames: number) => {
      setMediaError(null);
      const isImage = f.type.startsWith('image/');
      const isVideo = f.type.startsWith('video/');
      if (!isImage && !isVideo) {
        setFile(null);
        setKind(null);
        setFrames([]);
        setMediaError(`不支持的文件类型 "${f.type || '未知'}",请上传图片或视频`);
        return;
      }
      setFile(f);
      setKind(isImage ? 'image' : 'video');
      setFrames([]);
      setPhase('processing');
      try {
        const result = isImage
          ? [await fileToCompressedDataUri(f)]
          : await extractVideoFrames(f, videoFrames);
        setFrames(result);
        setPhase('idle');
      } catch (e) {
        setFrames([]);
        setPhase('idle');
        setMediaError(`媒体预处理失败:${(e as Error).message}`);
      }
    },
    [],
  );

  // ── 抽帧数变化:视频重新抽帧 ─────────────────────────────────
  const handleFrameCountChange = useCallback(
    (n: number) => {
      setFrameCount(n);
      if (file && kind === 'video' && !busy) void processFile(file, n);
    },
    [file, kind, busy, processFile],
  );

  // ── 执行分析(SSE) ─────────────────────────────────────────
  const run = useCallback(async () => {
    if (!config) return;
    const q = question.trim();
    if (!q) {
      setError('请输入问题');
      return;
    }
    if (frames.length === 0) {
      setError('请先上传图片或视频');
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

    const [p, m] = modelValue.split(':');
    try {
      await streamAnalyze(
        { question: q, media: frames, model: { provider: p, modelId: m, apiKey: apiKey.trim() || undefined } },
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
  }, [config, question, frames, modelValue, apiKey]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setPhase('done');
  }, []);

  const resetAll = useCallback(() => {
    setFile(null);
    setKind(null);
    setFrames([]);
    setMediaError(null);
    setQuestion('');
  }, []);

  if (configError) {
    return (
      <div className="page">
        <header className="hero">
          <div className="hero__overlay">
            <h1>Multimodal AI Agent</h1>
          </div>
        </header>
        <main className="container">
          <div className="card card--error">
            <h2>⚠️ 服务不可用</h2>
            <pre className="error-text">{configError}</pre>
            <p className="status">请确认后端已启动(pnpm --filter ai-multimodal-agent dev,端口 3003)。</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="hero">
        <div className="hero__overlay">
          <h1>🧬 Multimodal AI Agent</h1>
          <p className="hero__sub">
            上传图片或视频,提出问题——AI 先理解画面(视频自动抽取关键帧),再结合 web 搜索给出实用、可操作的回答。
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
            <MediaUploader
              file={file}
              kind={kind}
              frames={frames}
              frameCount={frameCount}
              onFrameCountChange={handleFrameCountChange}
              processing={phase === 'processing'}
              disabled={phase === 'running'}
              onPick={(f) => void processFile(f, frameCount)}
              onClear={resetAll}
            />

            {mediaError && (
              <div className="card card--error">
                <pre className="error-text">{mediaError}</pre>
              </div>
            )}

            <section className="card">
              <h2>2 · 你的问题</h2>
              <textarea
                className="question-input"
                rows={3}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder={
                  kind === 'video'
                    ? '针对这段视频提问,如:视频里发生了什么?按时间顺序总结'
                    : '针对图片提问,如:画面里是什么地方?搜索介绍一下它的历史'
                }
                disabled={phase === 'running'}
              />
              <div className="example-chips">
                {EXAMPLE_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    className="chip"
                    onClick={() => setQuestion(q)}
                    disabled={phase === 'running'}
                  >
                    {q}
                  </button>
                ))}
              </div>
              <div className="actions">
                <button type="button" className="btn btn--primary" onClick={() => void run()} disabled={busy}>
                  {phase === 'running' ? '分析中…' : '🔍 分析并研究'}
                </button>
                {phase === 'running' && (
                  <button type="button" className="btn" onClick={stop}>
                    停止
                  </button>
                )}
                {frames.length > 0 && (
                  <span className="status-inline">
                    已就绪 {frames.length} 张图({formatBytes(estimateDataUriBytes(frames))})
                  </span>
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
          基于 aipack Runtime(多模态 + search_web 工具)· 视频由浏览器抽帧分析 · 迁移自 awesome-llm-apps
        </footer>
      </main>
    </div>
  );
}
