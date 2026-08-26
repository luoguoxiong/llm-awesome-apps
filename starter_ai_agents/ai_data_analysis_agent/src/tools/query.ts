/**
 * starter_ai_agents/ai_data_analysis_agent/src/tools/query.ts
 *
 * 数据查询工具(aipack Tool),源应用 DuckDbTools(自然语言 → SQL)的免 SQL 等价实现:
 *   - get_data_summary:表结构与统计概览(列/类型/缺失/唯一值/数值范围 + 样例行)
 *   - query_data:结构化查询(filters 过滤 / groupBy 分组 / aggregations 聚合 / sort 排序 / limit 截断)
 *
 * 相比 SQL 字符串,结构化 JSON 参数更稳健(无注入、无方言歧义),覆盖分析类问题的主路径:
 * 聚合对比 / 过滤明细 / 分组统计 / Top-N。返回 Markdown 表格供 LLM 直接引用。
 */
import type { Tool } from '@aipack-ai/agent';
import type { Dataset, ColumnType } from '../dataset.js';

/** 工具输出表格的最大行数 */
const MAX_OUTPUT_ROWS = 50;

// ─── 参数类型(工具入参的 TS 视图)────────────────────────────────

type AggFn = 'count' | 'sum' | 'avg' | 'min' | 'max';
type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains';

interface AggregationSpec {
  column?: string;
  fn?: string;
  alias?: string;
}

interface FilterSpec {
  column?: string;
  op?: string;
  value?: unknown;
}

interface QueryArgs {
  groupBy?: unknown;
  aggregations?: unknown;
  filters?: unknown;
  sort?: { column?: string; direction?: string };
  limit?: number;
}

// ─── 工具:get_data_summary ──────────────────────────────────────

export function createSummaryTool(dataset: Dataset): Tool {
  return {
    name: 'get_data_summary',
    description:
      '查看数据集的结构概览:总行数、每列的类型(number/date/string)、缺失数、唯一值数、' +
      '数值列的 min/max/mean,以及前 5 行样例数据。首次分析数据或不确定列结构时先调用此工具。',
    parameters: {
      type: 'object',
      properties: {},
    },
    async execute() {
      const lines: string[] = [
        `[数据集] ${dataset.name} · 共 ${dataset.rows.length} 行 × ${dataset.columns.length} 列`,
        '',
        '| 列名 | 类型 | 缺失 | 唯一值 | 数值范围 |',
        '| --- | --- | --- | --- | --- |',
      ];
      for (let i = 0; i < dataset.columns.length; i++) {
        const col = dataset.columns[i];
        const type = dataset.types[i];
        const values = dataset.rows.map((r) => r[col]);
        const nonNull = values.filter((v) => v != null);
        const unique = new Set(nonNull.map((v) => String(v))).size;
        let range = '—';
        if (type === 'number') {
          const nums = nonNull.map((v) => Number(v)).filter((n) => isFinite(n));
          if (nums.length) {
            const min = Math.min(...nums);
            const max = Math.max(...nums);
            const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
            range = `${fmt(min)} ~ ${fmt(max)}(均值 ${fmt(mean)})`;
          }
        } else if (type === 'date') {
          const sorted = nonNull.map(String).sort();
          if (sorted.length) range = `${sorted[0]} ~ ${sorted[sorted.length - 1]}`;
        }
        lines.push(`| ${col} | ${type} | ${values.length - nonNull.length} | ${unique} | ${range} |`);
      }
      lines.push('', '前 5 行样例:', '', toMarkdownTable(dataset.columns, dataset.rows.slice(0, 5)));
      return { content: [{ type: 'text', text: lines.join('\n') }], details: {} };
    },
  };
}

// ─── 工具:query_data ────────────────────────────────────────────

export function createQueryTool(dataset: Dataset): Tool {
  return {
    name: 'query_data',
    description:
      '对数据集执行结构化查询并返回 Markdown 表格。参数:' +
      'filters(行过滤,支持 eq/ne/gt/gte/lt/lte/contains)、' +
      'groupBy(分组列,可多列)、aggregations(聚合:{column, fn: count|sum|avg|min|max, alias})、' +
      'sort({column, direction: asc|desc})、limit(返回行数上限)。' +
      '不传 groupBy/aggregations 时返回过滤后的明细行。回答数值对比/统计/Top-N 问题时调用。',
    parameters: {
      type: 'object',
      properties: {
        filters: {
          type: 'array',
          description: '行过滤条件数组,全部满足(AND)',
          items: {
            type: 'object',
            properties: {
              column: { type: 'string', description: '过滤列名' },
              op: { type: 'string', description: '操作符:eq/ne/gt/gte/lt/lte/contains' },
              value: { description: '比较值(数值或字符串)' },
            },
            required: ['column', 'op', 'value'],
          },
        },
        groupBy: {
          type: 'array',
          description: '分组列名数组,如 ["category"]',
          items: { type: 'string' },
        },
        aggregations: {
          type: 'array',
          description: '聚合列表;不传且无 groupBy 时返回明细行',
          items: {
            type: 'object',
            properties: {
              column: { type: 'string', description: '聚合列(count 可省略)' },
              fn: { type: 'string', description: 'count/sum/avg/min/max' },
              alias: { type: 'string', description: '结果列名,缺省为 fn(column)' },
            },
            required: ['fn'],
          },
        },
        sort: {
          type: 'object',
          description: '排序:{column, direction: asc|desc}',
          properties: {
            column: { type: 'string' },
            direction: { type: 'string', description: 'asc 或 desc,默认 desc' },
          },
        },
        limit: { type: 'number', description: '返回行数上限,默认 50' },
      },
    },
    async execute(_toolCallId, args) {
      try {
        const text = runQuery(dataset, (args ?? {}) as QueryArgs);
        return { content: [{ type: 'text', text }], details: {} };
      } catch (err) {
        return { content: [{ type: 'text', text: `查询出错:${(err as Error).message}` }], details: { error: true } };
      }
    },
  };
}

// ─── 查询引擎 ────────────────────────────────────────────────────

function runQuery(ds: Dataset, args: QueryArgs): string {
  // 1) 过滤
  let rows = ds.rows;
  const filters = Array.isArray(args.filters) ? (args.filters as FilterSpec[]) : [];
  for (const f of filters) {
    rows = applyFilter(rows, f, ds);
  }

  const groupBy = Array.isArray(args.groupBy) ? (args.groupBy as string[]) : [];
  const aggs = Array.isArray(args.aggregations) ? (args.aggregations as AggregationSpec[]) : [];

  let outColumns: string[];
  let outRows: Record<string, unknown>[];
  let mode: string;

  // 2) 分组聚合 或 明细
  if (groupBy.length > 0 || aggs.length > 0) {
    const spec = aggs.map((a) => normalizeAgg(a, ds));
    outRows = aggregate(rows, groupBy.filter((c) => ds.columns.includes(c)), spec);
    outColumns = [...groupBy.filter((c) => ds.columns.includes(c)), ...spec.map((s) => s.alias)];
    mode = groupBy.length > 0 ? '分组聚合' : '全表聚合';
  } else {
    outColumns = ds.columns;
    outRows = rows;
    mode = '明细查询';
  }

  // 3) 排序
  if (args.sort?.column) {
    const col = args.sort.column;
    const dir = (args.sort.direction || 'desc').toLowerCase() === 'asc' ? 1 : -1;
    outRows = [...outRows].sort((a, b) => {
      const av = a[col];
      const bv = b[col];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv), 'zh') * dir;
    });
  }

  // 4) limit
  const limit = Math.max(1, Math.min(200, Math.round(args.limit ?? MAX_OUTPUT_ROWS)));
  const total = outRows.length;
  const truncatedOut = total > limit;
  const shown = outRows.slice(0, limit);

  const head = [
    `[查询结果 · ${mode}] 共 ${total} 行${filters.length > 0 ? ` · 已过滤(${filters.length} 个条件)` : ''}` +
      (truncatedOut ? `,仅展示前 ${limit} 行` : ''),
    '',
    toMarkdownTable(outColumns, shown),
  ].join('\n');
  return head;
}

/** 单条件过滤 */
function applyFilter(rows: Record<string, unknown>[], f: FilterSpec, ds: Dataset): Record<string, unknown>[] {
  if (!f.column || !ds.columns.includes(f.column)) {
    throw new Error(`过滤列 "${f.column}" 不存在。可用列:${ds.columns.join(', ')}`);
  }
  const op = (f.op || 'eq') as FilterOp;
  const target = f.value;
  return rows.filter((r) => {
    const v = r[f.column!];
    if (op === 'contains') {
      return v != null && String(v).toLowerCase().includes(String(target).toLowerCase());
    }
    if (v == null) return false;
    // 数值比较优先(两侧均可转数值时)
    const vn = typeof v === 'number' ? v : Number(v);
    const tn = typeof target === 'number' ? target : Number(target);
    const bothNum = isFinite(vn) && typeof v !== 'boolean' && isFinite(tn) && target != null && String(target).trim() !== '';
    if (bothNum) {
      switch (op) {
        case 'eq': return vn === tn;
        case 'ne': return vn !== tn;
        case 'gt': return vn > tn;
        case 'gte': return vn >= tn;
        case 'lt': return vn < tn;
        case 'lte': return vn <= tn;
      }
    }
    const vs = String(v);
    const ts = String(target ?? '');
    switch (op) {
      case 'eq': return vs === ts;
      case 'ne': return vs !== ts;
      default: throw new Error(`操作符 "${op}" 不支持字符串比较 "${vs}",请改用数值或 contains`);
    }
  });
}

interface NormalizedAgg {
  column: string | null;
  fn: AggFn;
  alias: string;
}

function normalizeAgg(a: AggregationSpec, ds: Dataset): NormalizedAgg {
  const fn = String(a.fn || 'count').toLowerCase() as AggFn;
  if (!['count', 'sum', 'avg', 'min', 'max'].includes(fn)) {
    throw new Error(`聚合函数 "${fn}" 不支持,可用:count/sum/avg/min/max`);
  }
  let column: string | null = null;
  if (fn !== 'count') {
    column = String(a.column || '');
    if (!ds.columns.includes(column)) {
      throw new Error(`聚合列 "${column}" 不存在。可用列:${ds.columns.join(', ')}`);
    }
  }
  return { column, fn, alias: a.alias || (column ? `${fn}_${column}` : 'count') };
}

/** 分组聚合:groupBy 为空时聚合全表(单行) */
function aggregate(
  rows: Record<string, unknown>[],
  groupBy: string[],
  specs: NormalizedAgg[],
): Record<string, unknown>[] {
  if (specs.length === 0) return rows;

  if (groupBy.length === 0) {
    const out: Record<string, unknown> = {};
    for (const s of specs) out[s.alias] = computeAgg(rows, s);
    return [out];
  }

  const groups = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const key = groupBy.map((c) => (r[c] == null ? '∅' : String(r[c]))).join('');
    let g = groups.get(key);
    if (!g) {
      g = [];
      groups.set(key, g);
    }
    g.push(r);
  }
  return [...groups.entries()].map(([key, g]) => {
    const out: Record<string, unknown> = {};
    groupBy.forEach((c, i) => {
      out[c] = g[0][c];
    });
    for (const s of specs) out[s.alias] = computeAgg(g, s);
    return out;
  });
}

function computeAgg(rows: Record<string, unknown>[], s: NormalizedAgg): number | null {
  if (s.fn === 'count') return rows.length;
  const vals = rows
    .map((r) => (s.column ? r[s.column] : null))
    .map((v) => (typeof v === 'number' ? v : Number(v)))
    .filter((n) => isFinite(n));
  if (vals.length === 0) return null;
  switch (s.fn) {
    case 'sum': return vals.reduce((a, b) => a + b, 0);
    case 'avg': return vals.reduce((a, b) => a + b, 0) / vals.length;
    case 'min': return Math.min(...vals);
    case 'max': return Math.max(...vals);
    default: return rows.length;
  }
}

// ─── Markdown 表格输出 ───────────────────────────────────────────

function toMarkdownTable(columns: string[], rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '(无数据行)';
  const lines = [
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
  ];
  for (const r of rows) {
    lines.push(`| ${columns.map((c) => cellText(r[c])).join(' | ')} |`);
  }
  return lines.join('\n');
}

function cellText(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'number') return fmt(v);
  return String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** 数值显示:整数无小数,浮点保留 2 位 */
function fmt(n: number): string {
  if (!isFinite(n)) return '—';
  if (Number.isInteger(n)) return n.toLocaleString('en-US');
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
