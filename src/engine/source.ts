import type { Book, BookSource, Chapter, SearchResult } from '../types';
import { fetchText, withTimeout } from './http';
import { expandTemplate, parseUrlWithOptions, resolveUrl } from './template';
import { evalRule, evalRuleList, htmlToText, parseResponse, type RuleCtx } from './rule';

/** 书源级请求头（书源 JSON 里 header 字段可能是字符串） */
function sourceHeaders(source: BookSource): Record<string, string> {
  if (!source.header) return {};
  if (typeof source.header === 'object') return source.header;
  try {
    return JSON.parse(source.header);
  } catch {
    try {
      return new Function(`return (${source.header})`)() || {};
    } catch {
      return {};
    }
  }
}

const scriptMemories = new Map<string, Map<string, unknown>>();
function baseCtx(source: BookSource, baseUrl: string, bookUrl = baseUrl): RuleCtx {
  const key = JSON.stringify([source.bookSourceUrl, source.jsLib, bookUrl]);
  let memory = scriptMemories.get(key);
  if (!memory) {
    if (scriptMemories.size >= 100) scriptMemories.delete(scriptMemories.keys().next().value!);
    memory = new Map();
    scriptMemories.set(key, memory);
  }
  return {
    baseUrl,
    source: { ...source },
    memory,
  };
}

/** 书源是否可用（第一版仅文本类型、且要有搜索规则） */
export function isTextSource(source: BookSource): boolean {
  return !source.bookSourceType || source.bookSourceType === 0;
}

// ---------------------------------------------------------------- 搜索

export function searchSource(source: BookSource, key: string, signal?: AbortSignal): Promise<SearchResult[]> {
  return withTimeout((scoped) => searchSourceImpl(source, key, scoped), signal, 25000);
}

async function searchSourceImpl(source: BookSource, key: string, signal: AbortSignal): Promise<SearchResult[]> {
  if (!source.searchUrl || !source.ruleSearch?.bookList) {
    throw new Error('书源缺少搜索规则');
  }

  // Step 1: 解析搜索 URL — 可能是 JS 代码、模板字符串、相对路径
  let rawUrl = source.searchUrl;
  const isJS = rawUrl.startsWith('<js>') || rawUrl.startsWith('<JS>') || /^@[Jj][Ss]:/.test(rawUrl);

  if (isJS) {
    const jsCtx: RuleCtx = {
      signal,
      baseUrl: source.bookSourceUrl,
      source: { ...source },
      key,
      page: 1,
    };
    rawUrl = await evalRule(rawUrl, jsCtx);
    if (!rawUrl) throw new Error('JS 返回空');
  }

  // Step 2: 先展开模板 {{key}}/{{page}}，再处理相对路径
  const expanded = expandTemplate(rawUrl, { key, page: 1 });

  // Step 3: 拆分 ",{options}" 后缀（阅读3.0 格式），只对纯 URL 做相对路径解析
  let urlPart = expanded;
  let optSuffix = '';
  const optIdx = expanded.indexOf(',{');
  if (optIdx > -1) {
    urlPart = expanded.slice(0, optIdx);
    optSuffix = expanded.slice(optIdx);
  }

  // Step 4: 相对路径 → 绝对 URL
  if (urlPart && !/^https?:\/\//i.test(urlPart) && !urlPart.startsWith('<js>') && !urlPart.startsWith('@')) {
    const resolved = resolveUrl(urlPart, source.bookSourceUrl);
    if (resolved !== urlPart) {
      urlPart = resolved;
    }
  }

  const finalUrl = urlPart + optSuffix;
  const req = parseUrlWithOptions(finalUrl, { key, page: 1 });
  const headers = { ...sourceHeaders(source), ...req.headers };
  const html = await fetchText(req.url, { method: req.method, headers, body: req.body, charset: req.charset, signal });
  const parsed = parseResponse(html);
  const ctx: RuleCtx = { ...baseCtx(source, req.url), ...parsed, key, page: 1, signal };

  const items = await evalRuleList(source.ruleSearch.bookList, ctx);
  const out: SearchResult[] = [];
  for (const item of items) {
    const itemCtx = childCtx(ctx, item);
    const r = source.ruleSearch;
    const [name, author, coverUrl, intro, bookUrl, kind] = await Promise.all([
      evalRule(r.name, itemCtx),
      evalRule(r.author, itemCtx),
      evalRule(r.coverUrl, itemCtx),
      evalRule(r.intro, itemCtx),
      evalRule(r.bookUrl, itemCtx),
      evalRule(r.kind, itemCtx),
    ]);
    if (!name.trim()) continue;

    // bookUrl fallback: 规则未提取到时，尝试从元素或 JSON 对象获取
    let finalBookUrl = bookUrl.trim();
    if (!finalBookUrl) {
      if (item instanceof Element) {
        const a = item.tagName === 'A' ? item : item.querySelector('a');
        if (a) finalBookUrl = a.getAttribute('href') ?? '';
      } else if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        // 尝试常见书链接字段（阅读3.0 JSON 源常用命名）
        finalBookUrl = String(
          obj.bookUrl ?? obj.url ?? obj.book_url ?? obj.link ?? obj.href ??
          obj.novelUrl ?? obj.detailUrl ?? obj.novel_url ?? obj.detail_url ??
          obj.bookid ?? obj.bookId ?? obj.BookId ?? obj._id ?? obj.id ?? obj.novelId ?? ''
        );
        // 如果拿到了纯数字 ID，尝试用源站 URL 拼接
        if (!finalBookUrl && (obj.bookid || obj.bookId || obj.id || obj._id)) {
          const id = String(obj.bookid ?? obj.bookId ?? obj.id ?? obj._id ?? '');
          if (id && /^\d+$/.test(id)) {
            finalBookUrl = resolveUrl(`/book/${id}`, source.bookSourceUrl);
          }
        }
        // JSON 对象无已知 URL 字段 → bookUrl 保持为空
      }
    }

    if (!finalBookUrl) continue;
    out.push({
      name: name.trim(),
      author: author.trim(),
      coverUrl: resolveUrl(coverUrl.trim(), req.url),
      intro: intro.trim(),
      bookUrl: resolveUrl(finalBookUrl, req.url),
      kind: kind.trim(),
      source,
    });
  }
  return out;
}

/** 多源并发搜索；单源失败不影响其他源。onResult 每源完成时立即回调，适合增量显示 */
export async function searchAll(
  sources: BookSource[],
  key: string,
  onResult?: (fresh: SearchResult[], all: SearchResult[], done: number, total: number) => void,
  sourceFilter?: string,  // 指定书源 bookSourceUrl，为空则搜全部
  signal?: AbortSignal,
): Promise<{ results: SearchResult[]; failed: string[] }> {
  let enabled = sources.filter((s) => s.enabled !== false && isTextSource(s) && s.searchUrl);
  if (sourceFilter) enabled = enabled.filter((s) => s.bookSourceUrl === sourceFilter);
  const results: SearchResult[] = [];
  const failed: string[] = [];
  let done = 0;
  const CONCURRENCY = 4;
  const queue = [...enabled];
  onResult?.([], [], 0, enabled.length);
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length && !signal?.aborted) {
        const s = queue.shift()!;
        try {
          const fresh = await searchSource(s, key, signal);
          signal?.throwIfAborted();
          results.push(...fresh);
        } catch (e) {
          if (!signal?.aborted) failed.push(`${s.bookSourceName}：${e instanceof Error ? e.message : '请求失败'}`);
        } finally {
          done++;
          if (!signal?.aborted) onResult?.([], dedupeResults(results), done, enabled.length);
        }
      }
    }),
  );
  signal?.throwIfAborted();
  // 去重：按书名（标准化）+ 作者合并同书异源结果
  const deduped = dedupeResults(results);

  return { results: deduped, failed };
}

/** 书名标准化：去空格、转小写、去括号内差异 */
function normName(s: string): string {
  return s.replace(/\s+/g, '').replace(/[（(][^)）]*[)）]/g, '').toLowerCase();
}

export function searchResultKey(r: SearchResult): string {
  return `${normName(r.name)}|${r.author.trim().toLowerCase()}`;
}

export function dedupeResults(list: SearchResult[]): SearchResult[] {
  const map = new Map<string, SearchResult>();
  for (const r of list) {
    const key = searchResultKey(r);
    const exist = map.get(key);
    if (!exist) {
      map.set(key, { ...r, alternatives: [{ ...r, alternatives: undefined }] });
    } else if (!exist.alternatives!.some((v) => v.bookUrl === r.bookUrl && v.source.bookSourceUrl === r.source.bookSourceUrl)) {
      exist.alternatives!.push({ ...r, alternatives: undefined });
    }
  }
  return [...map.values()];
}

// ---------------------------------------------------------------- 详情

export interface BookInfo {
  name?: string;
  author?: string;
  intro?: string;
  coverUrl?: string;
  tocUrl?: string;
}

export function getBookInfo(source: BookSource, bookUrl: string, book?: Book, signal?: AbortSignal): Promise<BookInfo> {
  return withTimeout((scoped) => getBookInfoImpl(source, bookUrl, book, scoped), signal);
}

async function getBookInfoImpl(source: BookSource, bookUrl: string, book: Book | undefined, signal: AbortSignal): Promise<BookInfo> {
  const r = source.ruleBookInfo;
  if (!r) return {};
  const html = await fetchText(bookUrl, { headers: sourceHeaders(source), signal });
  const parsed = parseResponse(html);
  const ctx: RuleCtx = { ...baseCtx(source, bookUrl), ...parsed, book: book as any, signal };
  if (r.init) {
    const initialized = await evalRule(r.init, ctx);
    if (initialized) Object.assign(ctx, { doc: undefined, json: undefined }, parseResponse(initialized));
  }
  const [name, author, intro, coverUrl, tocUrl] = await Promise.all([
    evalRule(r.name, ctx),
    evalRule(r.author, ctx),
    evalRule(r.intro, ctx),
    evalRule(r.coverUrl, ctx),
    evalRule(r.tocUrl, ctx),
  ]);
  return {
    name: name.trim() || undefined,
    author: author.trim() || undefined,
    intro: intro.trim() || undefined,
    coverUrl: coverUrl.trim() ? resolveUrl(coverUrl.trim(), bookUrl) : undefined,
    tocUrl: tocUrl.trim() ? resolveUrl(tocUrl.trim(), bookUrl) : undefined,
  };
}

// ---------------------------------------------------------------- 目录

export function getToc(source: BookSource, book: Pick<Book, 'name' | 'bookUrl' | 'tocUrl'>, signal?: AbortSignal): Promise<Chapter[]> {
  return withTimeout((scoped) => getTocImpl(source, book, scoped), signal, 90000);
}

async function getTocImpl(source: BookSource, book: Pick<Book, 'name' | 'bookUrl' | 'tocUrl'>, signal: AbortSignal): Promise<Chapter[]> {
  const r = source.ruleToc;
  if (!r?.chapterList) return [];
  const chapters: Chapter[] = [];
  const seen = new Set<string>();
  const chapterUrls = new Set<string>();
  let url: string = book.tocUrl || book.bookUrl;
  let guard = 0;

  while (url && guard < 20) {
    guard++;
    if (seen.has(url)) break;
    seen.add(url);
    const html = await fetchText(url, { headers: sourceHeaders(source), signal });
    const parsed = parseResponse(html);
    const ctx: RuleCtx = { ...baseCtx(source, url, book.bookUrl), ...parsed, book: book as any, page: guard, signal };

    let items = await evalRuleList(r.chapterList, ctx);

    // 回退：规则没匹配到，且页面是 HTML，尝试自动提取所有 <a> 链接
    if (!items.length && parsed.doc) {
      const all = Array.from(parsed.doc.querySelectorAll('a[href]'));
      // 过滤：至少要有文字内容，且 href 不是 javascript: 或 #
      const candidates = all.filter((a) => {
        const t = (a.textContent || '').trim();
        const h = (a.getAttribute('href') || '').trim();
        return t.length >= 2 && h && !h.startsWith('javascript:') && h !== '#';
      });
      if (candidates.length) items = candidates;
    }

    for (const item of items) {
      const itemCtx = childCtx(ctx, item);
      const [title, href] = await Promise.all([
        evalRule(r.chapterName, itemCtx),
        evalRule(r.chapterUrl, itemCtx),
      ]);
      const t = title.trim();
      const chapterUrl = resolveUrl(href.trim(), url);
      if (!t || !/^https?:\/\//i.test(chapterUrl) || chapterUrls.has(chapterUrl)) continue;
      chapterUrls.add(chapterUrl);
      chapters.push({ title: t, url: chapterUrl });
    }

    const next = r.nextTocUrl ? (await evalRule(r.nextTocUrl, ctx)).trim() : '';
    url = next ? resolveUrl(next, url) : '';
  }
  return chapters;
}

// ---------------------------------------------------------------- 正文

const contentCache = new Map<string, string>();

export interface ContentOptions { signal?: AbortSignal; force?: boolean }

export function getContent(source: BookSource, chapterUrl: string, book?: Book, options: ContentOptions = {}): Promise<string> {
  return withTimeout((signal) => getContentImpl(source, chapterUrl, book, { ...options, signal }), options.signal, 60000);
}

async function getContentImpl(source: BookSource, chapterUrl: string, book: Book | undefined, options: ContentOptions): Promise<string> {
  const cacheKey = JSON.stringify([source.bookSourceUrl, chapterUrl, source.ruleContent, source.header, source.jsLib]);
  if (options.force) contentCache.delete(cacheKey);
  const cached = contentCache.get(cacheKey);
  if (cached !== undefined) {
    // LRU：重新放到末尾
    contentCache.delete(cacheKey);
    contentCache.set(cacheKey, cached);
    return cached;
  }
  const r = source.ruleContent;
  if (!r?.content) return '';

  const parts: string[] = [];
  const seen = new Set<string>();
  let url: string = chapterUrl;
  let guard = 0;

  while (url && guard < 10) {
    guard++;
    if (seen.has(url)) break;
    seen.add(url);
    const html = await fetchText(url, { headers: sourceHeaders(source), signal: options.signal });
    const parsed = parseResponse(html);
    const ctx: RuleCtx = { ...baseCtx(source, url, book?.bookUrl), ...parsed, book: book as any, page: guard, signal: options.signal };

    let text = '';
    if (parsed.json !== undefined) {
      text = await evalRule(r.content, ctx);
      // JSON 返回内容若含 HTML 标签，转纯文本
      if (/<[a-z][\s\S]*?>/i.test(text)) text = htmlToText(text);
    } else {
      const nodes = await evalRuleList(r.content, ctx);
      if (nodes.length && nodes[0] instanceof Element) {
        text = (nodes as Element[]).map((el) => htmlToText(el.innerHTML)).join('\n');
      } else {
        text = nodes.map((n) => String(n ?? '')).join('\n');
      }
    }
    if (!text.trim()) throw new Error('正文为空，书源规则可能失效，请重试或换源');
    parts.push(text.trim());

    const next = r.nextContentUrl ? (await evalRule(r.nextContentUrl, ctx)).trim() : '';
    url = next ? resolveUrl(next, url) : '';
  }

  let content = parts.filter(Boolean).join('\n');
  // 净化规则：replaceRegex 可能是 URL 编码的正则
  if (r.replaceRegex) {
    let pattern = r.replaceRegex;
    try {
      pattern = decodeURIComponent(pattern);
    } catch {
      /* 非编码则原样 */
    }
    try {
      content = content.replace(new RegExp(pattern, 'g'), '');
    } catch {
      /* 非法正则忽略 */
    }
  }
  content = content
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n');

  options.signal?.throwIfAborted();
  if (!content) throw new Error('正文为空，请重试或换源');
  if (!contentCache.has(cacheKey) && contentCache.size >= 30) {
    contentCache.delete(contentCache.keys().next().value!);
  }
  contentCache.set(cacheKey, content);
  return content;
}

// ---------------------------------------------------------------- 工具

/** 列表项子规则的上下文：元素 -> element，JSON 对象 -> json */
function childCtx(parent: RuleCtx, item: unknown): RuleCtx {
  const ctx: RuleCtx = { ...parent, element: undefined, json: undefined, text: undefined };
  if (item instanceof Element) {
    ctx.element = item;
    ctx.doc = item.ownerDocument;
  } else if (item !== null && typeof item === 'object') {
    ctx.json = item;
  } else {
    ctx.text = String(item ?? '');
  }
  return ctx;
}
