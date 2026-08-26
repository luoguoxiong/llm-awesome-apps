// starter_ai_agents/ai_breakup_recovery_agent/frontend/src/components/Markdown.tsx
// 轻量 Markdown 渲染(零依赖),面向 Agent 输出:
// 块级:标题(#~####)/无序有序列表/引用/代码块/表格/分隔线/段落
// 行内:加粗/斜体/行内代码/链接/自动链接
// 流式安全:未闭合代码块按普通代码块渲染;逐字追加时仅重渲染本组件。
import { type ReactNode, useMemo } from 'react';

interface MarkdownProps {
  text: string;
}

export function Markdown({ text }: MarkdownProps): ReactNode {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return <div className="md-body">{blocks.map((b, i) => renderBlock(b, i))}</div>;
}

// ─── 块级解析 ───────────────────────────────────────────────────

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'code'; lang: string; text: string; closed: boolean }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'hr' };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r/g, '').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }

    // 代码块 ```
    if (line.trim().startsWith('```')) {
      const lang = line.trim().slice(3).trim();
      const buf: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if (lines[i].trim().startsWith('```')) {
          closed = true;
          i++;
          break;
        }
        buf.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'code', lang, text: buf.join('\n'), closed });
      continue;
    }

    // 标题 # ~ ####
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length, text: h[2].trim() });
      i++;
      continue;
    }

    // 分隔线 --- / *** / ___
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // 引用 >
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', text: buf.join('\n') });
      continue;
    }

    // 表格(| 开头且下一行是分隔行)
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const header = parseTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(parseTableRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    // 列表(- / * / + 或 1.)
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const ordered = !!ol;
      const re = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(re);
        if (!m) {
          // 允许列表项折行(缩进续行)
          if (items.length > 0 && /^\s+\S/.test(lines[i]) && !/^\s*[-*+]\s/.test(lines[i]) && !/^\s*\d+[.)]\s/.test(lines[i])) {
            items[items.length - 1] += ' ' + lines[i].trim();
            i++;
            continue;
          }
          break;
        }
        items.push(m[1]);
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // 段落(连续非空行)
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i]) && !(lines[i].trim().startsWith('|'))) {
      buf.push(lines[i]);
      i++;
    }
    if (buf.length === 0) {
      // 兜底:单行消费,避免死循环
      buf.push(line);
      i++;
    }
    blocks.push({ type: 'paragraph', text: buf.join('\n') });
  }
  return blocks;
}

function parseTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (const ch of s) {
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

// ─── 块级渲染 ───────────────────────────────────────────────────

function renderBlock(b: Block, key: number): ReactNode {
  switch (b.type) {
    case 'heading': {
      const Tag = `h${Math.min(b.level + 1, 6)}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      return (
        <Tag key={key} className={`md-h md-h--${b.level}`}>
          {renderInline(b.text)}
        </Tag>
      );
    }
    case 'paragraph':
      return (
        <p key={key} className="md-p">
          {renderInline(b.text)}
        </p>
      );
    case 'list': {
      const ListTag = b.ordered ? 'ol' : 'ul';
      return (
        <ListTag key={key} className={b.ordered ? 'md-ol' : 'md-ul'}>
          {b.items.map((item, j) => (
            <li key={j}>{renderInline(item)}</li>
          ))}
        </ListTag>
      );
    }
    case 'quote':
      return (
        <blockquote key={key} className="md-quote">
          {renderInline(b.text)}
        </blockquote>
      );
    case 'code':
      return (
        <pre key={key} className="md-code">
          <code>{b.text}</code>
        </pre>
      );
    case 'table':
      return (
        <div key={key} className="table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {b.header.map((h, j) => (
                  <th key={j}>{renderInline(h)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, j) => (
                <tr key={j}>
                  {r.map((c, k) => (
                    <td key={k}>{renderInline(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'hr':
      return <hr key={key} className="md-hr" />;
  }
}

// ─── 行内解析(加粗/斜体/行内代码/链接)────────────────────────────

/** 把行内 Markdown 切成 [纯文本 | 标记段] 序列 */
function renderInline(text: string): ReactNode {
  const nodes: ReactNode[] = [];
  // 匹配顺序:行内代码 → 链接 → 加粗 → 斜体 → 自动链接
  const re =
    /(`[^`\n]+`)|(\[[^\]\n]+\]\([^)\s]+\))|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(https?:\/\/[^\s<>()\[\]{}"'|\\]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let seq = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) {
      nodes.push(
        <code key={seq++} className="md-inline-code">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith('[')) {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (lm) {
        nodes.push(
          <a key={seq++} href={lm[2]} target="_blank" rel="noreferrer noopener">
            {lm[1]}
          </a>,
        );
      } else {
        nodes.push(tok);
      }
    } else if (tok.startsWith('**')) {
      nodes.push(
        <strong key={seq++} className="md-strong">
          {tok.slice(2, -2)}
        </strong>,
      );
    } else if (tok.startsWith('*')) {
      nodes.push(
        <em key={seq++} className="md-em">
          {tok.slice(1, -1)}
        </em>,
      );
    } else {
      nodes.push(
        <a key={seq++} href={tok} target="_blank" rel="noreferrer noopener">
          {tok.length > 60 ? `${tok.slice(0, 57)}…` : tok}
        </a>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
