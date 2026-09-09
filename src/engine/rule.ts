import { jsonQuery, jsonQueryList } from './jsonpath';
import { resolveUrl } from './template';
import { fetchText } from './http';
import { parse } from '@babel/parser';

/**
 * 阅读 3.0 规则解析器（子集）。
 * 支持：
 *   - CSS 选择器（默认）：`div.list li`、`tag.a@href`、`@text`/`@ownText`/`@html`
 *   - `@XPath:` XPath 表达式（浏览器原生 document.evaluate）
 *   - `@JSon:` JSONPath 子集
 *   - `<js>...</js>` / `@JS:` JS 代码（async 环境，可用 java.ajax()）
 *   - `规则1||规则2` 依次尝试取第一个非空结果
 *   - `规则1&&规则2` 结果拼接
 *   - `规则##正则##替换` 结果替换（替换可省略表示删除）
 * 已知限制：@put/@get 跨规则传值会被忽略（直接剔除）。
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
  /** 书籍信息（JS 规则可用） */
  book?: Record<string, unknown>;
  /** 书源信息（JS 规则可用） */
  source?: Record<string, unknown>;
  key?: string;
  page?: number;
}

const MODE_RE = /^@(XPath|JSon|JSON|JS|Css|CSS|Regex):/i;
/** 规则末尾的取值属性（仅匹配已知属性名，避免把 @a/@li/@dd 等标签名当成属性） */
const ATTR_RE = /@(text|ownText|html|outerHtml|textNodes|href|src|src\d?|alt|title|class|id|style|data-[\w-]+|content|value|placeholder|type|rel)\s*$/i;

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
  } else if (seg.startsWith('@JS:') || seg.startsWith('@js:')) {
    mode = 'js';
    body = seg.slice(4).trim();
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
  const root: (Document & ParentNode) | (Element & ParentNode) | null =
    ctx.element ?? ctx.doc ?? null;
  if (!root) return [];

  let sel = selector;

  // 阅读 3.0 CSS 简写转标准 CSS（用于基础选择器）
  sel = sel.replace(/(^|\s)class\.([\w-]+)/g, '$1.$2');
  sel = sel.replace(/(^|\s)id\.([\w-]+)/g, '$1#$2');
  sel = sel.replace(/(^|\s)tag\.([\w-]+)/g, '$1$2');

  // 先拆分末尾取值属性（@text/@href/...），它不属于管道链
  let attr = '';
  const attrMatch = sel.match(ATTR_RE);
  if (attrMatch && !sel.endsWith(']')) {
    attr = attrMatch[1];
    sel = sel.slice(0, attrMatch.index).trim();
  }

  // 管道链拆分：baseSel @ step1 @ step2 ...
  // 如 "ul@li!-1@a" → base="ul", chain=["li!-1", "a"]
  // 如 "div.list dd@tag.a" → base="div.list dd", chain=["tag.a"]
  const parts = sel.split('@');
  let baseSel = parts[0].trim();
  const chain = parts.slice(1).map((s) => s.trim()).filter(Boolean);

  // ---- 1. 执行基础 CSS 选择器 ----
  let els: Element[];
  if (!baseSel || baseSel === ':root' || baseSel === '.') {
    els = ctx.element ? [ctx.element] : [];
  } else {
    try {
      els = Array.from(root.querySelectorAll(baseSel));
      if (ctx.element && ctx.element.matches(baseSel)) els.unshift(ctx.element);
    } catch {
      els = [];
    }
  }

  // ---- 2. 顺序执行管道链 ----
  for (const rawStep of chain) {
    if (!els.length) break;
    let step = rawStep;

    // 先提取选择器（tag名/.class/#id/[attr]），如果 step 不以 ! 开头
    let sel = '';
    if (!step.startsWith('!')) {
      if (step.startsWith('tag.')) {
        // tag.tagname → 按标签名取子元素
        const tm = step.match(/^tag\.([\w-]+)/);
        if (tm) { sel = tm[1]; step = step.slice(tm[0].length); }
      } else if (/^[.#\[]/.test(step)) {
        // .class / #id / [attr] → CSS 选择器，取子元素
        const m = step.match(/^([.#\[]([\w-]+|\w+="[^"]*"|[\w-]+='[^']*'|[\w-]+=[\w-]+)\])/);
        if (m) { sel = m[1]; step = step.slice(m[0].length); }
      } else {
        // 裸标签名
        const tm = step.match(/^([\w-]+)/);
        if (tm) { sel = tm[1]; step = step.slice(tm[0].length); }
      }
    }

    // 应用 tag/selector 转换：把每个元素替换为其子元素
    if (sel) {
      if (sel === 'tag') {
        els = els.map((el) => el.firstElementChild).filter((el): el is Element => el !== null);
      } else {
        els = els.flatMap((el) => Array.from(el.querySelectorAll(sel)));
      }
    }

    // 索引器：.N 取第 N 个（0-based），.-N 取倒数第 N 个
    const im = step.match(/^\.(-?\d+)/);
    if (im) {
      let idx = parseInt(im[1], 10);
      if (idx < 0) idx = els.length + idx;
      const el = els[idx];
      els = el ? [el] : [];
      step = step.slice(im[0].length);
    }

    // 再应用过滤器：!N 跳过前 N 个，!-N 跳过后 N 个
    const fm = step.match(/^!(-?\d+)/);
    if (fm) {
      const n = parseInt(fm[1], 10);
      els = n < 0 ? els.slice(0, els.length + n) : els.slice(n);
    }
  }

  // ---- 3. 输出 ----
  if (asList && !attr) return els;
  return els.map((el) => extractAttr(el, attr, ctx.baseUrl));
}

function xpathEval(expr: string, ctx: RuleCtx, asList: boolean): unknown[] {
  const doc = ctx.doc ?? ctx.element?.ownerDocument;
  if (!doc) return [];
  try {
    const snap = doc.evaluate(
      expr,
      ctx.element ?? doc,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    const nodes: Node[] = [];
    for (let i = 0; i < snap.snapshotLength; i++) {
      const n = snap.snapshotItem(i);
      if (n) nodes.push(n);
    }
    if (asList) return nodes;
    return nodes.map((n) => {
      if (n.nodeType === Node.ATTRIBUTE_NODE) return resolveMaybeUrl((n as Attr).value, ctx.baseUrl);
      return (n.textContent || '').trim();
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
  const result = ctx.text ?? ctx.element?.outerHTML ?? (ctx.json !== undefined ? JSON.stringify(ctx.json) : '');
  const source = ctx.source ?? {};
  const host = (() => { try { return new URL(ctx.baseUrl).host; } catch { return ''; } })();
  const getServerHost = () => {
    try { const u = new URL(ctx.baseUrl); return `${u.protocol}//${u.host}`; } catch { return ctx.baseUrl; }
  };
  const _vars = new Map<string, string>();
  const java = {
    ajax: (url: string) => fetchText(resolveUrl(url, ctx.baseUrl), { headers: { Referer: ctx.baseUrl }, signal: ctx.signal }),
    base64Decoder: (s: string) => atob(s),
    base64Decode: (s: string) => atob(s),
    base64Encode: (s: string) => btoa(String(s)),
    encodeURI: (s: string) => encodeURIComponent(String(s)),
    md5Encode: (s: string) => { throw new Error('java.md5Encode not implemented'); },
    longToast: (msg: string) => console.log('[java.longToast]', msg),
    toast: (msg: string) => console.log('[java.toast]', msg),
    put: (k: string, v: string) => { _vars.set(String(k), String(v)); },
    get: (k: string) => _vars.get(String(k)) ?? '',
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
    '',
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
function splitTop(rule: string, sep: '||' | '&&'): string[] {
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
