// starter_ai_agents/ai_music_generator_agent/frontend/src/components/ModelPicker.tsx
// 模型与 Key 选择器:编排模型下拉(全内置模型,按 provider 分组,推理模型带 ✨)
// + LLM API Key 输入(按 provider 联动 localStorage)
// + ModelsLab API Key 输入(音乐生成必需;源应用侧栏双 Key 布局的等价实现)。
import { useMemo, useState } from 'react';
import type { ServerConfig } from '../api';

interface ModelPickerProps {
  config: ServerConfig;
  /** 当前选中值:`${provider}:${modelId}` */
  value: string;
  onChange: (value: string) => void;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  /** ModelsLab API Key(音乐生成) */
  modelslabKey: string;
  onModelslabKeyChange: (value: string) => void;
  disabled: boolean;
}

export function ModelPicker({
  config,
  value,
  onChange,
  apiKey,
  onApiKeyChange,
  modelslabKey,
  onModelslabKeyChange,
  disabled,
}: ModelPickerProps) {
  const [showKey, setShowKey] = useState(false);
  const [showMlKey, setShowMlKey] = useState(false);

  const currentProvider = value.slice(0, value.indexOf(':')) || config.provider;
  const providerInfo = config.models.find((m) => m.provider === currentProvider);
  const providerAvailableOnServer = providerInfo?.available ?? false;
  const envVar = providerInfo?.envVar || `${currentProvider.toUpperCase()}_API_KEY`;

  // 模型下拉分组(按 provider)
  const groups = useMemo(() => {
    const map = new Map<string, { name: string; items: typeof config.models }>();
    for (const m of config.models) {
      if (!map.has(m.provider)) map.set(m.provider, { name: m.providerName, items: [] });
      map.get(m.provider)!.items.push(m);
    }
    return [...map.entries()];
  }, [config.models]);

  return (
    <section className="card picker-card">
      <h2>模型与 Key</h2>
      <div className="form-row">
        <label className="field field--grow">
          <span>编排模型</span>
          <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
            {groups.map(([provider, g]) => (
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
        <label className="field field--grow">
          <span>
            API Key{' '}
            <span className={`hint ${providerAvailableOnServer ? 'hint--ok' : ''}`}>
              {providerAvailableOnServer ? '✅ 已用服务器配置' : `需要 ${envVar}`}
            </span>
          </span>
          <div className="input-with-toggle">
            <input
              type={showKey ? 'text' : 'password'}
              value={providerAvailableOnServer ? '' : apiKey}
              placeholder={providerAvailableOnServer ? '已用服务器配置,无需输入' : `输入 ${envVar}`}
              onChange={(e) => onApiKeyChange(e.target.value)}
              disabled={disabled || providerAvailableOnServer}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setShowKey((v) => !v)}
              aria-label="显示/隐藏 API Key"
              disabled={disabled}
            >
              👁
            </button>
          </div>
        </label>
      </div>
      <div className="form-row">
        <label className="field field--grow">
          <span>
            ModelsLab API Key(音乐生成){' '}
            <span className={`hint ${config.musicReady ? 'hint--ok' : ''}`}>
              {config.musicReady ? '✅ 已用服务器配置' : '未配置,生成前需输入'}
            </span>
          </span>
          <div className="input-with-toggle">
            <input
              type={showMlKey ? 'text' : 'password'}
              value={config.musicReady ? '' : modelslabKey}
              placeholder={config.musicReady ? '已用服务器配置,无需输入' : '输入 ModelsLab API Key'}
              onChange={(e) => onModelslabKeyChange(e.target.value)}
              disabled={disabled || config.musicReady}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setShowMlKey((v) => !v)}
              aria-label="显示/隐藏 ModelsLab Key"
              disabled={disabled}
            >
              👁
            </button>
          </div>
        </label>
      </div>
      <div className="picker-meta">
        音乐生成:<code>ModelsLab v6/voice/music_gen</code> · 输出 MP3(内嵌播放器,支持下载)
        <span className="picker-meta__note">(切换模型后原会话上下文不延续)</span>
      </div>
    </section>
  );
}
