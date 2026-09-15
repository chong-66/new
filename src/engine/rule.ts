import { jsonQuery, jsonQueryList } from './jsonpath';
import { parseUrlWithOptions, resolveUrl } from './template';
import { fetchText } from './http';
import { parse } from '@babel/parser';

/**
 * 阅读 3.0 常用规则兼容层：
 * - Default/CSS 链、位置、数组筛选及 text/html/属性取值
 * - `@css:` 的 eq/lt/gt/first/last 位置选择
 * - `@XPath:` 或 `//`、JSONPath 子集、AllInOne/OnlyOne 正则
 * - `<js>...</js>` / `@js:`、`||`/`&&`/`%%`、正则替换
 *
 * 仍不提供完整 Android/Java、WebView、登录及 CookieJar 运行环境。
 */

export interface RuleCtx {
  memory?: Map<string, unknown>;
  signal?: AbortSignal;
  baseUrl: string;
  /** 当前文档（CSS/XPath 模式） */
  doc?: Document;
  /** 当前元素（列表项子规则） */
  element?: Element;
  /** 当前 JSON 数据（@JSon 模式） */
  json?: unknown;
  /** 当前文本（JS 模式的 result） */
  text?: string;
  /** 当前网络响应原文，供 AllInOne/OnlyOne 正则使用 */
  raw?: string;
  /** AllInOne 正则列表项的完整匹配及捕获组 */
  captures?: string[];
  /** 书籍信息（JS 规则可用） */
  book?: Record<string, unknown>;
  /** 书源信息（JS 规则可用） */
  source?: Record<string, unknown>;
  key?: string;
  page?: number;
}

const MODE_RE = /^@(XPath|JSon|JSON|JS|Css|CSS|Regex):/i;
/** 规则末尾的取值属性（仅匹配已知属性名，避免把 @a/@li/@dd 等标签名当成属性） */
const ATTR_RE = /@(text|ownText|html|outerHtml|textNodes|href|src|src\d?|alt|title|class|id|style|data-[\w-]+|content|value|placeholder|type|rel|all)\s*$/i;

/** 取字符串结果（详情/名称等字段） */
export async function evalRule(rule: string | undefined, ctx: RuleCtx): Promise<string> {
  const list = await evalRuleInternal(rule, ctx, false);
  const first = list[0];
  return first === undefined || first === null ? '' : String(first);
}

/** 取列表结果（bookList / chapterList / content 多段） */
export async function evalRuleList(rule: string | undefined, ctx: RuleCtx): Promise<unknown[]> {
  return evalRuleInternal(rule, ctx, true);
}

async function evalRuleInternal(rule: string | undefined, ctx: RuleCtx, asList: boolean): Promise<unknown[]> {
  ctx.signal?.throwIfAborted();
  if (!rule || !rule.trim()) return [];
  // JS 内的 ||、&&、## 属于代码；只拆分脚本之前的提取规则。
  const script = rule.match(/<js>([\s\S]*?)<\/js>/i);
  const jsAt = script ? script.index! : rule.search(/@js:/i);
  if (jsAt >= 0) {
    const prefix = rule.slice(0, jsAt).trim();
    const code = script ? script[1] : rule.slice(jsAt + 4);
    const suffix = script ? rule.slice(jsAt + script[0].length).trim() : '';
    const input = prefix ? await evalRuleInternal(prefix, ctx, false) : null;
    const next = input ? { ...ctx, text: stringify(input[0] ?? '') } : ctx;
    let output = normOut(await runJs(code, next), asList);
    if (suffix.startsWith('##')) {
      const parts = suffix.slice(2).split('##');
      output = output.map(v => applyReplace(stringify(v), { regex: parts[0], by: parts[1] ?? '' }));
    } else if (suffix) throw new Error('暂不支持此 JS 后续规则');
    return output;
  }
  let r = stripPutGet(rule.trim());

  // OnlyOne：直接对当前响应原文执行一次规则，例如 ##正则##替换###。
  if (r.startsWith('##')) {
    const core = r.endsWith('###') ? r.slice(2, -3) : r.slice(2);
    const divider = core.indexOf('##');
    const regex = divider >= 0 ? core.slice(0, divider) : core;
    const by = divider >= 0 ? core.slice(divider + 2) : '';
    const input = ctx.raw ?? ctx.text ?? ctx.element?.outerHTML ?? '';
    return [applyReplaceOnce(input, { regex, by })];
  }
  // 末尾替换规则：selector##regex##replacement（<js> 整段规则不拆）
  let replace: { regex: string; by: string } | null = null;
  if (!r.startsWith('<js>') && r.includes('##')) {
    const parts = r.split('##');
    r = parts[0];
    if (parts.length >= 2 && parts[1]) {
      replace = { regex: parts.slice(1, -1).join('##') || parts[1], by: parts.length >= 3 ? parts[parts.length - 1] : '' };
      if (parts.length === 2) replace = { regex: parts[1], by: '' };
    }
  }

  // || 依次尝试
  const alternatives = splitTop(r, '||');
  for (const alt of alternatives) {
    try {
      // %% 按列表下标交错合并。
      const interleaved = splitTop(alt, '%%');
      if (interleaved.length > 1) {
        const lists = await Promise.all(interleaved.map((part) => evalRuleInternal(part, ctx, true)));
        const merged: unknown[] = [];
        const length = Math.max(0, ...lists.map((list) => list.length));
        for (let i = 0; i < length; i++) {
          for (const list of lists) if (i < list.length) merged.push(list[i]);
        }
        return replace
          ? merged.map((value) => applyReplace(value instanceof Element ? htmlToText(value.innerHTML) : stringify(value), replace!))
          : merged;
      }
      // && 拼接
      const segments = splitTop(alt, '&&');
      const segResults: string[] = [];
      let rawList: unknown[] = [];
      for (const seg of segments) {
        const out = await evalSegment(seg.trim(), ctx, asList && segments.length === 1);
        if (asList && segments.length === 1) {
          rawList = out;
        } else {
          segResults.push(out.map(stringify).join(''));
        }
      }
      if (asList && segments.length === 1) {
        if (rawList.length > 0) return replace
          ? rawList.map((v) => applyReplace(v instanceof Element ? htmlToText(v.innerHTML) : stringify(v), replace!))
          : rawList;
        // 空列表 → 继续尝试下一个 ||
        continue;
      }
      const joined = segResults.join('\n');
      if (joined.trim()) {
        return [replace ? applyReplace(joined, replace) : joined];
      }
    } catch {
      ctx.signal?.throwIfAborted();
      // 本方案失败，尝试下一个 ||
    }
  }
  return [];
}

/** 单段规则求值；asList=true 时保留数组结构 */
async function evalSegment(seg: string, ctx: RuleCtx, asList: boolean): Promise<unknown[]> {
  if (!seg) return [];
  const capture = seg.trim().match(/^\$(\d+)$/);
  if (capture && ctx.captures) return [ctx.captures[Number(capture[1])] ?? ''];
  // URL 模板中的 JSONPath 占位符：/api/xxx?book_id={$.book_id}
  if (ctx.json !== undefined && /\{\{?\$/.test(seg)) {
    seg = seg.replace(/\{\{(\$[^{}]+)\}\}|\{(\$[^{}]+)\}/g, (_, double, single) => {
      const v = jsonQuery(ctx.json as any, double ?? single);
      return v !== undefined && v !== null ? String(v) : '';
    });
    // 展开后作为纯字符串返回
    return asList ? [seg] : [seg];
  }

  // 整段 JS
  if (seg.startsWith('<js>')) {
    const code = seg.replace(/^<js>/i, '').replace(/<\/js>$/i, '');
    const r = await runJs(code, ctx);
    return normOut(r, asList);
  }

  let mode = 'css';
  let body = seg;
  const m = seg.match(MODE_RE);
  if (m) {
    mode = m[1].toLowerCase();
    body = seg.slice(m[0].length).trim();
  } else if (seg.startsWith('@@')) {
    mode = 'css';
    body = seg.slice(2).trim();
  } else if (seg.startsWith('@JS:') || seg.startsWith('@js:')) {
    mode = 'js';
    body = seg.slice(4).trim();
  } else if (/^-?:/.test(body)) {
    mode = 'allinone';
  } else if (/^(?:\/\/|\.\/\/)/.test(body)) {
    mode = 'xpath';
  } else if (ctx.json !== undefined && /^\$/.test(body)) {
    mode = 'json';
  }

  switch (mode) {
    case 'js': {
      const r = await runJs(body, ctx);
      return normOut(r, asList);
    }
    case 'json': {
      if (ctx.json === undefined) return [];
      return asList ? jsonQueryList(ctx.json, body) : [scalar(jsonQuery(ctx.json, body))];
    }
    case 'xpath':
      return xpathEval(body, ctx, asList);
    case 'allinone':
      return regexListEval(body, ctx, asList);
    case 'regex': {
      const text = ctx.text ?? elementText(ctx.element) ?? '';
      const re = new RegExp(body, 'gs');
      const all = [...text.matchAll(re)].map((x) => x[1] ?? x[0]);
      return asList ? all : [all.join('\n')];
    }
    default:
      return cssEval(body, ctx, asList);
  }
}

function cssEval(selector: string, ctx: RuleCtx, asList: boolean): unknown[] {
  const root: (Document & ParentNode) | (Element & ParentNode) | null = ctx.element ?? ctx.doc ?? null;
  if (!root) return [];

  let sel = selector.trim();
  let attr = '';
  const attrMatch = sel.match(ATTR_RE);
  if (attrMatch && !sel.endsWith(']')) {
    attr = attrMatch[1];
    sel = sel.slice(0, attrMatch.index).trim();
  }

  const parts = sel.split('@');
  const base = parts.shift()?.trim() ?? '';
  let els = base ? selectCssStep([root], base, !!ctx.element) : ctx.element ? [ctx.element] : [];
  for (const step of parts.map((item) => item.trim()).filter(Boolean)) {
    els = selectCssStep(els, step, false);
  }

  if (asList && !attr) return els;
  return els.map((el) => extractAttr(el, attr, ctx.baseUrl));
}

type CssRoot = (Document & ParentNode) | (Element & ParentNode);

function selectCssStep(roots: CssRoot[], rawStep: string, includeSelf: boolean): Element[] {
  let step = rawStep.trim();
  let reverse = false;
  if (step.startsWith('-') && !/^-(?:\d|:)/.test(step)) {
    reverse = true;
    step = step.slice(1).trim();
  }

  const childIndex = step.match(/^(?:children)?\.(-?\d+)$/i);
  if (childIndex) {
    const children = roots.flatMap((root) => Array.from(root.children ?? []));
    const selected = pickIndex(children, Number(childIndex[1]));
    return reverse ? selected.reverse() : selected;
  }
  if (/^children(?:\[[^\]]+\])?$/i.test(step)) {
    const modifier = step.slice('children'.length);
    const children = roots.flatMap((root) => Array.from(root.children ?? []));
    const selected = applyPositionModifier(children, modifier);
    return reverse ? selected.reverse() : selected;
  }

  let selector = step;
  let modifier = '';
  let containsText = '';
  const legacy = step.match(/^(class|id|tag|text)\.([^.!\[]+)(.*)$/i);
  if (legacy) {
    const kind = legacy[1].toLowerCase();
    const name = legacy[2];
    modifier = legacy[3] || '';
    selector = kind === 'class' ? `.${name}` : kind === 'id' ? `#${name}` : kind === 'tag' ? name : '*';
    if (kind === 'text') containsText = name;
  } else {
    const trailing = step.match(/^(.*?)(![-\d:,]+|\[(?:!?[-\d:,\s]+)\])$/);
    if (trailing && trailing[1]) {
      selector = trailing[1];
      modifier = trailing[2];
    }
  }

  let selected: Element[] = [];
  for (const root of roots) {
    selected.push(...querySelectorAllCompat(root, selector));
    if (includeSelf && root instanceof Element && !/:\s*(?:eq|lt|gt|first|last)\b/i.test(selector)) {
      try { if (root.matches(selector)) selected.unshift(root); } catch { /* invalid selector */ }
    }
  }
  selected = uniqueElements(selected);
  if (containsText) selected = selected.filter((el) => (el.textContent || '').includes(containsText));
  selected = applyPositionModifier(selected, modifier);
  return reverse ? selected.reverse() : selected;
}

function querySelectorAllCompat(root: CssRoot, selector: string): Element[] {
  const out: Element[] = [];
  for (const group of splitCssGroups(selector)) {
    out.push(...queryCssGroup(root, group));
  }
  return uniqueElements(out);
}

function queryCssGroup(root: CssRoot, input: string): Element[] {
  let group = input.trim().replace(/:first(?![-\w(])/gi, ':eq(0)').replace(/:last(?![-\w(])/gi, ':eq(-1)');
  const positional = group.match(/:(eq|lt|gt)\(\s*(-?\d+)\s*\)/i);
  if (!positional || positional.index === undefined) {
    try { return Array.from(root.querySelectorAll(group)); } catch { return []; }
  }

  const before = group.slice(0, positional.index).trim() || '*';
  const after = group.slice(positional.index + positional[0].length).trim();
  let candidates: Element[];
  try { candidates = Array.from(root.querySelectorAll(before)); } catch { return []; }
  const rawIndex = Number(positional[2]);
  const index = rawIndex < 0 ? candidates.length + rawIndex : rawIndex;
  let chosen: Element[];
  switch (positional[1].toLowerCase()) {
    case 'lt': chosen = candidates.slice(0, Math.max(0, index)); break;
    case 'gt': chosen = candidates.slice(Math.min(candidates.length, index + 1)); break;
    default: chosen = candidates[index] ? [candidates[index]] : [];
  }
  if (!after) return chosen;
  return chosen.flatMap((element) => {
    const descendant = /^[>+~]/.test(after) ? `:scope ${after}` : after;
    try { return Array.from(element.querySelectorAll(descendant)); } catch { return []; }
  });
}

function splitCssGroups(selector: string): string[] {
  const groups: string[] = [];
  let current = '';
  let depth = 0;
  let quote = '';
  for (let i = 0; i < selector.length; i++) {
    const char = selector[i];
    if (quote) {
      current += char;
      if (char === quote && selector[i - 1] !== '\\') quote = '';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    if (char === '[' || char === '(') depth++;
    if (char === ']' || char === ')') depth--;
    if (char === ',' && depth === 0) {
      if (current.trim()) groups.push(current.trim());
      current = '';
    } else current += char;
  }
  if (current.trim()) groups.push(current.trim());
  return groups;
}

function applyPositionModifier(items: Element[], modifier: string): Element[] {
  if (!modifier) return items;
  const single = modifier.match(/^\.(-?\d+)$/);
  if (single) return pickIndex(items, Number(single[1]));

  const bracket = modifier.match(/^\[([^\]]+)\]$/);
  if (bracket) {
    const spec = bracket[1].trim();
    if (spec === '-1:0') return [...items].reverse();
    if (spec.startsWith('!')) return excludePositions(items, spec.slice(1));
    return selectPositions(items, spec);
  }
  if (modifier.startsWith('!')) return excludePositions(items, modifier.slice(1));
  return items;
}

function pickIndex(items: Element[], raw: number): Element[] {
  const index = raw < 0 ? items.length + raw : raw;
  return items[index] ? [items[index]] : [];
}

function excludePositions(items: Element[], spec: string): Element[] {
  const excluded = new Set(spec.split(/[:,]/).filter(Boolean).map(Number).map((index) => index < 0 ? items.length + index : index));
  return items.filter((_, index) => !excluded.has(index));
}

function selectPositions(items: Element[], spec: string): Element[] {
  const out: Element[] = [];
  for (const part of spec.split(',').map((value) => value.trim()).filter(Boolean)) {
    if (!part.includes(':')) {
      out.push(...pickIndex(items, Number(part)));
      continue;
    }
    const values = part.split(':');
    let start = values[0] === '' ? 0 : Number(values[0]);
    let end = values[1] === '' ? items.length : Number(values[1]);
    let stride = values[2] === undefined || values[2] === '' ? (start <= end ? 1 : -1) : Number(values[2]);
    if (!stride) continue;
    if (start < 0) start += items.length;
    if (end < 0) end += items.length;
    if (stride > 0) for (let i = start; i < Math.min(end, items.length); i += stride) out.push(...pickIndex(items, i));
    else for (let i = start; i > Math.max(end, -1); i += stride) out.push(...pickIndex(items, i));
  }
  return uniqueElements(out);
}

function uniqueElements(items: Element[]): Element[] {
  return [...new Set(items)];
}

function regexListEval(expr: string, ctx: RuleCtx, asList: boolean): unknown[] {
  const reverse = expr.startsWith('-:');
  const pattern = expr.slice(reverse ? 2 : 1);
  const input = ctx.raw ?? ctx.text ?? ctx.element?.outerHTML ?? '';
  try {
    const regex = new RegExp(pattern, 'gs');
    const matches = [...input.matchAll(regex)].map((match) => ({
      __legadoRegex: true,
      text: match[0],
      captures: Array.from(match, (value) => value ?? ''),
    }));
    if (reverse) matches.reverse();
    if (asList) return matches;
    return matches.length ? [matches[0].text] : [];
  } catch {
    return [];
  }
}

function xpathEval(expr: string, ctx: RuleCtx, asList: boolean): unknown[] {
  const doc = ctx.doc ?? ctx.element?.ownerDocument;
  if (!doc) return [];
  try {
    const scoped = ctx.element && expr.startsWith('//') ? `.${expr}` : expr;
    const snap = doc.evaluate(scoped, ctx.element ?? doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const nodes: Node[] = [];
    for (let i = 0; i < snap.snapshotLength; i++) {
      const node = snap.snapshotItem(i);
      if (node) nodes.push(node);
    }
    if (asList) return nodes;
    return nodes.map((node) => {
      if (node.nodeType === Node.ATTRIBUTE_NODE) {
        const attr = node as Attr;
        return /^(href|src)$/i.test(attr.name) ? resolveMaybeUrl(attr.value, ctx.baseUrl) : attr.value.trim();
      }
      return (node.textContent || '').trim();
    });
  } catch {
    return [];
  }
}
/** 从元素上取值：text/ownText/html/href/src/任意属性 */
function extractAttr(el: Element, attr: string, baseUrl: string): string {
  switch (attr) {
    case '':
    case 'text':
      return (el.textContent || '').trim();
    case 'ownText': {
      let t = '';
      el.childNodes.forEach((n) => {
        if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
      });
      return t.trim();
    }
    case 'html':
      return el.innerHTML.trim();
    case 'outerHtml':
    case 'all':
      return el.outerHTML.trim();
    case 'textNodes':
      return htmlToText(el.innerHTML);
    default: {
      const v = el.getAttribute(attr) ?? '';
      if (/^(href|src)$/i.test(attr) || /^(https?:)?\/\//.test(v) || v.startsWith('/')) {
        return resolveMaybeUrl(v, baseUrl);
      }
      return v.trim();
    }
  }
}

function resolveMaybeUrl(v: string, baseUrl: string): string {
  if (!v) return v;
  if (/^(javascript|data|mailto):/i.test(v)) return v;
  return resolveUrl(v, baseUrl);
}

/** JS 规则执行环境 */
async function runJs(code: string, ctx: RuleCtx): Promise<unknown> {
  const result = ctx.text ?? ctx.element?.outerHTML ?? (ctx.json !== undefined ? JSON.stringify(ctx.json) : ctx.raw ?? '');
  const source = ctx.source ?? {};
  const host = (() => { try { return new URL(ctx.baseUrl).host; } catch { return ''; } })();
  const getServerHost = () => {
    try { const u = new URL(ctx.baseUrl); return `${u.protocol}//${u.host}`; } catch { return ctx.baseUrl; }
  };
  const _vars = new Map<string, string>();
  let inheritedHeaders: Record<string, string> = {};
  if (source.header && typeof source.header === 'object') {
    inheritedHeaders = Object.fromEntries(Object.entries(source.header as Record<string, unknown>).map(([key, value]) => [key, String(value)]));
  } else if (typeof source.header === 'string') {
    try {
      const parsed = JSON.parse(source.header);
      if (parsed && typeof parsed === 'object') inheritedHeaders = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
    } catch { /* invalid header is ignored */ }
  }
  const request = (rawUrl: string, method?: string, body?: string, headers: Record<string, string> = {}) => {
    const parsed = parseUrlWithOptions(String(rawUrl), { key: ctx.key, page: ctx.page });
    return fetchText(resolveUrl(parsed.url, ctx.baseUrl), {
      method: method ?? parsed.method,
      body: body ?? parsed.body,
      charset: parsed.charset,
      headers: { ...inheritedHeaders, Referer: ctx.baseUrl, ...parsed.headers, ...headers },
      signal: ctx.signal,
    });
  };
  const java = {
    ajax: (url: string) => request(url),
    get: (value: string, headers?: Record<string, string>) =>
      headers || !_vars.has(String(value))
        ? request(value, 'GET', undefined, headers)
        : _vars.get(String(value)) ?? '',
    post: (url: string, body: string, headers: Record<string, string> = {}) => request(url, 'POST', String(body ?? ''), headers),
    base64Decoder: (s: string) => atob(s),
    base64Decode: (s: string) => atob(s),
    base64Encode: (s: string) => btoa(String(s)),
    encodeURI: (s: string) => encodeURIComponent(String(s)),
    md5Encode: (s: string) => { throw new Error('java.md5Encode not implemented'); },
    longToast: (msg: string) => console.log('[java.longToast]', msg),
    toast: (msg: string) => console.log('[java.toast]', msg),
    put: (k: string, v: string) => { _vars.set(String(k), String(v)); },
  };
  const sourceProxy = new Proxy(source as Record<string, unknown>, {
    get(target, prop) {
      if (prop === 'getKey') return () => target.bookSourceUrl ?? '';
      if (prop === 'getVariable') return () => '[]';
      if (prop === 'setVariable') return () => {};
      if (prop === 'getLoginInfoMap') return () => ({});
      if (prop === 'bookSourceUrl') return target.bookSourceUrl ?? '';
      if (prop === 'bookSourceName') return target.bookSourceName ?? '';
      return target[String(prop)];
    }
  });
  const library = typeof source.jsLib === 'string' ? source.jsLib : '';
  const signature = JSON.stringify([library, code]);
  let fn = compiledScripts.get(signature);
  if (!fn) {
    const ast = parse(code, { allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
    const statements = ast.program.body.filter(s => s.type !== 'EmptyStatement');
    const last = statements[statements.length - 1];
    let body = code + '\nreturn result;';
    if (last?.type === 'ExpressionStatement') {
      body = code.slice(0, last.start!) + 'return (' + code.slice(last.expression.start!, last.expression.end!) + ');';
    }
    fn = new AsyncFunction(
    'result',
    'book',
    'source',
    'baseUrl',
    'key',
    'page',
    'java',
    'cookie',
    'getServerHost',
    'cache',
    library + '\n' + body,
  );
    if (compiledScripts.size >= 100) compiledScripts.delete(compiledScripts.keys().next().value!);
    compiledScripts.set(signature, fn);
  }
  const memory = ctx.memory ?? new Map<string, unknown>();
  const cache = {
    putMemory: (key: string, value: unknown) => { memory.set(String(key), value); },
    getFromMemory: (key: string) => memory.get(String(key)) ?? '',
  };
  return fn.call({ source: sourceProxy, cache },
    result,
    ctx.book ?? {},
    sourceProxy,
    ctx.baseUrl,
    ctx.key ?? '',
    ctx.page ?? 1,
    java,
    inheritedHeaders.Cookie ?? inheritedHeaders.cookie ?? '',
    getServerHost,
    cache,
  );
}

const compiledScripts = new Map<string, (...args: unknown[]) => Promise<unknown>>();

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...fnArgs: unknown[]) => Promise<unknown>;

/** 剔除 @put:{...} / @get:x 片段（跨规则传值，本实现不支持） */
function stripPutGet(rule: string): string {
  return rule
    .replace(/@put:\{[^}]*\}/g, '')
    .replace(/@get:\{[^}]*\}/g, '')
    .replace(/@get:[\w$]+/g, '');
}

/** 顶层分隔（忽略引号与括号内的分隔符） */
function splitTop(rule: string, sep: '||' | '&&' | '%%'): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (let i = 0; i < rule.length; i++) {
    const c = rule[i];
    if (quote) {
      cur += c;
      if (c === quote && rule[i - 1] !== '\\') quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
    if (depth === 0 && rule.startsWith(sep, i)) {
      out.push(cur);
      cur = '';
      i += sep.length - 1;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function applyReplace(text: string, replace: { regex: string; by: string }): string {
  try {
    return text.replace(new RegExp(replace.regex, 'g'), replace.by);
  } catch {
    return text;
  }
}
function applyReplaceOnce(text: string, replace: { regex: string; by: string }): string {
  try {
    return text.replace(new RegExp(replace.regex), replace.by);
  } catch {
    return text;
  }
}

function normOut(r: unknown, asList: boolean): unknown[] {
  if (r === undefined || r === null) return [];
  if (asList) return Array.isArray(r) ? r : [r];
  return [scalar(r)];
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function stringify(v: unknown): string {
  if (v instanceof Element) return (v.textContent || '').trim();
  return scalar(v);
}

function elementText(el?: Element): string {
  return el ? (el.textContent || '').trim() : '';
}

/** HTML 转纯文本：<br> 与块级元素换行、去标签、解码实体 */
export function htmlToText(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  div.querySelectorAll('script,style').forEach((n) => n.remove());
  div.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  div.querySelectorAll('p,div,li,tr,h1,h2,h3,h4,h5,blockquote,section,article').forEach((el) => {
    el.append('\n');
  });
  return (div.textContent || '')
    .split('\n')
    .map((s) => s.replace(/ /g, ' ').trim())
    .filter((s) => s)
    .join('\n');
}

/** 判断响应内容更像 JSON 还是 HTML，并给出解析结果 */
export function parseResponse(text: string): { doc?: Document; json?: unknown } {
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return { json: JSON.parse(t) };
    } catch {
      // JSONP 包裹：callback({...})
      const m = t.match(/^\w+\(([\s\S]*)\)\s*;?$/);
      if (m) {
        try {
          return { json: JSON.parse(m[1]) };
        } catch {
          /* fallthrough */
        }
      }
    }
  }
  return { doc: new DOMParser().parseFromString(text, 'text/html') };
}
