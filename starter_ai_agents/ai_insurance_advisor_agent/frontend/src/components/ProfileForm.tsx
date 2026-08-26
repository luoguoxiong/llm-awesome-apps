// starter_ai_agents/ai_insurance_advisor_agent/frontend/src/components/ProfileForm.tsx
// 客户资料表单(字段对齐源 Streamlit 表单:年龄/年收入/受抚养人/地区/总债务/储蓄/已有保险/货币/收入替代年限)。
// 默认值做了本地化适配(源应用为美国场景,本实现默认中国 + CNY)。
import type { ClientProfile } from '../api';

/** 货币选项(源应用的 6 种 + 迁移本地化的 CNY) */
export const CURRENCIES = ['CNY', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'INR'] as const;

/** 收入替代年限选项(与源应用一致:5/10/15) */
export const HORIZON_OPTIONS = [5, 10, 15] as const;

/** 表单默认值(本地化:中国 / CNY / 30 万年收入 / 50 万房贷债务) */
export const DEFAULT_PROFILE: ClientProfile = {
  age: 35,
  annual_income: 300000,
  dependents: 2,
  location: '中国',
  total_debt: 500000,
  available_savings: 100000,
  existing_life_insurance: 200000,
  income_replacement_years: 10,
  currency: 'CNY',
};

interface ProfileFormProps {
  profile: ClientProfile;
  onChange: (patch: Partial<ClientProfile>) => void;
  onSubmit: () => void;
  running: boolean;
}

export function ProfileForm({ profile, onChange, onSubmit, running }: ProfileFormProps) {
  return (
    <section className="card">
      <h2>客户资料</h2>
      <div className="form-row">
        <label className="field">
          <span>年龄(18~85)</span>
          <input
            type="number"
            min={18}
            max={85}
            value={profile.age}
            onChange={(e) => onChange({ age: Number(e.target.value) })}
            disabled={running}
          />
        </label>
        <label className="field">
          <span>年收入</span>
          <input
            type="number"
            min={0}
            step={10000}
            value={profile.annual_income}
            onChange={(e) => onChange({ annual_income: Number(e.target.value) })}
            disabled={running}
          />
        </label>
        <label className="field">
          <span>受抚养人数量</span>
          <input
            type="number"
            min={0}
            max={10}
            value={profile.dependents}
            onChange={(e) => onChange({ dependents: Number(e.target.value) })}
            disabled={running}
          />
        </label>
        <label className="field">
          <span>国家 / 地区(用于检索当地产品)</span>
          <input
            type="text"
            value={profile.location}
            placeholder="如:中国 / 美国 加州"
            onChange={(e) => onChange({ location: e.target.value })}
            disabled={running}
          />
        </label>
      </div>
      <div className="form-row">
        <label className="field">
          <span>总债务(含房贷)</span>
          <input
            type="number"
            min={0}
            step={10000}
            value={profile.total_debt}
            onChange={(e) => onChange({ total_debt: Number(e.target.value) })}
            disabled={running}
          />
        </label>
        <label className="field">
          <span>可供受抚养人使用的储蓄 / 投资</span>
          <input
            type="number"
            min={0}
            step={10000}
            value={profile.available_savings}
            onChange={(e) => onChange({ available_savings: Number(e.target.value) })}
            disabled={running}
          />
        </label>
        <label className="field">
          <span>已有人寿保险保额</span>
          <input
            type="number"
            min={0}
            step={10000}
            value={profile.existing_life_insurance}
            onChange={(e) => onChange({ existing_life_insurance: Number(e.target.value) })}
            disabled={running}
          />
        </label>
        <label className="field">
          <span>货币</span>
          <select
            value={profile.currency}
            onChange={(e) => onChange({ currency: e.target.value })}
            disabled={running}
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="form-row form-row--submit">
        <label className="field field--narrow">
          <span>收入替代年限</span>
          <select
            value={profile.income_replacement_years}
            onChange={(e) => onChange({ income_replacement_years: Number(e.target.value) })}
            disabled={running}
          >
            {HORIZON_OPTIONS.map((y) => (
              <option key={y} value={y}>
                {y} 年
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn--primary" onClick={onSubmit} disabled={running}>
          {running ? '正在生成保障建议…' : '🛡️ 生成保障建议与产品参考'}
        </button>
      </div>
      <p className="form-note">
        提交后立即展示本地保额计算(无需 API Key);Agent 报告需模型 Key,会流式生成计算明细与产品检索结果。
      </p>
    </section>
  );
}
