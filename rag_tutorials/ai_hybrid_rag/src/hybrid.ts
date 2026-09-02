/**
 * rag_tutorials/ai_hybrid_rag/src/hybrid.ts
 *
 * 零依赖混合检索存储（替代源应用的 RAGLite + PostgreSQL + Cohere 重排链路）：
 *   - 单集合文档索引：文本分块（chunk≈1000 字符，overlap 200，段落边界优先）
 *   - 关键词通道：BM25（k1=1.5, b=0.75），捕捉精确词面命中
 *   - 向量通道：TF-IDF 稀疏向量余弦相似度（英文词 + 中文双字/单字，
 *     复用 ai_rag_database_routing/vectordb.ts 的内存向量索引模式）
 *   - 融合：Reciprocal Rank Fusion（RRF），按两通道名次倒数之和重排
 *   - JSON 文件持久化，重启不丢数据（目录由 VECTOR_DB_DIR 配置）
 *
 * 设计取舍：与源应用「关键词 + 向量混合 + 重排」的功能等价，重排的语义判断
 * 由 pipeline.ts 的 LLM 相关性评估（grade）承担，本模块只负责检索与融合。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// ─── 文本分块 ─────────────────────────────────────────────────────

/** 按段落优先切分文本：目标块大小 chunkSize，相邻块 overlap 字符 */
export function chunkText(text: string, chunkSize = 1000, overlap = 200): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\u3000/g, ' ').trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + chunkSize, normalized.length);
    if (end < normalized.length) {
      // 在窗口末尾 20% 内找换行符，尽量在段落边界切断
      const boundary = normalized.lastIndexOf('\n', end);
      if (boundary > start + chunkSize * 0.8) end = boundary;
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    start = end - overlap;
  }
  return chunks;
}

// ─── 分词：英文单词/数字 + 中文双字、单字 ───────────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'for', 'on', 'with', 'and', 'or',
  'is', 'are', 'was', 'were', 'be', 'been', 'at', 'by', 'from', 'as',
  'it', 'this', 'that', 'these', 'those', 'i', 'you', 'we', 'they',
  'my', 'your', 'our', 'their', 'what', 'how', 'why', 'when', 'where',
  'who', 'do', 'does', 'did', 'will', 'would', 'can', 'could', 'should',
  'shall', 'may', 'might', 'must', 'please', 'give', 'tell', 'me', 'us',
  'about', 'into', 'over', 'under', 'again', 'then', 'than', 'so', 'too',
  'very', 'just', 'not', 'no', 'yes', 'ok', 'okay', 'hi', 'hello',
]);

/** 分词：返回 term 数组（英文小写词 + 数字，中文双字与单字） */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  // 英文与数字（长度 > 1 且非停用词）
  for (const m of lower.matchAll(/[a-z0-9]+/g)) {
    const t = m[0];
    if (t.length > 1 && !STOPWORDS.has(t)) tokens.push(t);
  }
  // 中文：连续汉字按双字滑窗 + 独立单字
  for (const run of lower.matchAll(/[\u4e00-\u9fa5]+/g)) {
    const s = run[0];
    if (s.length === 1) {
      tokens.push(s);
    } else {
      for (let i = 0; i < s.length - 1; i++) tokens.push(s.slice(i, i + 2));
    }
  }
  return tokens;
}

// ─── 内部文档/索引结构 ─────────────────────────────────────────────

interface StoredDoc {
  id: string;
  text: string;
  source: string;
  addedAt: number;
  /** term → 词频（tf） */
  terms: Record<string, number>;
  /** 文档向量 L2 范数（用于余弦相似度） */
  norm: number;
  /** 文档 token 总长（BM25 文档长度归一） */
  length: number;
}

/** 检索命中（单通道或融合后） */
export interface SearchHit {
  id: string;
  text: string;
  source: string;
  score: number;
  /** BM25 关键词通道得分（混合检索时附带） */
  keywordScore?: number;
  /** TF-IDF 向量通道得分（混合检索时附带） */
  vectorScore?: number;
}

/** 文档源统计 */
export interface SourceStats {
  name: string;
  chunkCount: number;
  addedAt: number;
}

export interface StoreStats {
  totalChunks: number;
  sources: SourceStats[];
}

// ─── BM25 参数 ────────────────────────────────────────────────────

const BM25_K1 = 1.5;
const BM25_B = 0.75;

// ─── 混合检索存储 ──────────────────────────────────────────────────

export class HybridStore {
  private dir: string;
  private file: string;
  private docs: StoredDoc[] = [];
  /** 未持久化的脏标记 */
  private dirty = false;

  constructor(options: { dir: string }) {
    this.dir = path.resolve(options.dir);
    this.file = path.join(this.dir, 'store.json');
    this.load();
  }

  /** 计算单个文档的 term→tf、L2 范数与 token 总长 */
  private buildVector(text: string): { terms: Record<string, number>; norm: number; length: number } {
    const terms: Record<string, number> = {};
    let length = 0;
    for (const t of tokenize(text)) {
      terms[t] = (terms[t] || 0) + 1;
      length++;
    }
    let norm = 0;
    for (const f of Object.values(terms)) norm += f * f;
    return { terms, norm: Math.sqrt(norm) || 1, length };
  }

  /** 添加文本（自动分块；与库内已有块完全重复的跳过） */
  addTexts(texts: string[], source: string): { added: number; skipped: number } {
    let added = 0;
    let skipped = 0;
    const seen = new Set(this.docs.map((d) => d.text));
    const now = Date.now();
    for (const text of texts) {
      for (const chunk of chunkText(text)) {
        if (seen.has(chunk)) {
          skipped++;
          continue;
        }
        const { terms, norm, length } = this.buildVector(chunk);
        this.docs.push({ id: randomUUID(), text: chunk, source, addedAt: now, terms, norm, length });
        seen.add(chunk);
        added++;
      }
    }
    if (added > 0) this.dirty = true;
    return { added, skipped };
  }

  /** 删除指定来源的全部块，返回删除数 */
  removeSource(source: string): number {
    const before = this.docs.length;
    this.docs = this.docs.filter((d) => d.source !== source);
    const removed = before - this.docs.length;
    if (removed > 0) this.dirty = true;
    return removed;
  }

  /** 清空全部索引 */
  clear(): number {
    const removed = this.docs.length;
    this.docs = [];
    if (removed > 0) this.dirty = true;
    return removed;
  }

  /** 索引统计（按来源聚合） */
  stats(): StoreStats {
    const map = new Map<string, SourceStats>();
    for (const d of this.docs) {
      let s = map.get(d.source);
      if (!s) {
        s = { name: d.source, chunkCount: 0, addedAt: d.addedAt };
        map.set(d.source, s);
      }
      s.chunkCount++;
      if (d.addedAt < s.addedAt) s.addedAt = d.addedAt;
    }
    return {
      totalChunks: this.docs.length,
      sources: [...map.values()].sort((a, b) => b.addedAt - a.addedAt),
    };
  }

  /** 是否为空库 */
  get empty(): boolean {
    return this.docs.length === 0;
  }

  // ─── 关键词通道：BM25 ─────────────────────────────────────────

  /**
   * BM25 检索：精确词面匹配导向，对查询词的高频出现与文档长度都做了归一。
   * 返回 top-k（仅 score > 0 的文档）。
   */
  keywordSearch(query: string, k: number): SearchHit[] {
    if (this.docs.length === 0) return [];
    const N = this.docs.length;
    const avgdl = this.docs.reduce((s, d) => s + d.length, 0) / N;

    // 文档频率 df → BM25 idf
    const df = new Map<string, number>();
    for (const d of this.docs) {
      for (const t of Object.keys(d.terms)) df.set(t, (df.get(t) || 0) + 1);
    }
    const idf = new Map<string, number>();
    for (const [t, f] of df) idf.set(t, Math.log(1 + (N - f + 0.5) / (f + 0.5)));

    // 查询词集合（仅统计语料中存在的词）
    const qTerms = new Set(tokenize(query).filter((t) => idf.has(t)));
    if (qTerms.size === 0) return [];

    const scored: Array<{ doc: StoredDoc; score: number }> = [];
    for (const d of this.docs) {
      let score = 0;
      for (const t of qTerms) {
        const tf = d.terms[t];
        if (!tf) continue;
        score +=
          idf.get(t)! * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * d.length) / (avgdl || 1))));
      }
      if (score > 0) scored.push({ doc: d, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k).map(({ doc, score }) => ({ id: doc.id, text: doc.text, source: doc.source, score }));
  }

  // ─── 向量通道：TF-IDF 余弦相似度 ──────────────────────────────

  /** TF-IDF 余弦相似度检索，返回 top-k（仅 score > 0 的文档） */
  vectorSearch(query: string, k: number): SearchHit[] {
    if (this.docs.length === 0) return [];

    // 文档频率 df → idf
    const df = new Map<string, number>();
    for (const d of this.docs) {
      for (const t of Object.keys(d.terms)) df.set(t, (df.get(t) || 0) + 1);
    }
    const N = this.docs.length;
    const idf = new Map<string, number>();
    for (const [t, f] of df) idf.set(t, Math.log((N + 1) / (f + 1)) + 1);

    // 查询向量（仅统计语料中存在的词，避免未见词放大范数）
    const q = new Map<string, number>();
    for (const t of tokenize(query)) {
      if (idf.has(t)) q.set(t, (q.get(t) || 0) + 1);
    }
    if (q.size === 0) return [];

    let qNorm = 0;
    for (const [t, f] of q) {
      const w = idf.get(t)!;
      qNorm += (f * w) ** 2;
    }
    qNorm = Math.sqrt(qNorm) || 1;

    const scored: Array<{ doc: StoredDoc; score: number }> = [];
    for (const d of this.docs) {
      let dot = 0;
      for (const [t, f] of q) {
        const dtf = d.terms[t];
        if (dtf) {
          const w = idf.get(t)!;
          dot += f * w * dtf * w;
        }
      }
      const score = dot / (qNorm * d.norm);
      if (score > 0) scored.push({ doc: d, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k).map(({ doc, score }) => ({ id: doc.id, text: doc.text, source: doc.source, score }));
  }

  // ─── 融合：RRF ────────────────────────────────────────────────

  /**
   * 混合检索：BM25 与 TF-IDF 余弦各取前 candidateK，按 RRF 融合
   * （fused = Σ 1/(rrfK + rank)，rank 从 1 起），返回融合后 top-candidateK。
   * 每个命中附带两通道原始得分，便于前端展示检索细节。
   */
  hybridSearch(query: string, candidateK: number, rrfK = 60): SearchHit[] {
    const keyword = this.keywordSearch(query, candidateK);
    const vector = this.vectorSearch(query, candidateK);

    // RRF 融合：名次倒数求和
    const fused = new Map<string, { hit: SearchHit; score: number }>();
    const addRank = (hits: SearchHit[]) => {
      hits.forEach((hit, i) => {
        const rank = i + 1;
        const entry = fused.get(hit.id) ?? { hit, score: 0 };
        entry.score += 1 / (rrfK + rank);
        fused.set(hit.id, entry);
      });
    };
    addRank(keyword);
    addRank(vector);

    // 附带两通道得分
    const kwScore = new Map(keyword.map((h) => [h.id, h.score]));
    const vecScore = new Map(vector.map((h) => [h.id, h.score]));

    return [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, candidateK)
      .map(({ hit, score }) => ({
        id: hit.id,
        text: hit.text,
        source: hit.source,
        score,
        keywordScore: kwScore.get(hit.id),
        vectorScore: vecScore.get(hit.id),
      }));
  }

  // ── 持久化 ─────────────────────────────────────────────────────

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as { docs?: StoredDoc[] };
      if (Array.isArray(raw.docs)) this.docs = raw.docs;
      this.dirty = false;
    } catch (err) {
      console.warn(`[hybrid] 读取持久化文件失败，将使用空库:`, (err as Error).message);
    }
  }

  /** 保存到磁盘（仅当有变更） */
  save(): void {
    if (!this.dirty) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.file, JSON.stringify({ docs: this.docs }), 'utf-8');
      this.dirty = false;
    } catch (err) {
      console.warn(`[hybrid] 保存失败:`, (err as Error).message);
    }
  }
}
