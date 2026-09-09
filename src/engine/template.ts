/**
 * 书源 URL 模板与 options 解析。
 * 搜索地址支持两种形式：
 *   1. "https://site.com/search?key={{key}}&page={{page}}"
 *   2. "https://site.com/search,{'method':'POST','body':'key={{key}}','headers':{...}}"
 * 即 URL 后逗号接一个 JS 对象字面量（阅读 3.0 的写法，单引号、可无引号 key）。
 */

export interface UrlWithOptions {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  charset?: string;
}

/** 展开 {{key}} / {{page}} / {{page-1}} 等模板变量 */
export function expandTemplate(tpl: string, vars: { key?: string; page?: number }): string {
  return tpl.replace(/\{\{(.*?)\}\}/g, (_, expr: string) => {
    const e = expr.trim();
    if (e === 'key') return encodeURIComponent(vars.key ?? '');
    if (e === 'page') return String(vars.page ?? 1);
    const m = e.match(/^page\s*([+-])\s*(\d+)$/);
    if (m) {
      const base = vars.page ?? 1;
      const n = parseInt(m[2], 10);
      return String(m[1] === '-' ? base - n : base + n);
    }
    return '';
  });
}

/** 拆分 "url,{options}" 形式；options 是 JS 对象字面量，用 Function 求值解析（兼容单引号） */
export function parseUrlWithOptions(raw: string, vars: { key?: string; page?: number }): UrlWithOptions {
  let url = raw.trim();
  let options: Record<string, any> = {};
  // 找到紧跟 URL 的 ,{ ... }
  const idx = url.indexOf(',{');
  if (idx > -1) {
    const optStr = url.slice(idx + 1).trim();
    url = url.slice(0, idx).trim();
    try {
      options = new Function(`return (${optStr})`)() || {};
    } catch {
      // options 解析失败则按纯 URL 处理
    }
  }
  const headers: Record<string, string> = {};
  if (options.headers && typeof options.headers === 'object') {
    for (const [k, v] of Object.entries(options.headers)) headers[k] = String(v);
  }
  const method = String(options.method || 'GET').toUpperCase();
  let body: string | undefined;
  if (options.body != null) {
    body = typeof options.body === 'string' ? expandTemplate(options.body, vars) : JSON.stringify(options.body);
    if (method === 'GET' && body) {
      url += (url.includes('?') ? '&' : '?') + body;
      body = undefined;
    } else if (body && !headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  }
  return {
    url: expandTemplate(url, vars),
    method,
    headers,
    body,
    charset: options.charset,
  };
}

/** 解析相对地址为绝对地址；失败时原样返回 */
export function resolveUrl(maybeRelative: string, base: string): string {
  const s = (maybeRelative || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  try {
    return new URL(s, base).href;
  } catch {
    return s;
  }
}
