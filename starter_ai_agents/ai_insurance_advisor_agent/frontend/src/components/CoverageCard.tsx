// starter_ai_agents/ai_insurance_advisor_agent/frontend/src/components/CoverageCard.tsx
// 本地保额计算结果卡片(对齐源应用的 Recommended Coverage + Step-by-step Coverage Math):
//   - 大数字展示推荐保额(本地公式,即时)
//   - 逐步计算表:年金系数 → 折现收入替代 → +债务 → −资产抵扣 → 推荐保额
import { computeLocalBreakdown, formatCurrency } from '../coverage';
import type { ClientProfile } from '../api';

interface CoverageCardProps {
  profile: ClientProfile;
}

export function CoverageCard({ profile }: CoverageCardProps) {
  const b = computeLocalBreakdown(profile);
  const currency = profile.currency;

  const steps: Array<{ label: string; value: string; sign?: '+' | '−' | '=' }> = [
    { label: '年金系数(annuity factor)', value: b.annuityFactor.toFixed(3) },
    { label: `折现收入替代需求(${b.years} 年 × 年收入)`, value: formatCurrency(b.discountedIncome, currency) },
    { label: '+ 债务偿还需求', value: formatCurrency(b.debt, currency), sign: '+' },
    { label: '− 储蓄与已有保额抵扣', value: `−${formatCurrency(b.assetsOffset, currency)}`, sign: '−' },
    { label: '= 推荐保额', value: formatCurrency(b.recommended, currency), sign: '=' },
  ];

  return (
    <section className="card coverage-card">
      <h2>推荐保额(本地确定性计算)</h2>
      <div className="coverage-hero">
        <div className="coverage-hero__amount">{formatCurrency(b.recommended, currency)}</div>
        <div className="coverage-hero__formula">
          max(0, {formatCurrency(b.discountedIncome, currency)} + {formatCurrency(b.debt, currency)} −{' '}
          {formatCurrency(b.assetsOffset, currency)}) · 实际折现率 {(b.realRate * 100).toFixed(1)}%
        </div>
      </div>
      <table className="calc-table">
        <thead>
          <tr>
            <th>计算步骤</th>
            <th className="calc-table__num">金额 / 数值</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => (
            <tr key={s.label} className={s.sign === '=' ? 'calc-row--result' : undefined}>
              <td>
                {s.sign && <span className="calc-sign">{s.sign} </span>}
                {s.label}
              </td>
              <td className="calc-table__num">{s.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="form-note">
        收入替代折现模型:annuity_factor = (1 − (1+r)^(−n)) / r;推荐保额 = max(0, 年收入 × 年金系数 + 债务 − 储蓄 − 已有保额)。
        该结果与 Agent 报告中的 compute_coverage 工具使用同一公式。
      </p>
    </section>
  );
}
