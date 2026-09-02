/**
 * rag_tutorials/ai_rag_chain/src/pdf.ts
 *
 * 零依赖 PDF 文本提取(替代源应用的 PyMuPDF / PyPDFLoader)。
 *
 * 实现思路(best-effort,适用于常见简单 PDF):
 *   1. 扫描所有 `stream … endstream` 对象,优先 zlib 解压(FlateDecode),
 *      解压失败则按原始内容处理
 *   2. 仅保留含文本块(BT…ET)的内容流
 *   3. 从内容流中提取文本展示算子:
 *        (…) Tj      单字符串展示
 *        [ (…) (…) ] TJ   数组展示(字符串间可能有定位调整)
 *      并在 Td / TD / T* / ' 等换行定位算子处插入换行
 *   4. 还原 PDF 字符串转义(\n \r \t \( \) \\ \ddd 八进制)
 *
 * 局限:使用 CID/Identity-H 编码嵌入字体的现代 PDF 可能提取出乱码或空文本;
 * 此类文件建议转为 .txt / .md 上传(README 已注明)。
 */
import { inflateSync } from 'node:zlib';

/** 还原 PDF 字符串转义 */
function unescapePdf(s: string): string {
  return s.replace(/\\(n|r|t|b|f|\(|\)|\\|[0-7]{1,3})/g, (whole, g1: string) => {
    if (/^[0-7]+$/.test(g1)) return String.fromCharCode(parseInt(g1, 8));
    const map: Record<string, string> = {
      n: '\n',
      r: '\r',
      t: '\t',
      b: '\b',
      f: '\f',
      '(': '(',
      ')': ')',
      '\\': '\\',
    };
    return map[g1] ?? whole;
  });
}

interface TextPiece {
  pos: number;
  text: string;
}

/** 从单个内容流(拉丁字符串)中提取文本片段 */
function extractFromContent(content: string): string {
  const pieces: TextPiece[] = [];

  // (…) Tj:单字符串展示
  for (const m of content.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj\b/g)) {
    pieces.push({ pos: m.index, text: unescapePdf(m[1]) });
  }

  // [ (…) (…) … ] TJ:数组展示
  for (const m of content.matchAll(/\[((?:\\.|[^\]\\])*)\]\s*TJ\b/g)) {
    let text = '';
    for (const s of m[1].matchAll(/\(((?:\\.|[^\\()])*)\)/g)) {
      text += unescapePdf(s[1]);
    }
    pieces.push({ pos: m.index, text });
  }

  if (pieces.length === 0) return '';

  // 换行定位算子的位置(Td / TD / T* / '),用于在片段之间插入换行
  const breakPositions: number[] = [];
  for (const m of content.matchAll(/\bT[dD]\b|\bT\*/g)) breakPositions.push(m.index);
  pieces.sort((a, b) => a.pos - b.pos);

  let out = '';
  let prevEnd = -1;
  for (const piece of pieces) {
    if (out.length > 0) {
      const hasBreak = breakPositions.some((p) => p > prevEnd && p < piece.pos);
      out += hasBreak ? '\n' : '';
    }
    out += piece.text;
    prevEnd = piece.pos;
  }
  return out;
}

/** 提取 PDF 全文(best-effort);无法提取任何文本时返回空字符串 */
export function extractPdfText(buf: Buffer): string {
  const texts: string[] = [];
  let idx = 0;
  while (idx < buf.length) {
    const s = buf.indexOf('stream', idx);
    if (s === -1) break;
    // 跳过 endstream 误匹配
    if (buf.subarray(Math.max(0, s - 3), s).toString('latin1') === 'end') {
      idx = s + 6;
      continue;
    }
    let dataStart = s + 6;
    if (buf[dataStart] === 0x0d) dataStart++;
    if (buf[dataStart] === 0x0a) dataStart++;
    const e = buf.indexOf('endstream', dataStart);
    if (e === -1) break;

    const seg = buf.subarray(dataStart, e);
    let decoded: Buffer | null = null;
    try {
      decoded = inflateSync(seg);
    } catch {
      decoded = null; // 未压缩或其他过滤器,按原始内容处理
    }

    const content = (decoded ?? seg).toString('latin1');
    // 仅处理含文本块的流(过滤图片/字体/元数据流)
    if (content.includes('BT') && content.includes('ET')) {
      const text = extractFromContent(content);
      if (text.trim()) texts.push(text);
    }
    idx = e + 9;
  }

  return texts
    .join('\n')
    // 压缩空白:合并连续空格/换行
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
