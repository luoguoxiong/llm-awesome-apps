// starter_ai_agents/ai_breakup_recovery_agent/frontend/src/components/ModelPicker.tsx
// 陪伴模型选择器:模型下拉(全内置模型,按 provider 分组,推理模型带 ✨、
// 多模态模型带 🖼)+ API Key 输入(按 provider 联动 localStorage)。
import { useMemo, useState } from 'react';
import type { ServerConfig } from '../api';

interface ModelPickerProps {
  config: ServerConfig;
  /** 当前选中值:`${provider}:${modelId}` */
  value: string;
  onChange: (value: string) => void;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  disabled: boolean;
  /** 上传了截图时提示切换多模态模型 */
  hasScreenshots: boolean;
}

export function ModelPicker({
  config,
  value,
  onChange,
  apiKey,
  onApiKeyChange,
  disabled,
  hasScreenshots,
}: ModelPickerProps) {
  const [showKey, setShowKey] = useState(false);

  const currentProvider = value.slice(0, value.indexOf(':')) || config.provider;
  const currentModel = config.models.find((m) => `${m.provider}:${m.modelId}` === value);
  const providerAvailableOnServer = currentModel?.available ?? false;
  const envVar = currentModel?.envVar || `${currentProvider.toUpperCase()}_API_KEY`;
  // 上传了截图但当前模型不支持图片 → 醒目提示
  const needMultimodal = hasScreenshots && currentModel && !currentModel.multimodal;

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
          <span>陪伴模型</span>
          <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
            {groups.map(([provider, g]) => (
              <optgroup key={provider} label={g.name}>
                {g.items.map((m) => (
                  <option key={`${m.provider}:${m.modelId}`} value={`${m.provider}:${m.modelId}`}>
                    {m.modelName}
                    {m.multimodal ? ' 🖼' : ''}
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
      {needMultimodal && (
        <p className="picker-warn">
          ⚠️ 当前模型不支持图片输入,分析截图请切换到带 🖼 标记的多模态模型(如 google/gemini-2.0-flash)。
        </p>
      )}
      <div className="picker-meta">
        团队工具:<code>毒舌真相 → search_web</code>
        <span className="picker-meta__note">(搜索后端:{config.searchBackend})</span>
        <span className="picker-meta__note">· 🖼 支持截图 · ✨ 推理模型</span>
      </div>
    </section>
  );
}
