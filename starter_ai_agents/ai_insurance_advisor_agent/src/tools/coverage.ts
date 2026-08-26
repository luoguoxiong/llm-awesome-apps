/**
 * starter_ai_agents/ai_insurance_advisor_agent/src/tools/coverage.ts
 *
 * 确定性保额计算工具(aipack Tool),等价替代源应用的 E2B 沙箱 run_python_code:
 *   - 源应用让 LLM 在 E2B 沙箱里跑 Python 计算「折现收入替代模型」保额;
 *   - 本实现将同一公式固化为本地工具,LLM 必须调用它获取数字,杜绝心算/编造。
 *
 * 公式(与源应用一致):
 *   annuity_factor    = (1 - (1 + r)^(-years)) / r    (r = 0 时退化为 years)
 *   discounted_income = annual_income × annuity_factor
 *   recommended       = max(0, discounted_income + total_debt - savings - existing_cover)
 * 默认实际折现率 r = 2%。
 */
import type { Tool } from '@aipack-ai/agent';

/** 计算输入(数值缺失按 0 处理,与源应用的 safe_number 语义一致) */
export interface CoverageInput {
  annual_income: number;
  income_replacement_years: number;
  total_debt: number;
  available_savings: number;
  existing_life_insurance: number;
  /** 实际折现率(小数形式,如 0.02);缺省 0.02 */
  real_discount_rate?: number;
}

/** 计算结果明细 */
export interface CoverageBreakdown {
  annual_income: number;
  income_replacement_years: number;
  real_discount_rate: number;
  annuity_factor: number;
  discounted_income: number;
  total_debt: number;
  assets_offset: number;
  recommended_coverage: number;
  formula: string;
}

/** 数值安全转换:非有限值/负数按 0 */
function safeNum(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 核心计算(前后端共用公式;前端 coverage.ts 为同逻辑的浏览器副本) */
export function computeCoverage(input: CoverageInput): CoverageBreakdown {
  const income = safeNum(input.annual_income);
  const years = Math.max(0, Math.round(safeNum(input.income_replacement_years)));
  const debt = safeNum(input.total_debt);
  const savings = safeNum(input.available_savings);
  const existing = safeNum(input.existing_life_insurance);
  // 折现率:接受小数(0.02)或百分数(2 / "2%")形式,与源应用 parse_percentage 语义一致
  let rate = 0.02;
  if (input.real_discount_rate !== undefined && input.real_discount_rate !== null) {
    const raw = typeof input.real_discount_rate === 'number' ? input.real_discount_rate : Number(String(input.real_discount_rate).replace('%', ''));
    if (Number.isFinite(raw)) {
      rate = raw < 1 ? Math.max(0, raw) : Math.max(0, raw / 100);
    }
  }

  let annuityFactor: number;
  if (rate <= 0 || years === 0) {
    annuityFactor = years;
  } else {
    annuityFactor = (1 - Math.pow(1 + rate, -years)) / rate;
  }
  const discountedIncome = income * annuityFactor;
  const assetsOffset = savings + existing;
  const recommended = Math.max(0, discountedIncome + debt - assetsOffset);

  return {
    annual_income: income,
    income_replacement_years: years,
    real_discount_rate: rate,
    annuity_factor: Math.round(annuityFactor * 1e4) / 1e4,
    discounted_income: Math.round(discountedIncome),
    total_debt: debt,
    assets_offset: assetsOffset,
    recommended_coverage: Math.round(recommended),
    formula: 'recommended = max(0, income × annuity_factor + debt − savings − existing_cover)',
  };
}

/** 导出 aipack Tool:LLM 调用以获取确定性计算结果 */
export function createCoverageTool(): Tool {
  return {
    name: 'compute_coverage',
    description:
      '计算人寿保险推荐保额(确定性数学,收入替代折现模型)。' +
      '收到客户资料后必须先调用本工具获取准确数字,不得自行估算。' +
      '输入客户资料数值,返回推荐保额与完整计算明细(年金系数/折现收入替代/债务/资产抵扣)。',
    parameters: {
      type: 'object',
      properties: {
        annual_income: { type: 'number', description: '客户年收入(与客户资料一致)' },
        income_replacement_years: { type: 'number', description: '收入替代年限(客户资料中的 5/10/15)' },
        total_debt: { type: 'number', description: '总债务(含房贷等)' },
        available_savings: { type: 'number', description: '可供受抚养人使用的储蓄与投资' },
        existing_life_insurance: { type: 'number', description: '已有人寿保险保额' },
        real_discount_rate: {
          type: 'number',
          description: '实际折现率,小数形式(如 0.02 = 2%),缺省 0.02',
        },
      },
      required: ['annual_income', 'income_replacement_years', 'total_debt', 'available_savings', 'existing_life_insurance'],
    },
    async execute(_toolCallId, args) {
      const a = (args ?? {}) as Partial<CoverageInput>;
      // 必填字段缺失 → 明确报错(引导 LLM 补全参数后重试)
      const required: Array<keyof CoverageInput> = [
        'annual_income',
        'income_replacement_years',
        'total_debt',
        'available_savings',
        'existing_life_insurance',
      ];
      const missing = required.filter((k) => a[k] === undefined || a[k] === null);
      if (missing.length > 0) {
        return {
          content: [{ type: 'text', text: `错误:缺少必填参数 ${missing.join(', ')}。请从客户资料中取值后重新调用。` }],
          details: { error: 'missing_params', missing },
        };
      }

      const result = computeCoverage(a as CoverageInput);
      const lines = [
        '[确定性保额计算结果]',
        `推荐保额(coverage_amount): ${result.recommended_coverage}`,
        '',
        '计算明细(breakdown):',
        `- 年收入: ${result.annual_income}`,
        `- 收入替代年限: ${result.income_replacement_years} 年`,
        `- 实际折现率: ${result.real_discount_rate * 100}%`,
        `- 年金系数(annuity_factor): ${result.annuity_factor}`,
        `- 折现收入替代需求: ${result.discounted_income}`,
        `- 债务偿还需求: ${result.total_debt}`,
        `- 资产与已有保额抵扣: -${result.assets_offset}`,
        `- 推荐保额 = max(0, 折现收入替代 + 债务 − 资产抵扣): ${result.recommended_coverage}`,
        '',
        `公式: ${result.formula}`,
        '报告中的所有保额数字必须与上述结果一致。',
      ];
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: { recommended: result.recommended_coverage, annuityFactor: result.annuity_factor },
      };
    },
  };
}
