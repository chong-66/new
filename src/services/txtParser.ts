export const MAX_TXT_BYTES = 30 * 1024 * 1024;
export const TXT_PARSER_VERSION = 1;

export type TxtEncoding = 'auto' | 'utf-8' | 'gb18030' | 'big5' | 'utf-16le' | 'utf-16be';
export type TxtSplitMode = 'auto' | 'length';

export interface TxtSection { title: string; start: number; end: number }
export interface ParsedTxt {
  text: string;
  encoding: Exclude<TxtEncoding, 'auto'>;
  sections: TxtSection[];
  splitMethod: 'headings' | 'length';
  warnings: string[];
}

const TITLE_LIMIT = 80;
const TARGET = 6000;
const MIN_CHUNK = 4000;
const MAX_CHUNK = 8000;
const MAX_SECTION = 20000;
const specialTitle = /^(?:序章|序言|前言|楔子|引子|尾声|后记|番外)(?:[0-9０-９一二三四五六七八九十百千万]+|(?:\s*[：:、.．\-—]\s*|\s+)[^。！？!?]{1,30})?$/u;
const cnTitle = /^(?:正文\s*)?第\s*[0-9０-９零〇一二三四五六七八九十百千万两]+\s*[章回节](?:\s*|\s*[：:、.．\-—]\s*[^。！？!?]{1,48}|\s+[^。！？!?]{1,48})$/u;
const enTitle = /^chapter\s+(?:\d+|[ivxlcdm]+)(?:\s*|\s*[.:：\-—]\s*[^.!?]{1,48}|\s+[^.!?]{1,48})$/iu;
const volumeTitle = /^第\s*[0-9０-９零〇一二三四五六七八九十百千万两]+\s*[卷部篇](?:\s*|\s*[：:、.．\-—]\s*[^。！？!?]{1,48}|\s+[^。！？!?]{1,48})$/u;

function normalize(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function decodeWith(bytes: Uint8Array, encoding: Exclude<TxtEncoding, 'auto'>, offset = 0): string {
  return new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset));
}

export function decodeTxt(buffer: ArrayBuffer, requested: TxtEncoding = 'auto') {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength > MAX_TXT_BYTES) throw new Error('TXT 文件不能超过 30 MiB');
  if (!bytes.byteLength) throw new Error('TXT 文件为空');
  let encoding: Exclude<TxtEncoding, 'auto'>;
  let offset = 0;
  if (requested !== 'auto') encoding = requested;
  else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) { encoding = 'utf-8'; offset = 3; }
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; offset = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; offset = 2; }
  else {
    try { decodeWith(bytes, 'utf-8'); encoding = 'utf-8'; }
    catch { encoding = 'gb18030'; }
  }
  let text: string;
  try { text = normalize(decodeWith(bytes, encoding, offset)); }
  catch { throw new Error(`无法用 ${encoding} 解码，请手动选择编码`); }
  if (!text.trim()) throw new Error('TXT 文件没有可阅读内容');
  const controlCount = (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) ?? []).length;
  if (controlCount > Math.max(8, text.length * 0.01)) throw new Error('文件不像可阅读的 TXT 文本');
  return { text, encoding };
}

function titleFor(line: string, allowVolume: boolean): string | null {
  const value = line.trim();
  if (!value || value.length > TITLE_LIMIT) return null;
  if (cnTitle.test(value) || enTitle.test(value) || specialTitle.test(value) || (allowVolume && volumeTitle.test(value))) return value;
  return null;
}

function safeCut(text: string, start: number, desired: number): number {
  let cut = Math.min(text.length, desired);
  if (cut < text.length && cut > start && /[\uD800-\uDBFF]/.test(text[cut - 1])) cut--;
  return cut;
}

function findCut(text: string, start: number, hardEnd: number): number {
  const min = Math.min(hardEnd, start + MIN_CHUNK);
  const max = Math.min(hardEnd, start + MAX_CHUNK);
  if (max >= hardEnd) return hardEnd;
  const target = Math.min(max, start + TARGET);
  for (let d = 0; d <= Math.max(target - min, max - target); d++) {
    for (const pos of [target + d, target - d]) {
      if (pos >= min && pos <= max && text[pos - 1] === '\n') return safeCut(text, start, pos);
    }
  }
  for (let pos = target; pos <= max; pos++) if (/[。！？.!?]/u.test(text[pos - 1])) return safeCut(text, start, pos);
  for (let pos = target; pos >= min; pos--) if (/[。！？.!?]/u.test(text[pos - 1])) return safeCut(text, start, pos);
  return safeCut(text, start, target);
}

function splitRange(text: string, start: number, end: number, title: string): TxtSection[] {
  if (end - start <= MAX_SECTION) return [{ title, start, end }];
  const result: TxtSection[] = [];
  let pos = start;
  while (pos < end) {
    const next = findCut(text, pos, end);
    result.push({ title: `${title}（${result.length + 1}）`, start: pos, end: next });
    pos = next;
  }
  return result;
}

function lengthSections(text: string): TxtSection[] {
  const sections: TxtSection[] = [];
  let pos = 0;
  while (pos < text.length) {
    const end = findCut(text, pos, text.length);
    sections.push({ title: text.length <= MAX_SECTION ? '正文' : `第 ${sections.length + 1} 节`, start: pos, end });
    pos = end;
  }
  return sections;
}

function headingSections(text: string): TxtSection[] | null {
  const lines: { start: number; end: number; title: string | null }[] = [];
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline < 0 ? text.length : newline + 1;
    lines.push({ start, end, title: null });
    if (newline < 0) break;
    start = end;
  }
  const hasMain = lines.some((line) => cnTitle.test(text.slice(line.start, line.end).trim()) || enTitle.test(text.slice(line.start, line.end).trim()));
  for (const line of lines) line.title = titleFor(text.slice(line.start, line.end), !hasMain);
  let points = lines.filter((line) => line.title) as Array<{ start: number; end: number; title: string }>;
  if (!points.length) return null;
  let tocCount = 0;
  for (let i = 0; i < points.length - 1; i++) {
    if (points[i].start > Math.min(5000, text.length * 0.2)) break;
    const between = text.slice(points[i].end, points[i + 1].start).trim();
    if (between.length <= 40) tocCount++; else break;
  }
  if (tocCount >= 4) points = points.slice(tocCount);
  if (!points.length) return null;
  if (points.length === 1 && points[0].start > Math.min(2000, text.length * 0.25)) return null;
  const sections: TxtSection[] = [];
  if (points[0].start > 0 && text.slice(0, points[0].start).trim()) sections.push(...splitRange(text, 0, points[0].start, '前言'));
  for (let i = 0; i < points.length; i++) {
    const end = points[i + 1]?.start ?? text.length;
    sections.push(...splitRange(text, points[i].start, end, points[i].title));
  }
  return sections;
}

export function parseDecodedTxt(text: string, encoding: ParsedTxt['encoding'], splitMode: TxtSplitMode = 'auto'): ParsedTxt {
  const normalized = normalize(text);
  if (!normalized.trim()) throw new Error('TXT 文件没有可阅读内容');
  const headings = splitMode === 'auto' ? headingSections(normalized) : null;
  const warnings: string[] = [];
  if (!headings) warnings.push('未识别到可靠章节标题，已按长度自动分段');
  return { text: normalized, encoding, sections: headings ?? lengthSections(normalized), splitMethod: headings ? 'headings' : 'length', warnings };
}

export function parseTxt(buffer: ArrayBuffer, encoding: TxtEncoding = 'auto', splitMode: TxtSplitMode = 'auto'): ParsedTxt {
  const decoded = decodeTxt(buffer, encoding);
  return parseDecodedTxt(decoded.text, decoded.encoding, splitMode);
}
