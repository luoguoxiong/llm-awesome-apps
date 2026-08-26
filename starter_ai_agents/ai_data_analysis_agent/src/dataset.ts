/**
 * starter_ai_agents/ai_data_analysis_agent/src/dataset.ts
 *
 * 数据集层(源应用 pandas 预处理的等价实现):
 *   - 解析:CSV(UTF-8/GBK 自适应)与 Excel(.xlsx/.xls,cellDates)→ 行对象数组
 *   - 预处理(对齐源 preprocess_and_save):
 *       * NA/N/A/missing 等缺失标记 → null
 *       * 列名含 date/time → 日期规范化(Excel Date → ISO 字符串)
 *       * 纯数值字符串列 → number
 *   - 存储:内存 Map + LRU(最多 8 个数据集,防内存膨胀)
 *
 * 上传时返回 DatasetInfo(列元信息 + 前 8 行预览)供前端直接渲染,
 * Agent 侧通过 tools/query.ts 的 get_data_summary / query_data 精确查询。
 */
import * as XLSX from 'xlsx';
import { randomUUID } from 'node:crypto';

// ─── 类型 ───────────────────────────────────────────────────────

export type ColumnType = 'number' | 'date' | 'string';

export interface ColumnMeta {
  name: string;
  type: ColumnType;
  /** 缺失(null)行数 */
  missing: number;
  /** 唯一值数量(超过 50 视为高基数,仍给出精确值) */
  unique: number;
  /** 数值列统计 */
  min?: number;
  max?: number;
  mean?: number;
}

export interface DatasetInfo {
  id: string;
  name: string;
  rowCount: number;
  /** 超过上限被截断时为 true */
  truncated: boolean;
  columns: ColumnMeta[];
  /** 前 8 行预览 */
  preview: Record<string, unknown>[];
}

export interface Dataset {
  id: string;
  name: string;
  columns: string[];
  types: ColumnType[];
  rows: Record<string, unknown>[];
}

// ─── 常量 ───────────────────────────────────────────────────────

/** 缺失值标记(对齐源应用 na_values + 常见扩展) */
const NA_VALUES = new Set(['', 'NA', 'N/A', 'n/a', 'missing', 'null', 'NULL', 'NaN', 'nan', '#N/A', '-']);

/** 行数上限(防内存膨胀;超出截断) */
const MAX_ROWS = 50_000;

/** 内存中最多保留的数据集个数(LRU) */
const MAX_DATASETS = 8;

/** 上传文件大小上限(15MB) */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

// ─── 存储(LRU)──────────────────────────────────────────────────

const store = new Map<string, Dataset>();

export function getDataset(id: string): Dataset | undefined {
  const ds = store.get(id);
  if (ds) {
    // LRU touch:移到末尾
    store.delete(id);
    store.set(id, ds);
  }
  return ds;
}

function putDataset(ds: Dataset): void {
  store.set(ds.id, ds);
  // 超出容量淘汰最旧(首个)
  while (store.size > MAX_DATASETS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

// ─── 解析 ───────────────────────────────────────────────────────

/** CSV 编码自适应:严格 UTF-8 失败(含非法字节)时按 GBK 解码(中文 Excel 导出的常见编码) */
function decodeCsvText(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return buf.toString('utf-8');
    }
  }
}

/** 解析上传文件(CSV/Excel)→ DatasetInfo(同时存入内存) */
export function parseDataset(name: string, buf: Buffer): DatasetInfo {
  const lower = name.toLowerCase();
  let rawRows: Record<string, unknown>[];

  if (lower.endsWith('.csv') || lower.endsWith('.txt') || lower.endsWith('.tsv')) {
    const text = decodeCsvText(buf);
    const wb = XLSX.read(text, { type: 'string', raw: true, FS: lower.endsWith('.tsv') ? '\t' : ',' });
    rawRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null, raw: true });
  } else if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
    rawRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null, raw: true });
  } else {
    throw new Error(`不支持的文件格式 "${name}"。请上传 .csv / .xlsx / .xls / .tsv 文件。`);
  }

  if (rawRows.length === 0) {
    throw new Error('文件解析结果为空(没有数据行)。请检查文件内容。');
  }

  const columns = Object.keys(rawRows[0]);
  if (columns.length === 0) {
    throw new Error('文件解析结果没有列。请检查表头。');
  }

  // ── 预处理(对齐源应用):缺失标记归一化 + 类型推断与规范化 ──
  const types: ColumnType[] = columns.map((col) => inferType(col, rawRows.map((r) => r[col])));
  const truncated = rawRows.length > MAX_ROWS;
  const rows = (truncated ? rawRows.slice(0, MAX_ROWS) : rawRows).map((r) => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      out[col] = normalizeValue(r[col], types[i]);
    }
    return out;
  });

  const ds: Dataset = { id: randomUUID(), name, columns, types, rows };
  putDataset(ds);

  // 列元信息(含统计)
  const metas = columns.map((col, i) => describeColumn(col, types[i], rows.map((r) => r[col])));

  return {
    id: ds.id,
    name,
    rowCount: rows.length,
    truncated,
    columns: metas,
    preview: rows.slice(0, 8),
  };
}

// ─── 类型推断与值规范化 ──────────────────────────────────────────

/** 类型推断:全数值 → number;列名含 date/time 或全可解析日期 → date;否则 string */
function inferType(colName: string, values: unknown[]): ColumnType {
  const vals = values.filter((v) => v != null && !isNaString(v));
  if (vals.length === 0) return 'string';

  if (vals.every((v) => typeof v === 'number')) return 'number';
  if (vals.every((v) => typeof v === 'string' && v.trim() !== '' && isNumeric(v))) return 'number';

  // 日期:列名提示 或 全部可解析
  const nameHint = /date|time|日期|时间/i.test(colName);
  if (nameHint || vals.every((v) => isDateLike(v))) return 'date';

  return 'string';
}

function isNaString(v: unknown): boolean {
  return typeof v === 'string' && NA_VALUES.has(v.trim());
}

function isNumeric(v: string): boolean {
  const s = v.trim().replace(/[,\s]/g, '');
  if (s === '') return false;
  return !isNaN(Number(s)) && isFinite(Number(s));
}

/** 日期判定:Date 对象 / Excel 序列号以外,字符串需 Date.parse 成功且非纯数字 */
function isDateLike(v: unknown): boolean {
  if (v instanceof Date) return !isNaN(v.getTime());
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s === '' || isNumeric(s)) return false;
  return !isNaN(Date.parse(s));
}

/** 按推断类型规范化单值:缺失标记 → null;date 列 Date → ISO 字符串;number 列 → Number */
function normalizeValue(v: unknown, type: ColumnType): unknown {
  if (v == null || isNaString(v)) return null;
  if (type === 'number') {
    if (typeof v === 'number') return v;
    const n = Number(String(v).trim().replace(/[,\s]/g, ''));
    return isFinite(n) ? n : String(v);
  }
  if (type === 'date') {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v);
  }
  if (typeof v === 'number') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

// ─── 列统计 ──────────────────────────────────────────────────────

function describeColumn(name: string, type: ColumnType, values: unknown[]): ColumnMeta {
  const nonNull = values.filter((v) => v != null);
  const unique = new Set(nonNull.map((v) => String(v))).size;
  const meta: ColumnMeta = {
    name,
    type,
    missing: values.length - nonNull.length,
    unique,
  };
  if (type === 'number') {
    const nums = nonNull.map((v) => Number(v)).filter((n) => isFinite(n));
    if (nums.length > 0) {
      meta.min = Math.min(...nums);
      meta.max = Math.max(...nums);
      meta.mean = nums.reduce((a, b) => a + b, 0) / nums.length;
    }
  }
  return meta;
}
