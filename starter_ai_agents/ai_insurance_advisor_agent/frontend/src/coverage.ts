// starter_ai_agents/ai_insurance_advisor_agent/frontend/src/coverage.ts
// 本地确定性保额计算(浏览器副本,与后端 tools/coverage.ts 同公式)——
// 对齐源应用 Streamlit 端的 compute_local_breakdown:表单提交后即时展示计算明细,
// 不依赖 LLM;即使未配置 API Key,核心保额结果也立即可见。
//
// 公式(与源应用一致):
//   annuity_factor    = (1 - (1 + r)^(-years)) / r    (r = 0 时退化为 years)
//   discounted_income = annual_income × annuity_factor
//   recommended       = max(0, discounted_income + total_debt - savings - existing_cover)
import type { ClientProfile } from './api';

/** 默认实际折现率 2%(与源应用一致) */
export const DEFAULT_REAL_RATE = 0.02;

export interface CoverageBreakdown {
  annualIncome: number;
  years: number;
  realRate: number;
  annuityFactor: number;
  discountedIncome: number;
  debt: number;
  savings: number;
  existingCover: number;
  assetsOffset: number;
  recommended: number;
}

/** 核心计算(输入已由表单约束为非负有限数) */
export function computeLocalBreakdown(profile: ClientProfile, realRate = DEFAULT_REAL_RATE): CoverageBreakdown {
  const income = Math.max(0, profile.annual_income);
  const years = Math.max(0, Math.round(profile.income_replacement_years));
  const debt = Math.max(0, profile.total_debt);
  const savings = Math.max(0, profile.available_savings);
  const existingCover = Math.max(0, profile.existing_life_insurance);

  let annuityFactor: number;
  if (realRate <= 0 || years === 0) {
    annuityFactor = years;
  } else {
    annuityFactor = (1 - Math.pow(1 + realRate, -years)) / realRate;
  }
  const discountedIncome = income * annuityFactor;
  const assetsOffset = savings + existingCover;
  const recommended = Math.max(0, discountedIncome + debt - assetsOffset);

  return {
    annualIncome: income,
    years,
    realRate,
    annuityFactor: Math.round(annuityFactor * 1e4) / 1e4,
    discountedIncome: Math.round(discountedIncome),
    debt,
    savings,
    existingCover,
    assetsOffset,
    recommended: Math.round(recommended),
  };
}

/** 支持的货币与符号 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: '¥',
  USD: '$',
  EUR: '€',
  GBP: '£',
  CAD: 'C$',
  AUD: 'A$',
  INR: '₹',
};

/** 格式化货币(千分位 + 符号;对齐源应用 format_currency) */
export function formatCurrency(amount: number, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()];
  const formatted = Math.round(amount).toLocaleString('en-US');
  return symbol ? `${symbol}${formatted}` : `${formatted} ${currency.toUpperCase()}`;
}
