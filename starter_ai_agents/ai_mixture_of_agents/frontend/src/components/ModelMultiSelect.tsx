// starter_ai_agents/ai_mixture_of_agents/frontend/src/components/ModelMultiSelect.tsx
// 参考模型多选:按 provider 分组的复选框网格,推理模型带 ✨,服务器已配 Key 的 provider 标 ✅。
// 上限 max(超过时禁用未选项,提示先取消)。
import { type ReactNode, useMemo } from 'react';
import type { ModelOption } from '../api';

interface ModelMultiSelectProps {
  models: ModelOption[];
  /** 已选中的 modelKey 列表(`${provider}:${modelId}`) */
  selected: string[];
  onToggle: (modelKey: string) => void;
  max: number;
  disabled: boolean;
}

export function ModelMultiSelect({ models, selected, onToggle, max, disabled }: ModelMultiSelectProps): ReactNode {
  const groups = useMemo(() => {
    const map = new Map<string, { name: string; items: ModelOption[] }>();
    for (const m of models) {
      if (!map.has(m.provider)) map.set(m.provider, { name: m.providerName, items: [] });
      map.get(m.provider)!.items.push(m);
    }
    return [...map.entries()];
  }, [models]);

  const atLimit = selected.length >= max;

  return (
    <div className="ms-groups">
      {groups.map(([provider, g]) => (
        <div key={provider} className="ms-group">
          <div className="ms-group__head">
            {g.name}
            {g.items.some((m) => m.available) && <span className="ms-group__ok" title="服务器已配置该 provider 的 Key">✅</span>}
          </div>
          {g.items.map((m) => {
            const key = `${m.provider}:${m.modelId}`;
            const checked = selected.includes(key);
            const lock = disabled || (atLimit && !checked);
            return (
              <label key={key} className={`ms-item ${checked ? 'ms-item--checked' : ''} ${lock ? 'ms-item--locked' : ''}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(key)}
                  disabled={lock}
                />
                <span className="ms-item__name">
                  {m.modelName}
                  {m.reasoning ? ' ✨' : ''}
                </span>
              </label>
            );
          })}
        </div>
      ))}
    </div>
  );
}
