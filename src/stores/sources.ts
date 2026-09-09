import { defineStore } from 'pinia';
import type { BookSource } from '../types';
import { readJson, writeJsonDebounced } from '../services/storage';
import { fetchText } from '../engine/http';

export interface ImportResult {
  added: number;
  skipped: number;
  unsupported: number;
  message: string;
}

/** 解析书源文本：JSON 数组 / 单个对象 / 逐行 JSON */
export function parseSourceText(text: string): BookSource[] {
  const items: unknown[] = [];
  const t = text.trim();
  try {
    const parsed = JSON.parse(t);
    if (Array.isArray(parsed)) items.push(...parsed);
    else items.push(parsed);
  } catch {
    for (const line of t.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      try {
        items.push(JSON.parse(l));
      } catch {
        /* 跳过坏行 */
      }
    }
  }
  return items.filter(
    (x): x is BookSource =>
      !!x && typeof x === 'object' && !!(x as BookSource).bookSourceName && !!(x as BookSource).bookSourceUrl,
  );
}

export const useSourcesStore = defineStore('sources', {
  state: () => ({ list: [] as BookSource[], loaded: false }),
  getters: {
    enabled(state): BookSource[] {
      return state.list.filter((s) => s.enabled !== false && (!s.bookSourceType || s.bookSourceType === 0));
    },
  },
  actions: {
    async load() {
      this.list = await readJson<BookSource[]>('sources.json', []);
      this.loaded = true;
      this.$subscribe((mut, state) => writeJsonDebounced('sources.json', state.list));
    },
    save() {
      writeJsonDebounced('sources.json', this.list, 0);
    },
    importText(text: string): ImportResult {
      const parsed = parseSourceText(text);
      return this.importList(parsed);
    },
    /** 导入已解析的书源列表（支持预览选择后批量导入） */
    importList(parsed: BookSource[]): ImportResult {
      let added = 0,
        skipped = 0,
        unsupported = 0;
      const existing = new Set(this.list.map((s) => s.bookSourceUrl));
      for (const s of parsed) {
        if (existing.has(s.bookSourceUrl)) {
          skipped++;
          continue;
        }
        // 第一版仅文本源；音频/图片源标记禁用
        if (s.bookSourceType && s.bookSourceType !== 0) {
          unsupported++;
          s.enabled = false;
          s.bookSourceName = `${s.bookSourceName}（暂不支持）`;
        }
        existing.add(s.bookSourceUrl);
        this.list.push(s);
        added++;
      }
      this.save();
      return {
        added,
        skipped,
        unsupported,
        message: parsed.length
          ? `导入 ${added} 个书源${skipped ? `，跳过重复 ${skipped}` : ''}${unsupported ? `，非文本源 ${unsupported} 已禁用` : ''}`
          : '未识别到有效书源',
      };
    },
    async importFromUrl(url: string): Promise<ImportResult> {
      const text = await fetchText(url.trim());
      return this.importText(text);
    },
    toggle(i: number) {
      const s = this.list[i];
      if (s) s.enabled = s.enabled === false;
      this.save();
    },
    remove(i: number) {
      this.list.splice(i, 1);
      this.save();
    },
    clear() {
      this.list = [];
      this.save();
    },
    findByUrl(url: string): BookSource | undefined {
      return this.list.find((s) => s.bookSourceUrl === url);
    },
  },
});
