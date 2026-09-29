/**
 * foreign_trade_apps/ai_trade_lead_agent/src/runtime.ts
 *
 * 外贸获客流水线(基于 @aipack-ai/agent,单次任务多次 Runtime 编排):
 *   ① 关键词 → ImportYeti 找美国进口商        (save_importer)
 *   ② 查进口商的供应商 → 判断是否真在采购      (lookup_importer_suppliers + save_verdict)
 *   ③ Google / LinkedIn 找官网与联系人         (search_web + fetch_url + save_contact)
 *   ④ AI 客户分析(流式 Markdown)
 *   ⑤ AI 生成个性化开发信(流式 Markdown)
 *
 * 每一步是独立 Runtime(工具集与系统提示词不同),流式增量经 Progress 回调推送 SSE。
 */
import { createRuntime, createRequest, type Model, type StreamFn, type Tool } from '@aipack-ai/agent';
import { createSearchTool } from './tools/search.js';
import { createFetchUrlTool } from './tools/fetchUrl.js';
import { createSearchImportYetiTool, createLookupSuppliersTool } from './tools/importyeti.js';
import type { Lead, LeadStore } from './tools/leads.js';

// ─── 类型 ───────────────────────────────────────────────────────

export type PipelineStage = 'importers' | 'verify' | 'contacts' | 'analysis' | 'email';

export interface PipelineInput {
  /** 产品关键词 */
  keyword: string;
  /** 目标市场,默认 United States */
  market: string;
  /** 我方公司与优势(可选,用于个性化开发信) */
  sellerProfile: string;
  /** 候选进口商数量上限 */
  maxLeads: number;
}

export interface PipelineContext {
  model: Model;
  streamFn: StreamFn;
  serpapiKey?: string;
}

export type Progress =
  | { type: 'stage'; stage: PipelineStage | 'done'; label: string; leadId?: string }
  | { type: 'log'; delta: string }
  | { type: 'delta'; target: 'analysis' | 'email'; leadId: string; delta: string }
  | { type: 'tool'; phase: 'start' | 'end'; toolName: string }
  | { type: 'error'; message: string };

// ─── 系统提示词 ─────────────────────────────────────────────────

const SOURCING_PROMPT = `你是资深外贸获客专家(B2B Lead Sourcing),任务:围绕用户给出的产品关键词,找出正在从中国/亚洲采购该类产品的美国进口商、品牌商与批发分销商候选。

工作流程:
1. 先调用 search_importyeti 查询关键词,从美国海关提单数据中拿到进口商公司名与 ImportYeti 公司页链接。
2. 用 search_web 交叉验证并扩展线索,例如:
   - "<keyword> importer USA"、"<keyword> distributor wholesale USA"
   - "<keyword> brand company USA"、"美国 <keyword> 进口商"
   - 需要时用 site: 语法(如 "<keyword> importer site:importyeti.com")
3. 对有价值的公司(如官网显示经营该类产品)可调用 fetch_url 打开官网 About/Products 页确认。
4. 每确认一家就调用 save_importer 保存:name 用英文官方名;country/city/website/importyeti_url/source/note 能填就填。

筛选优先级:有实际采购规模的进口商 / 自有品牌商 / 批发分销商 > 零售商 > 物流报关行(排除货运代理、报关行、纯电商平台卖家)。

规则:
- 只保存工具返回的真实公司,绝不编造公司名、网址或数据。
- 达到候选上限时工具会提示,立即停止搜索并输出结论。
- 数据不足时如实说明,并给出已找到的线索。

输出:先一句话说明本次检索的数据来源与可信度,再用 3-5 句总结候选名单构成(采购属性、品类匹配、下一步核验重点)。简洁,中文。`;

const VERIFY_PROMPT = `你是外贸背景调查分析师。给定一家美国进口商与目标产品关键词,判断它是否真的在采购该产品(第 3 步:查看进口商的供应商 → 判断是否真在采购)。

工作流程:
1. 调用 lookup_importer_suppliers(带 company、keyword,有 ImportYeti 链接则带上 importyeti_url),拿到供应商名单与原产国线索。
2. 用 search_web / fetch_url 交叉验证:
   - "<company> supplier"、"<company> sourcing"、"<company> made in"
   - 官网 About / Products / 经销页面(fetch_url)
   - 判断它经营的产品品类是否与目标关键词一致,是否为品牌商/批发商而非零售商/物流商
3. 调用 save_verdict 保存结论:
   - verdict: yes(海关数据或官网明确显示正从中国/亚洲采购该类产品)
            / likely(经营该类产品且有海外采购迹象,但证据间接)
            / unknown(信息不足)
            / no(明显不经营该产品、仅为物流报关行、或无采购迹象)
   - reason: 必须写明具体依据(供应商名、产地、官网产品线、检索来源),没有证据就写"未找到公开证据"
   - suppliers: 已知供应商或产地列表;category: 匹配品类;signal: 采购信号(提单数/最近采购时间,未知填"未知")

规则:
- 证据优先于猜测:拿不到证据就判 unknown,绝不臆断。
- 明确区分"经营该类产品"与"从中国采购该类产品"。

输出:2-4 句中文结论(判定 + 关键证据 + 建议是否继续开发),不要重复工具原文。`;

const CONTACTS_PROMPT = `你是外贸客户开发专员。任务:为指定的美国进口商找到公司官网与可触达的联系人线索(第 4 步:Google / LinkedIn 找公司官网和联系人)。

工作流程:
1. search_web 组合检索:
   - "<company> official website"、"<company> contact email"
   - "<company> site:linkedin.com/company"(LinkedIn 公司页)
   - "<company> procurement manager / sourcing manager / purchasing"(关键人)
2. 用 fetch_url 打开官网首页 / About / Contact 页,提取:官网域名、邮箱、电话、地址、社媒链接、采购/供应链相关人名与职位。
3. 调用 save_contact 保存:website / linkedin / emails / phones / people(格式 "Name — Title") / address / note。

规则:
- 只填真实检索到的信息,没有就留空;绝不编造邮箱、电话或人名。
- 优先采购、供应链、产品开发负责人;找不到个人邮箱时保存公司通用邮箱(info@/sales@)。

输出:3-5 句中文说明(官网与 LinkedIn 是否找到、可用邮箱/关键人、推荐的最佳触达渠道)。`;

const ANALYSIS_PROMPT = `你是外贸客户分析专家。基于已核验的客户信息(供应商名单、采购判定、官网与联系人),输出一份可直接用于销售决策的客户分析。

严格按以下 Markdown 结构输出(不要多余开场白):
## 客户画像
(公司性质、主营品类、规模与渠道、官网/地区信息)
## 采购匹配度
(高/中/低 + 具体依据:现有供应商与产地、是否从中国/亚洲采购、与关键词的品类契合度)
## 切入策略
(切入角度、价值主张、建议主推的产品与话术要点、适合的报价/起订量策略)
## 风险与注意事项
(证据缺口、可能已有稳定供应商、合规/认证要求等)

规则:只依据已给出的真实信息;信息缺失处明确标注"需进一步确认",绝不编造数据。中文,精炼务实。`;

const EMAIL_PROMPT = `你是外贸开发信撰写专家。基于客户分析与核验证据,写一封高质量、个性化的英文开发信(第 5 步:AI 生成个性化开发信)。

严格按以下 Markdown 结构输出:
## 邮件主题
(2-3 个备选主题,英文,标注推荐)
## 正文(English)
(120-180 词,英文商务风格:开场点明对其产品线/采购的具体观察 → 我方差异化价值 → 明确的低门槛下一步,如样品/报价/目录;不要模板腔、不要空泛夸赞)
## 中文要点
(3-5 条:本信的个性化锚点、为什么这样写、可替换的卖点)
## 跟进节奏
(Day 0 / Day 3 / Day 7 的三次跟进要点)

规则:
- 必须引用真实证据(已知供应商/产地/品类/官网信息),让收件人感到"被研究过"。
- 我方信息以"我方公司/优势"字段为准;该字段为空时留占位符 [Your Company] / [Your Advantage],不要编造。
- 不写虚假认证、虚假客户案例。中文说明 + 英文正文。`;

// ─── 单步执行器 ─────────────────────────────────────────────────

interface StepOptions {
  systemPrompt: string;
  userPrompt: string;
  tools: Tool[];
  maxTurns: number;
  model: Model;
  streamFn: StreamFn;
  /** 正文增量(阶段日志 / 分析 / 开发信) */
  onText?: (delta: string) => void;
  onTool?: (toolName: string, phase: 'start' | 'end') => void;
  signal?: AbortSignal;
}

/** 创建 Runtime 并流式执行一步,返回完整文本 */
async function runStep(opts: StepOptions): Promise<string> {
  const runtime = createRuntime({
    model: opts.model,
    streamFn: opts.streamFn,
    systemPrompt: opts.systemPrompt,
    tools: opts.tools,
    maxTurns: opts.maxTurns,
    config: { role: 'trade-lead-agent' },
  });
  let text = '';
  try {
    for await (const chunk of runtime.stream(createRequest(opts.userPrompt))) {
      if (opts.signal?.aborted) throw new Error('aborted');
      if (chunk.type === 'text' && chunk.content) {
        text += chunk.content;
        opts.onText?.(chunk.content);
      } else if (chunk.type === 'tool_start' && chunk.toolName) {
        opts.onTool?.(chunk.toolName, 'start');
      } else if (chunk.type === 'tool_end' && chunk.toolName) {
        opts.onTool?.(chunk.toolName, 'end');
      } else if (chunk.type === 'error') {
        throw new Error(chunk.content || '模型执行出错');
      }
    }
  } finally {
    try {
      await runtime.close();
    } catch {
      // 忽略关闭错误
    }
  }
  return text;
}

// ─── 流水线 ─────────────────────────────────────────────────────

/** 已核验为"可继续开发"的判定(排除 no) */
function keepForDevelopment(lead: Lead): boolean {
  return lead.verdict !== 'no';
}

/** 组装客户上下文(供分析/开发信使用) */
function buildLeadBrief(lead: Lead, input: PipelineInput): string {
  const lines = [
    `客户:${lead.name}`,
    `地区:${[lead.city, lead.country].filter(Boolean).join(', ') || '未知'}`,
    `目标产品关键词:${input.keyword}`,
    `采购判定:${(lead.verdict ?? 'unknown').toUpperCase()}${lead.verdictReason ? `(${lead.verdictReason})` : ''}`,
    `匹配品类:${lead.matchedCategory ?? '未确认'}`,
    `采购信号:${lead.signal ?? '未知'}`,
    `已知供应商/产地:${lead.suppliers?.length ? lead.suppliers.join('、') : '未获取到'}`,
    `官网:${lead.contact?.website ?? lead.website ?? '未找到'}`,
    `LinkedIn:${lead.contact?.linkedin ?? '未找到'}`,
    `邮箱:${lead.contact?.emails?.length ? lead.contact.emails.join('、') : '未找到'}`,
    `关键人:${lead.contact?.people?.length ? lead.contact.people.join(';') : '未找到'}`,
    `地址:${lead.contact?.address ?? '未找到'}`,
    `备注:${[lead.note, lead.contact?.note].filter(Boolean).join(' / ') || '无'}`,
    `我方公司/优势:${input.sellerProfile.trim() || '(未填写,请用占位符 [Your Company] / [Your Advantage])'}`,
  ];
  return lines.join('\n');
}

export interface PipelineResult {
  leads: Lead[];
  /** 各阶段小结文本(供调试/展示) */
  notes: Partial<Record<PipelineStage, string>>;
}

/**
 * 执行完整获客流水线。store 由调用方创建(写入即推送 SSE)。
 * 单家客户失败不影响整体流水线(错误记入该客户日志)。
 */
export async function runPipeline(
  input: PipelineInput,
  ctx: PipelineContext,
  store: LeadStore,
  onProgress: (p: Progress) => void,
  signal?: AbortSignal,
): Promise<PipelineResult> {
  const notes: Partial<Record<PipelineStage, string>> = {};
  const abort = () => {
    if (signal?.aborted) throw new Error('aborted');
  };

  // ── ① 找美国进口商 ────────────────────────────────────────────
  onProgress({ type: 'stage', stage: 'importers', label: 'ImportYeti 检索美国进口商' });
  const sourcingNote = await runStep({
    systemPrompt: SOURCING_PROMPT,
    userPrompt:
      `产品关键词:${input.keyword}\n目标市场:${input.market || 'United States'}\n候选数量上限:${input.maxLeads}`,
    tools: [
      createSearchImportYetiTool(ctx.serpapiKey),
      createSearchTool(ctx.serpapiKey),
      createFetchUrlTool(),
      store.saveImporter,
    ],
    maxTurns: 14,
    model: ctx.model,
    streamFn: ctx.streamFn,
    onText: (delta) => onProgress({ type: 'log', delta }),
    onTool: (toolName, phase) => onProgress({ type: 'tool', phase, toolName }),
    signal,
  });
  notes.importers = sourcingNote;
  abort();

  if (store.leads.length === 0) {
    onProgress({
      type: 'log',
      delta: '\n⚠️ 本轮未保存任何进口商线索(ImportYeti 需登录或关键词冷门)。可更换更通用的英文关键词后重试。\n',
    });
  }

  // ── ② 查供应商 → 判断是否真在采购 ──────────────────────────────
  onProgress({ type: 'stage', stage: 'verify', label: '核查供应商与采购真实性' });
  const targets = store.leads.slice(0, input.maxLeads);
  for (const lead of targets) {
    abort();
    onProgress({ type: 'stage', stage: 'verify', label: `核验 ${lead.name}`, leadId: lead.id });
    try {
      const note = await runStep({
        systemPrompt: VERIFY_PROMPT,
        userPrompt:
          `进口商:${lead.name}\n目标产品关键词:${input.keyword}\n` +
          `已知官网:${lead.website ?? '未知'}\nImportYeti 链接:${lead.importyetiUrl ?? '未知'}\n` +
          `线索备注:${lead.note ?? '无'}`,
        tools: [
          createLookupSuppliersTool(ctx.serpapiKey),
          createSearchTool(ctx.serpapiKey),
          createFetchUrlTool(),
          store.saveVerdict,
        ],
        maxTurns: 10,
        model: ctx.model,
        streamFn: ctx.streamFn,
        onText: (delta) => onProgress({ type: 'log', delta }),
        onTool: (toolName, phase) => onProgress({ type: 'tool', phase, toolName }),
        signal,
      });
      notes.verify = [notes.verify, note].filter(Boolean).join('\n');
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'aborted') throw err;
      onProgress({ type: 'log', delta: `\n[${lead.name}] 核验失败:${msg}\n` });
    }
  }

  // ── ③ Google / LinkedIn 找官网与联系人 ─────────────────────────
  const developTargets = store.leads.filter(keepForDevelopment);
  onProgress({ type: 'stage', stage: 'contacts', label: 'Google / LinkedIn 找官网与联系人' });
  for (const lead of developTargets) {
    abort();
    onProgress({ type: 'stage', stage: 'contacts', label: `查找 ${lead.name} 联系人`, leadId: lead.id });
    try {
      await runStep({
        systemPrompt: CONTACTS_PROMPT,
        userPrompt:
          `进口商:${lead.name}\n地区:${[lead.city, lead.country].filter(Boolean).join(', ') || '未知'}\n` +
          `目标产品关键词:${input.keyword}\n已知官网:${lead.website ?? lead.contact?.website ?? '未知'}\n` +
          `已知供应商/产地:${lead.suppliers?.length ? lead.suppliers.join('、') : '未知'}`,
        tools: [createSearchTool(ctx.serpapiKey), createFetchUrlTool(), store.saveContact],
        maxTurns: 10,
        model: ctx.model,
        streamFn: ctx.streamFn,
        onText: (delta) => onProgress({ type: 'log', delta }),
        onTool: (toolName, phase) => onProgress({ type: 'tool', phase, toolName }),
        signal,
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'aborted') throw err;
      onProgress({ type: 'log', delta: `\n[${lead.name}] 联系人检索失败:${msg}\n` });
    }
  }

  // ── ④ AI 客户分析 ─────────────────────────────────────────────
  onProgress({ type: 'stage', stage: 'analysis', label: 'AI 分析客户' });
  for (const lead of developTargets) {
    abort();
    onProgress({ type: 'stage', stage: 'analysis', label: `分析 ${lead.name}`, leadId: lead.id });
    try {
      await runStep({
        systemPrompt: ANALYSIS_PROMPT,
        userPrompt: buildLeadBrief(lead, input),
        tools: [],
        maxTurns: 1,
        model: ctx.model,
        streamFn: ctx.streamFn,
        onText: (delta) => onProgress({ type: 'delta', target: 'analysis', leadId: lead.id, delta }),
        signal,
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'aborted') throw err;
      onProgress({ type: 'error', message: `[${lead.name}] 客户分析失败:${msg}` });
    }
  }

  // ── ⑤ AI 生成个性化开发信 ──────────────────────────────────────
  onProgress({ type: 'stage', stage: 'email', label: 'AI 生成个性化开发信' });
  for (const lead of developTargets) {
    abort();
    onProgress({ type: 'stage', stage: 'email', label: `撰写 ${lead.name} 开发信`, leadId: lead.id });
    try {
      await runStep({
        systemPrompt: EMAIL_PROMPT,
        userPrompt: buildLeadBrief(lead, input),
        tools: [],
        maxTurns: 1,
        model: ctx.model,
        streamFn: ctx.streamFn,
        onText: (delta) => onProgress({ type: 'delta', target: 'email', leadId: lead.id, delta }),
        signal,
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'aborted') throw err;
      onProgress({ type: 'error', message: `[${lead.name}] 开发信生成失败:${msg}` });
    }
  }

  onProgress({ type: 'stage', stage: 'done', label: '流水线完成' });
  return { leads: store.leads, notes };
}
