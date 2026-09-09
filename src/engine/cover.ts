import { isTauri } from '../utils/env';
import { fetchBlob } from './http';

/**
 * 封面加载：通过 Rust 侧请求并携带 Referer 规避防盗链，
 * 转成 ObjectURL 供 <img> 使用；失败返回 null，组件显示占位图。
 */
const cache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

export function getCover(url: string | undefined, referer?: string): Promise<string | null> {
  if (!url || !isTauri) return Promise.resolve(url || null);
  if (cache.has(url)) return Promise.resolve(cache.get(url)!);
  if (pending.has(url)) return pending.get(url)!;
  const p = fetchBlob(url, referer)
    .then((blob) => {
      if (!blob.size) throw new Error('empty');
      const obj = URL.createObjectURL(blob);
      cache.set(url, obj);
      pending.delete(url);
      return obj;
    })
    .catch(() => {
      cache.set(url, null);
      pending.delete(url);
      return null;
    });
  pending.set(url, p);
  return p;
}
