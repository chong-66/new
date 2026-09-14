export type PurificationMode = 'text' | 'regex';

export interface PurificationRule {
  id: string;
  name: string;
  enabled: boolean;
  mode: PurificationMode;
  find: string;
  replacement: string;
  ignoreCase: boolean;
  multiline: boolean;
  dotAll: boolean;
}

export interface PurificationResult {
  text: string;
  counts: Record<string, number>;
}

export const MAX_PURIFICATION_RULES = 100;
export const MAX_FIND_LENGTH = 2000;
export const MAX_REPLACEMENT_LENGTH = 10000;
export const MAX_SAMPLE_LENGTH = 50000;
export const PURIFICATION_TIMEOUT_MS = 1500;

function outputLimit(sourceLength: number) {
  return Math.max(1_000_000, sourceLength * 4);
}

export function validateRule(rule: PurificationRule): string {
  if (!rule.find.length) return '查找内容不能为空';
  if (rule.find.length > MAX_FIND_LENGTH) return `查找内容不能超过 ${MAX_FIND_LENGTH} 个字符`;
  if (rule.replacement.length > MAX_REPLACEMENT_LENGTH) return `替换内容不能超过 ${MAX_REPLACEMENT_LENGTH} 个字符`;
  if (rule.mode === 'regex') {
    try { new RegExp(rule.find, `gu${rule.ignoreCase ? 'i' : ''}${rule.multiline ? 'm' : ''}${rule.dotAll ? 's' : ''}`); }
    catch (error) { return `正则表达式无效：${error instanceof Error ? error.message : String(error)}`; }
  }
  return '';
}

function replaceRegex(source: string, regex: RegExp, replacement: string, limit: number) {
  const pieces: string[] = [];
  let count = 0, last = 0, size = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source))) {
    const piece = source.slice(last, match.index);
    size += piece.length + replacement.length;
    if (size > limit) throw new Error('净化后的正文过大');
    pieces.push(piece, replacement);
    count++;
    last = match.index + match[0].length;
    if (!match[0].length) {
      if (regex.lastIndex >= source.length) { regex.lastIndex = source.length + 1; break; }
      const cp = source.codePointAt(regex.lastIndex);
      regex.lastIndex += cp !== undefined && cp > 0xffff ? 2 : 1;
    }
  }
  const tail = source.slice(last);
  if (size + tail.length > limit) throw new Error('净化后的正文过大');
  pieces.push(tail);
  return { text: pieces.join(''), count };
}

function replaceText(source: string, find: string, replacement: string, ignoreCase: boolean, limit: number) {
  if (ignoreCase) {
    const escaped = find.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
    return replaceRegex(source, new RegExp(escaped, 'giu'), replacement, limit);
  }
  const pieces: string[] = [];
  let count = 0, start = 0, size = 0;
  while (true) {
    const index = source.indexOf(find, start);
    if (index < 0) break;
    const piece = source.slice(start, index);
    size += piece.length + replacement.length;
    if (size > limit) throw new Error('净化后的正文过大');
    pieces.push(piece, replacement);
    count++;
    start = index + find.length;
  }
  const tail = source.slice(start);
  if (size + tail.length > limit) throw new Error('净化后的正文过大');
  pieces.push(tail);
  return { text: pieces.join(''), count };
}

export function applyPurificationRules(source: string, rules: PurificationRule[]): PurificationResult {
  let text = source.replace(/\r\n?/g, '\n');
  const counts: Record<string, number> = {};
  const limit = outputLimit(source.length);
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const error = validateRule(rule);
    if (error) throw new Error(`${rule.name || '未命名规则'}：${error}`);
    const result = rule.mode === 'text'
      ? replaceText(text, rule.find, rule.replacement, rule.ignoreCase, limit)
      : replaceRegex(text, new RegExp(rule.find, `gu${rule.ignoreCase ? 'i' : ''}${rule.multiline ? 'm' : ''}${rule.dotAll ? 's' : ''}`), rule.replacement, limit);
    text = result.text;
    counts[rule.id] = result.count;
  }
  return { text, counts };
}
