import { isTauri } from '../utils/env';

/** 移动端 UA，与阅读 APP 默认行为一致，很多小说站对 PC UA 返回不同页面 */
export const DEFAULT_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** 书源 options 里显式指定的编码 */
  charset?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** 同时限制连接、响应体读取及调用方的异步规则执行时间。 */
export async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
  timeoutMs = 20000,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason ?? new DOMException('已取消', 'AbortError'));
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('请求超时，请重试或换源')), timeoutMs);
  let rejectAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    if (controller.signal.aborted) rejectAbort();
    else controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return run(controller.signal);
    }), cancelled]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}

/** 规范化编码标签：TextDecoder 支持 gbk/gb18030，gb2312 映射到 gb18030 解码器 */
function normalizeCharset(label: string): string | null {
  const l = label.trim().toLowerCase().replace(/['"]/g, '');
  if (!l) return null;
  if (l === 'gb2312' || l === 'gbk' || l === 'gb18030') return 'gb18030';
  if (l === 'utf8' || l === 'utf-8') return 'utf-8';
  try {
    new TextDecoder(l);
    return l;
  } catch {
    return null;
  }
}

/** 从响应头与 HTML meta 中嗅探编码（大量小说站是 GBK 且无 header 声明） */
function sniffCharset(headerValue: string | null, buf: ArrayBuffer): string {
  const fromHeader = headerValue?.match(/charset=([\w-]+)/i)?.[1];
  const enc = fromHeader && normalizeCharset(fromHeader);
  if (enc) return enc;
  const head = new TextDecoder('latin1').decode(buf.slice(0, 2048));
  const fromMeta =
    head.match(/<meta[^>]+charset=["']?\s*([\w-]+)/i)?.[1] ||
    head.match(/encoding=["']([\w-]+)["']/i)?.[1];
  return (fromMeta && normalizeCharset(fromMeta)) || 'utf-8';
}

/** 请求网页并智能解码为文本（自动识别 GBK/UTF-8/Big5） */
export async function fetchText(url: string, opt: FetchOptions = {}): Promise<string> {
  const { buf, contentType } = await fetchBytes(url, opt);
  const charset = opt.charset
    ? normalizeCharset(opt.charset) || 'utf-8'
    : sniffCharset(contentType, buf);
  return new TextDecoder(charset).decode(buf);
}

async function fetchBytes(url: string, opt: FetchOptions) {
  if (!/^https?:\/\//i.test(url)) throw new Error('无效的网页地址');
  return withTimeout(async (signal) => {
    signal.throwIfAborted();
    const method = (opt.method || 'GET').toUpperCase();
    const requestInit = {
      method,
      headers: { 'User-Agent': DEFAULT_UA, ...opt.headers },
      body: opt.body,
      signal,
    };
    const nativeFetch = isTauri ? (await import('@tauri-apps/plugin-http')).fetch : undefined;
    let resp = nativeFetch
      ? await nativeFetch(url, requestInit)
      : await window.fetch(url, requestInit);

    // 部分书站会短时拒绝代理出口或限制连续请求。只重试无副作用的读取请求。
    if ((resp.status === 403 || resp.status === 429) && (method === 'GET' || method === 'HEAD')) {
      const firstStatus = resp.status;
      if (resp.body) await resp.body.cancel().catch(() => {});
      await abortableDelay(retryDelay(resp.headers.get('retry-after'), firstStatus), signal);
      try {
        if (nativeFetch && firstStatus === 403) {
          const host = new URL(url).hostname;
          resp = await nativeFetch(url, {
            ...requestInit,
            connectTimeout: 5000,
            // 添加显式代理会关闭 reqwest 的自动系统代理；目标域名在 noProxy 中直连。
            proxy: { all: { url: 'http://127.0.0.1:9', noProxy: host } },
          });
        } else {
          resp = nativeFetch
            ? await nativeFetch(url, requestInit)
            : await window.fetch(url, requestInit);
        }
      } catch {
        throw new Error(`服务器返回 HTTP ${firstStatus}（自动重试失败）`);
      }
    }
    if (!resp.ok) throw new Error(`服务器返回 HTTP ${resp.status}（重试后仍被拒绝）`);
    const buf = await resp.arrayBuffer();
    signal.throwIfAborted();
    return { buf, contentType: resp.headers.get('content-type') };
  }, opt.signal, opt.timeoutMs);
}

function retryDelay(value: string | null, status: number): number {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(3000, Math.max(300, seconds * 1000));
  return status === 429 ? 1200 : 600;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

/** 抓取二进制（封面图），返回 Blob；带 Referer 防盗链 */
export async function fetchBlob(url: string, referer?: string): Promise<Blob> {
  const headers: Record<string, string> = { 'User-Agent': DEFAULT_UA };
  if (referer) headers['Referer'] = referer;
  const { buf, contentType } = await fetchBytes(url, { headers });
  const mime = contentType?.split(';')[0] || 'image/jpeg';
  return new Blob([buf], { type: mime });
}
