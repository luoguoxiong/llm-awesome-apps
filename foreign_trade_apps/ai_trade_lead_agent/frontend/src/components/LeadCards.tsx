// foreign_trade_apps/ai_trade_lead_agent/frontend/src/components/LeadCards.tsx
// 客户卡片(右栏):每家进口商一张卡片 —— 核验结论 / 供应商 / 官网与联系人
// + AI 客户分析(Markdown 流式) + AI 个性化开发信(Markdown 流式,可一键复制)。
import type { LeadRun } from '../api';
import { Markdown } from './Markdown';

const VERDICT_LABEL: Record<string, string> = {
  yes: '✅ 确认在采购',
  likely: '🟡 很可能在采购',
  unknown: '⚪ 证据不足',
  no: '⛔ 已排除',
};

interface LeadCardsProps {
  run: LeadRun | null;
  onCopy: (text: string, label: string) => void;
}

export function LeadCards({ run, onCopy }: LeadCardsProps) {
  if (!run) {
    return <div className="process-empty">客户卡片将在此展示:含采购核验、供应商、官网/联系人、AI 分析与个性化开发信。</div>;
  }

  const leads = run.order.map((id) => run.leads[id]).filter(Boolean);
  if (leads.length === 0) {
    return (
      <div className="process-empty">
        {run.done ? '本轮未找到可用的进口商线索,建议更换更通用的英文关键词(如产品品类词)后重试。' : '正在检索进口商线索…'}
      </div>
    );
  }

  return (
    <div className="lead-cards">
      {leads.map((lead) => {
        const analysis = run.analysis[lead.id] ?? '';
        const email = run.emails[lead.id] ?? '';
        const contact = lead.contact;
        return (
          <article key={lead.id} className="lead-card">
            <header className="lead-card__head">
              <h3 className="lead-card__name">{lead.name}</h3>
              {lead.verdict && (
                <span className={`verdict-badge verdict-badge--${lead.verdict}`}>
                  {VERDICT_LABEL[lead.verdict] ?? lead.verdict}
                </span>
              )}
            </header>
            <div className="lead-card__meta">
              {[lead.city, lead.country].filter(Boolean).join(', ') || '地区未知'}
              {lead.matchedCategory ? ` · 品类:${lead.matchedCategory}` : ''}
              {lead.signal ? ` · 信号:${lead.signal}` : ''}
            </div>

            {lead.verdictReason && <p className="lead-card__reason">{lead.verdictReason}</p>}

            {lead.suppliers && lead.suppliers.length > 0 && (
              <div className="lead-card__row">
                <span className="lead-card__label">供应商/产地</span>
                <div className="chip-row">
                  {lead.suppliers.map((s, i) => (
                    <span key={i} className="chip chip--static">
                      {s}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {contact && (
              <div className="lead-card__row">
                <span className="lead-card__label">官网与联系人</span>
                <div className="contact-grid">
                  {contact.website && (
                    <a href={withScheme(contact.website)} target="_blank" rel="noreferrer noopener">
                      🌐 {contact.website}
                    </a>
                  )}
                  {contact.linkedin && (
                    <a href={withScheme(contact.linkedin)} target="_blank" rel="noreferrer noopener">
                      💼 LinkedIn
                    </a>
                  )}
                  {contact.emails.map((e, i) => (
                    <a key={i} href={`mailto:${e}`}>
                      ✉️ {e}
                    </a>
                  ))}
                  {contact.phones.map((p, i) => (
                    <span key={i}>📞 {p}</span>
                  ))}
                </div>
                {contact.people.length > 0 && (
                  <ul className="people-list">
                    {contact.people.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                )}
                {contact.address && <div className="lead-card__addr">📍 {contact.address}</div>}
              </div>
            )}

            {analysis && (
              <section className="lead-card__section">
                <div className="lead-card__section-head">
                  <span className="lead-card__label">AI 客户分析</span>
                </div>
                <div className="md-box">
                  <Markdown text={analysis} />
                </div>
              </section>
            )}

            {email && (
              <section className="lead-card__section">
                <div className="lead-card__section-head">
                  <span className="lead-card__label">AI 个性化开发信</span>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => onCopy(email, lead.name)}>
                    📋 复制开发信
                  </button>
                </div>
                <div className="md-box">
                  <Markdown text={email} />
                </div>
              </section>
            )}

            {!analysis && !email && run.done && (
              <p className="lead-card__pending">该客户未完成分析/开发信(证据不足或步骤失败)。</p>
            )}
          </article>
        );
      })}
    </div>
  );
}

/** 补 https:// 前缀(LLM 常返回裸域名) */
function withScheme(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url.replace(/^\/+/, '')}`;
}
