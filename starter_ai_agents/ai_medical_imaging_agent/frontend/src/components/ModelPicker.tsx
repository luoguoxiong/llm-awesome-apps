// starter_ai_agents/ai_medical_imaging_agent/frontend/src/components/ModelPicker.tsx
// 多模态模型选择器：模型下拉（仅 input 含 image 的模型，按 provider 分组，推理模型带 ✨）
// + API Key 输入（按 provider 联动 localStorage）。
import { useMemo, useState } from 'react';
import type { ServerConfig } from '../api';

interface ModelPickerProps {
  config: ServerConfig;
  /** 当前选中值：`${provider}:${modelId}` */
  value: string;
  onChange: (value: string) => void;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  disabled: boolean;
}

export function ModelPicker({ config, value, onChange, apiKey, onApiKeyChange, disabled }: ModelPickerProps) {
  const [showKey, setShowKey] = useState(false);

  const currentProvider = value.slice(0, value.indexOf(':')) || config.provider;
  const providerInfo = config.models.find((m) => m.provider === currentProvider);
  const providerAvailableOnServer = providerInfo?.available ?? false;
  const envVar = providerInfo?.envVar || `${currentProvider.toUpperCase()}_API_KEY`;

  // 模型下拉分组（按 provider；目录仅含多模态模型）
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
      <h2>3 · 分析模型</h2>
      <div className="form-row">
        <label className="field field--grow">
          <span>
            多模态模型 <span className="hint">（目录已过滤为支持图片输入的模型）</span>
          </span>
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
      </div>
      <div className="form-row">
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
              placeholder={providerAvailableOnServer ? '已用服务器配置，无需输入' : `输入 ${envVar}`}
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
      <div className="search-backend">
        文献搜索后端：<code>{config.searchBackend}</code>
      </div>
    </section>
  );
}
