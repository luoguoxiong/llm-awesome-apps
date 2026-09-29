/**
 * foreign_trade_apps/ai_trade_lead_agent/src/tools/importyeti.ts
 *
 * ImportYeti 海关数据工具(aipack Tool),对应获客流水线的第 2、3 步:
 *   ① search_importyeti:按产品关键词检索美国进口商(ImportYeti 提单数据)
 *   ② lookup_importer_suppliers:查看指定进口商的供应商名单,供判断是否真在采购该产品
 *
 * 降级设计(ImportYeti 未登录/被拦截时仍可用):
 *   直连解析 → site:importyeti.com 检索(SerpAPI/Bing/DDG)→ 通用进口商检索
 * 全程不伪造公司名/供应商名:拿不到数据时明确返回"未命中",由 Agent 说明证据不足。
 */
import type { Tool } from '@aipack-ai/agent';
import { runSearch } from './search.js';

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const DATA_NOTE =
  '数据说明:ImportYeti 聚合美国海关提单数据,未登录时可见字段有限,结果可能不完整。' +
  '请结合 search_web / fetch_url 交叉验证;拿不到证据就如实说明,绝不编造公司名或供应商名。';

interface CompanyHit {
  slug: string;
  name: string;
  url: string;
}

// ─── 直连抓取与解析 ──────────────────────────────────────────────

/** 抓取 ImportYeti 页面;被拦截/异常时返回 null */
async function fetchImportYeti(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    // Cloudflare 拦截页 / 登录墙:视为未命中
    if (/Just a moment|captcha|Enable JavaScript|Log in to see/i.test(html)) return null;
    return html;
  } catch {
    return null;
  }
}

/** 解析页面中的 /company/<slug> 链接 → 公司候选 */
function parseCompanyHits(html: string, limit: number): CompanyHit[] {
  const seen = new Map<string, CompanyHit>();
  for (const m of html.matchAll(/\/company\/([a-z0-9][a-z0-9\-]{2,80})/gi)) {
    const slug = m[1].toLowerCase();
    if (seen.has(slug)) continue;
    seen.set(slug, { slug, name: titleize(slug), url: `https://www.importyeti.com/company/${slug}` });
    if (seen.size >= limit) break;
  }
  // 补充:JSON 内联数据中的公司名(Next.js 页面常见)
  if (seen.size === 0) {
    for (const m of html.matchAll(/"(?:name|companyName|company_name)"\s*:\s*"([^"]{3,80})"/g)) {
      const name = m[1].trim();
      const slug = slugify(name);
      if (!slug || seen.has(slug)) continue;
      seen.set(slug, { slug, name, url: `https://www.importyeti.com/company/${slug}` });
      if (seen.size >= limit) break;
    }
  }
  return [...seen.values()];
}

/** 解析公司页中的 /supplier/<slug> 链接 → 供应商候选 */
function parseSupplierHits(html: string, limit: number): string[] {
  const seen = new Set<string>();
  for (const m of html.matchAll(/\/supplier\/([a-z0-9][a-z0-9\-]{2,80})/gi)) {
    seen.add(titleize(m[1]));
    if (seen.size >= limit) break;
  }
  if (seen.size === 0) {
    for (const m of html.matchAll(/"(?:supplierName|supplier_name|name)"\s*:\s*"([^"]{3,80})"/g)) {
      seen.add(m[1].trim());
      if (seen.size >= limit) break;
    }
  }
  return [...seen];
}

/** 从正文里抽取"原产国"线索(China / Vietnam / India …) */
function parseCountryHints(html: string): string[] {
  const text = html.replace(/<[^>]+>/g, ' ');
  const countries = ['China', 'Vietnam', 'India', 'Taiwan', 'Thailand', 'Malaysia', 'Indonesia', 'Mexico', 'Cambodia', 'Bangladesh'];
  return countries.filter((c) => new RegExp(`\\b${c}\\b`, 'i').test(text));
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function titleize(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => (w.length <= 3 && /^(llc|inc|usa|co|ltd)$/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

// ─── 工具 ①:按关键词找美国进口商 ─────────────────────────────────

export function createSearchImportYetiTool(serpapiKey?: string): Tool {
  return {
    name: 'search_importyeti',
    description:
      '按产品关键词在 ImportYeti(美国海关提单数据)检索正在进口该类产品的美国进口商公司名。' +
      '返回公司名 + ImportYeti 公司页链接(可能附带原产国线索)。未命中时会给出降级检索结果。' +
      '这是流水线的第 2 步(找美国进口商),拿到公司名后交给 lookup_importer_suppliers 查供应商。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '产品关键词,英文优先(如 "yoga mat"、"stainless steel tumbler")' },
        limit: { type: 'number', description: '返回公司数量上限,默认 8' },
      },
      required: ['keyword'],
    },
    async execute(_toolCallId, args) {
      const { keyword, limit = 8 } = (args ?? {}) as { keyword?: string; limit?: number };
      if (!keyword) {
        return { content: [{ type: 'text', text: '错误:缺少 keyword 参数' }], details: { error: 'missing_keyword' } };
      }

      const searchUrl = `https://www.importyeti.com/search?q=${encodeURIComponent(keyword)}`;
      const html = await fetchImportYeti(searchUrl);
      if (html) {
        const hits = parseCompanyHits(html, limit);
        if (hits.length > 0) {
          const countries = parseCountryHints(html);
          const lines = [
            `[ImportYeti 直连命中] 关键词: "${keyword}"`,
            `检索页: ${searchUrl}`,
            `共 ${hits.length} 家公司:`,
            '',
            ...hits.map((h, i) => `${i + 1}. ${h.name}\n   ImportYeti: ${h.url}`),
            '',
            ...(countries.length ? [`页面出现的原产国线索: ${countries.join(', ')}`, ''] : []),
            DATA_NOTE,
          ];
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            details: { source: 'importyeti-direct', count: hits.length },
          };
        }
      }

      // ── 降级 1:site:importyeti.com 检索(拿到真实的 ImportYeti 公司页)──
      const siteOutcome = await runSearch(`site:importyeti.com ${keyword}`, limit, serpapiKey);
      const iyHits = siteOutcome.results.filter((r) => /importyeti\.com/i.test(r.url ?? ''));
      if (iyHits.length > 0) {
        const lines = [
          `[ImportYeti 降级检索 · ${siteOutcome.source}] 关键词: "${keyword}"`,
          `说明:ImportYeti 页面未能直连解析,以下为搜索引擎收录的 ImportYeti 页面:`,
          '',
          ...iyHits.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   链接: ${r.url ?? '(无)'}`),
          '',
          DATA_NOTE,
        ];
        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          details: { source: `search:${siteOutcome.source}`, count: iyHits.length },
        };
      }

      // ── 降级 2:通用"美国进口商"检索(其他贸易数据站/行业目录)──
      const generic = await runSearch(`${keyword} importers USA distributor wholesale`, limit, serpapiKey);
      const lines = [
        `[通用进口商检索 · ${generic.source}] 关键词: "${keyword}"`,
        `说明:ImportYeti 本次未直接命中(需登录或被拦截),以下为公开检索到的进口商/分销商线索(非海关数据,可信度较低):`,
        '',
        ...generic.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   链接: ${r.url ?? '(无)'}`),
        '',
        DATA_NOTE,
      ];
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: { source: `generic:${generic.source}`, count: generic.results.length },
      };
    },
  };
}

// ─── 工具 ②:查进口商的供应商 ─────────────────────────────────────

export function createLookupSuppliersTool(serpapiKey?: string): Tool {
  return {
    name: 'lookup_importer_suppliers',
    description:
      '查询指定美国进口商在 ImportYeti 上的供应商名单(含原产国线索),用于判断它是否真的在采购目标产品。' +
      '这是流水线的第 3 步(查看进口商的供应商)。未命中时会降级为公开检索,请用 search_web / fetch_url 进一步交叉验证。',
    parameters: {
      type: 'object',
      properties: {
        company: { type: 'string', description: '进口商公司名(英文官方名)' },
        keyword: { type: 'string', description: '目标产品关键词,用于判断供应商是否与该类产品相关' },
        importyeti_url: { type: 'string', description: '已知的公司 ImportYeti 页面 URL(可选,优先直连)' },
        limit: { type: 'number', description: '返回供应商数量上限,默认 10' },
      },
      required: ['company'],
    },
    async execute(_toolCallId, args) {
      const { company, keyword, importyeti_url, limit = 10 } = (args ?? {}) as {
        company?: string;
        keyword?: string;
        importyeti_url?: string;
        limit?: number;
      };
      if (!company) {
        return { content: [{ type: 'text', text: '错误:缺少 company 参数' }], details: { error: 'missing_company' } };
      }

      const url = importyeti_url?.trim() || `https://www.importyeti.com/company/${slugify(company)}`;
      const html = await fetchImportYeti(url);
      if (html) {
        const suppliers = parseSupplierHits(html, limit);
        const countries = parseCountryHints(html);
        if (suppliers.length > 0) {
          const lines = [
            `[ImportYeti 供应商命中] 进口商: ${company}${keyword ? ` · 目标产品: ${keyword}` : ''}`,
            `公司页: ${url}`,
            `供应商(${suppliers.length}):`,
            '',
            ...suppliers.map((s, i) => `${i + 1}. ${s}`),
            '',
            ...(countries.length ? [`原产国线索: ${countries.join(', ')}`, ''] : []),
            '判断提示:供应商中若有中国/东南亚工厂,且品类与目标产品相符 → 倾向判定为"在采购";仅有欧美供应商或品类不符 → 谨慎判定。',
            DATA_NOTE,
          ];
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            details: { source: 'importyeti-company', count: suppliers.length },
          };
        }
      }

      // ── 降级:公开检索供应商线索 ───────────────────────────────
      const q = [company, 'suppliers', keyword, 'importyeti'].filter(Boolean).join(' ');
      const outcome = await runSearch(q, 6, serpapiKey);
      const lines = [
        `[供应商降级检索 · ${outcome.source}] 进口商: ${company}`,
        `说明:ImportYeti 公司页未直接解析到供应商(需登录/被拦截/公司名不匹配),以下为公开检索结果:`,
        '',
        ...outcome.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   链接: ${r.url ?? '(无)'}`),
        '',
        '下一步建议:用 fetch_url 打开公司官网的 About / Products / 经销页面,或用 search_web 查 "<company> supplier / sourcing / made in"。',
        DATA_NOTE,
      ];
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: { source: `search:${outcome.source}`, count: outcome.results.length },
      };
    },
  };
}
