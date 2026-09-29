/**
 * foreign_trade_apps/ai_trade_lead_agent/src/tools/leads.ts
 *
 * 线索仓库(LeadStore)+ 三个结构化写入工具:
 *   - save_importer:第 2 步保存候选美国进口商
 *   - save_verdict :第 3 步保存"是否真的在采购该产品"的判断(含供应商证据)
 *   - save_contact :第 4 步保存官网 / LinkedIn / 邮箱 / 关键联系人
 *
 * 每次流水线创建独立 store;写入即通过回调推送 SSE(前端按 id 增量更新客户卡片)。
 */
import type { Tool } from '@aipack-ai/agent';

/** 采购判定 */
export type Verdict = 'yes' | 'likely' | 'unknown' | 'no';

/** 联系人与官网线索 */
export interface ContactInfo {
  website?: string;
  linkedin?: string;
  emails: string[];
  phones: string[];
  /** 关键人:"Name — Title" */
  people: string[];
  address?: string;
  note?: string;
}

/** 一个客户(美国进口商)线索的完整状态 */
export interface Lead {
  id: string;
  name: string;
  country?: string;
  city?: string;
  website?: string;
  importyetiUrl?: string;
  /** 线索来源(importyeti / search / ...) */
  source?: string;
  /** 备注(采购规模、品牌属性等) */
  note?: string;
  // ── 核验 ──
  verdict?: Verdict;
  verdictReason?: string;
  suppliers?: string[];
  matchedCategory?: string;
  signal?: string;
  // ── 联系人 ──
  contact?: ContactInfo;
}

export interface LeadStoreHooks {
  onImporter?: (lead: Lead) => void;
  onVerdict?: (lead: Lead) => void;
  onContact?: (lead: Lead) => void;
}

export interface LeadStore {
  readonly leads: Lead[];
  /** 三个写入工具(按阶段分别装配给 Runtime) */
  readonly saveImporter: Tool;
  readonly saveVerdict: Tool;
  readonly saveContact: Tool;
}

/** 公司名归一化(用于去重与跨阶段匹配) */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** 去掉常见法律后缀(Inc / LLC / Ltd …),避免 "Gaiam" 与 "Gaiam Inc." 匹配不上 */
function core(s: string): string {
  let out = norm(s);
  // 反复剥离,兼容 "Acme Co., Ltd."
  for (let i = 0; i < 3; i++) {
    const next = out.replace(/(inc|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|usa|us)$/, '');
    if (next === out || next.length < 4) break;
    out = next;
  }
  return out;
}

export function createLeadStore(hooks: LeadStoreHooks = {}, maxLeads = 8): LeadStore {
  const leads: Lead[] = [];
  let seq = 0;

  const nextId = () => {
    seq += 1;
    return `lead-${seq}`;
  };

  /** 按公司名查找(先精确 → 去后缀 → 子串包容,兼容 Agent 回传的简写/全称) */
  function find(company: string): Lead | undefined {
    const target = norm(company);
    if (!target) return undefined;
    const exact = leads.find((l) => norm(l.name) === target);
    if (exact) return exact;

    const targetCore = core(company);
    const byCore = leads.find((l) => core(l.name) === targetCore);
    if (byCore) return byCore;

    // 包容匹配:任一方(去后缀后)为另一方的子串,且长度足够(避免短名误匹配)
    return leads.find((l) => {
      const n = core(l.name);
      return (n.length >= 5 && targetCore.includes(n)) || (targetCore.length >= 5 && n.includes(targetCore));
    });
  }

  // ── ① save_importer ──────────────────────────────────────────
  const saveImporter: Tool = {
    name: 'save_importer',
    description:
      '保存一家候选美国进口商(第 2 步:找到美国进口商)。每确认一家就调用一次。' +
      '参数:name(公司英文官方名,必填)、country/city、website、importyeti_url、source(数据来源)、note(采购规模/品牌属性等备注)。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '公司英文官方名(必填)' },
        country: { type: 'string', description: '国家,默认 United States' },
        city: { type: 'string', description: '所在城市/州(如 Los Angeles, CA)' },
        website: { type: 'string', description: '公司官网(如有)' },
        importyeti_url: { type: 'string', description: 'ImportYeti 公司页链接(如有)' },
        source: { type: 'string', description: '数据来源,如 importyeti / bing / 官网' },
        note: { type: 'string', description: '备注:采购规模、品类、品牌/批发属性等' },
      },
      required: ['name'],
    },
    async execute(_toolCallId, args) {
      const a = (args ?? {}) as Record<string, string | undefined>;
      const name = (a.name ?? '').trim();
      if (!name) return { content: [{ type: 'text', text: '错误:缺少 name 参数' }], details: { error: 'missing_name' } };

      const dup = find(name);
      if (dup) {
        // 已存在 → 补全字段
        dup.website = dup.website || a.website?.trim();
        dup.importyetiUrl = dup.importyetiUrl || a.importyeti_url?.trim();
        dup.city = dup.city || a.city?.trim();
        hooks.onImporter?.(dup);
        return { content: [{ type: 'text', text: `已存在同名线索,已补全信息:${dup.name}(#${dup.id})` }], details: { id: dup.id, dedup: true } };
      }
      if (leads.length >= maxLeads) {
        return {
          content: [{
            type: 'text',
            text: `已达到候选上限 ${maxLeads} 家,本次不再新增。请停止搜索,直接进入下一步结论输出。`,
          }],
          details: { error: 'limit_reached', count: leads.length },
        };
      }
      const lead: Lead = {
        id: nextId(),
        name,
        country: a.country?.trim() || 'United States',
        city: a.city?.trim(),
        website: a.website?.trim(),
        importyetiUrl: a.importyeti_url?.trim(),
        source: a.source?.trim(),
        note: a.note?.trim(),
      };
      leads.push(lead);
      hooks.onImporter?.(lead);
      return {
        content: [{ type: 'text', text: `已保存进口商 #${leads.length}:${lead.name}(${lead.city ?? lead.country ?? '地区未知'})` }],
        details: { id: lead.id, count: leads.length },
      };
    },
  };

  // ── ② save_verdict ───────────────────────────────────────────
  const saveVerdict: Tool = {
    name: 'save_verdict',
    description:
      '保存对某进口商的采购核验结论(第 3 步:判断它是否真的在采购目标产品)。' +
      'verdict: yes(明确在采购) / likely(很可能) / unknown(信息不足) / no(基本可排除)。' +
      'reason 必须写明依据(供应商名、官网产品线、检索来源);suppliers 填已知供应商或产地。',
    parameters: {
      type: 'object',
      properties: {
        company: { type: 'string', description: '进口商公司名(与线索一致)' },
        verdict: { type: 'string', description: 'yes | likely | unknown | no' },
        reason: { type: 'string', description: '判断依据,注明证据来源' },
        suppliers: { type: 'array', items: { type: 'string' }, description: '已知供应商/产地列表' },
        category: { type: 'string', description: '匹配的产品品类' },
        signal: { type: 'string', description: '采购信号,如近 12 个月提单数/最近采购时间;未知填"未知"' },
      },
      required: ['company', 'verdict', 'reason'],
    },
    async execute(_toolCallId, args) {
      const a = (args ?? {}) as {
        company?: string;
        verdict?: string;
        reason?: string;
        suppliers?: unknown;
        category?: string;
        signal?: string;
      };
      const company = (a.company ?? '').trim();
      if (!company) return { content: [{ type: 'text', text: '错误:缺少 company 参数' }], details: { error: 'missing_company' } };
      const v = (a.verdict ?? '').toLowerCase();
      const verdict: Verdict = v === 'yes' || v === 'likely' || v === 'no' ? (v as Verdict) : 'unknown';
      const suppliers = Array.isArray(a.suppliers) ? a.suppliers.filter((s): s is string => typeof s === 'string' && !!s.trim()) : [];

      const lead = find(company) ?? { id: nextId(), name: company } as Lead;
      if (!leads.includes(lead)) leads.push(lead);
      lead.verdict = verdict;
      lead.verdictReason = (a.reason ?? '').trim();
      lead.suppliers = suppliers.length ? suppliers : undefined;
      lead.matchedCategory = a.category?.trim() || undefined;
      lead.signal = a.signal?.trim() || undefined;
      hooks.onVerdict?.(lead);
      return {
        content: [{ type: 'text', text: `已保存核验结论:${lead.name} → ${verdict.toUpperCase()}` }],
        details: { id: lead.id, verdict },
      };
    },
  };

  // ── ③ save_contact ───────────────────────────────────────────
  const saveContact: Tool = {
    name: 'save_contact',
    description:
      '保存某进口商的官网与联系人线索(第 4 步:Google / LinkedIn 找公司官网和联系人)。' +
      '只填真实检索到的信息;没有的字段留空,绝不编造邮箱或人名。',
    parameters: {
      type: 'object',
      properties: {
        company: { type: 'string', description: '进口商公司名' },
        website: { type: 'string', description: '公司官网 URL' },
        linkedin: { type: 'string', description: 'LinkedIn 公司页 URL' },
        emails: { type: 'array', items: { type: 'string' }, description: '公开邮箱列表' },
        phones: { type: 'array', items: { type: 'string' }, description: '公开电话列表' },
        people: { type: 'array', items: { type: 'string' }, description: '关键人:"Name — Title"' },
        address: { type: 'string', description: '公司地址' },
        note: { type: 'string', description: '备注(如最佳联系渠道)' },
      },
      required: ['company'],
    },
    async execute(_toolCallId, args) {
      const a = (args ?? {}) as {
        company?: string;
        website?: string;
        linkedin?: string;
        emails?: unknown;
        phones?: unknown;
        people?: unknown;
        address?: string;
        note?: string;
      };
      const company = (a.company ?? '').trim();
      if (!company) return { content: [{ type: 'text', text: '错误:缺少 company 参数' }], details: { error: 'missing_company' } };

      const lead = find(company) ?? { id: nextId(), name: company } as Lead;
      if (!leads.includes(lead)) leads.push(lead);
      const strList = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && !!s.trim()).map((s) => s.trim()) : [];
      lead.contact = {
        website: a.website?.trim() || lead.website,
        linkedin: a.linkedin?.trim(),
        emails: strList(a.emails),
        phones: strList(a.phones),
        people: strList(a.people),
        address: a.address?.trim(),
        note: a.note?.trim(),
      };
      if (lead.contact.website) lead.website = lead.contact.website;
      hooks.onContact?.(lead);
      return {
        content: [{ type: 'text', text: `已保存联系人线索:${lead.name}(官网 ${lead.contact.website ?? '未找到'},邮箱 ${lead.contact.emails.length} 个)` }],
        details: { id: lead.id, emails: lead.contact.emails.length },
      };
    },
  };

  return { leads, saveImporter, saveVerdict, saveContact };
}
