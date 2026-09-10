import type { Book, BookSource, Chapter } from '../types';
import { isTauri } from '../utils/env';

const ROOT = 'chapter-cache/v1';
const BROWSER_PREFIX = 'toudu:chapter-cache:v1:';

interface ChapterCacheRecord {
  version: 1;
  sourceUrl: string;
  bookUrl: string;
  chapterUrl: string;
  title: string;
  content: string;
  savedAt: number;
}

const queues = new Map<string, Promise<void>>();
const writes = new Set<Promise<void>>();
const encoder = new TextEncoder();

async function digest(parts: unknown[]): Promise<string> {
  const value = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(parts)));
  return Array.from(new Uint8Array(value), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function paths(book: Pick<Book, 'id' | 'bookUrl' | 'sourceUrl'>, source: BookSource, chapterUrl?: string) {
  const bookKey = await digest([book.id]);
  const sourceKey = await digest([source.bookSourceUrl, book.bookUrl]);
  const directory = `${ROOT}/${bookKey}/${sourceKey}`;
  const chapterKey = chapterUrl ? await digest([chapterUrl]) : '';
  return {
    bookDirectory: `${ROOT}/${bookKey}`,
    directory,
    file: chapterKey ? `${directory}/${chapterKey}.json` : '',
    browserPrefix: `${BROWSER_PREFIX}${bookKey}:${sourceKey}:`,
    browserKey: chapterKey ? `${BROWSER_PREFIX}${bookKey}:${sourceKey}:${chapterKey}` : '',
    chapterKey,
  };
}

function validRecord(value: unknown, book: Pick<Book, 'bookUrl'>, source: BookSource, chapterUrl: string): value is ChapterCacheRecord {
  const item = value as Partial<ChapterCacheRecord> | null;
  return !!item && item.version === 1 && item.sourceUrl === source.bookSourceUrl &&
    item.bookUrl === book.bookUrl && item.chapterUrl === chapterUrl &&
    typeof item.content === 'string' && !!item.content.trim();
}

async function removeFile(file: string) {
  if (!isTauri) { localStorage.removeItem(file); return; }
  const { remove, exists, BaseDirectory } = await import('@tauri-apps/plugin-fs');
  if (await exists(file, { baseDir: BaseDirectory.AppData })) {
    await remove(file, { baseDir: BaseDirectory.AppData });
  }
}

function enqueue(key: string, action: () => Promise<void>): Promise<void> {
  const task = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
  queues.set(key, task);
  writes.add(task);
  task.finally(() => {
    writes.delete(task);
    if (queues.get(key) === task) queues.delete(key);
  }).catch(() => {});
  return task;
}

export async function readCachedChapter(
  book: Pick<Book, 'id' | 'bookUrl' | 'sourceUrl'>,
  source: BookSource,
  chapterUrl: string,
): Promise<string | null> {
  const p = await paths(book, source, chapterUrl);
  await queues.get(isTauri ? p.file : p.browserKey)?.catch(() => {});
  try {
    let raw: string | null;
    if (!isTauri) raw = localStorage.getItem(p.browserKey);
    else {
      const { readTextFile, exists, BaseDirectory } = await import('@tauri-apps/plugin-fs');
      if (!(await exists(p.file, { baseDir: BaseDirectory.AppData }))) return null;
      raw = await readTextFile(p.file, { baseDir: BaseDirectory.AppData });
    }
    if (raw === null) return null;
    const record = JSON.parse(raw) as unknown;
    if (validRecord(record, book, source, chapterUrl)) return record.content;
  } catch { /* 损坏的缓存按未命中处理 */ }
  await removeFile(isTauri ? p.file : p.browserKey).catch(() => {});
  return null;
}

export async function writeCachedChapter(
  book: Pick<Book, 'id' | 'bookUrl' | 'sourceUrl'>,
  source: BookSource,
  chapter: Chapter,
  content: string,
): Promise<void> {
  const clean = content.trim();
  if (!clean) throw new Error('不能缓存空正文');
  const p = await paths(book, source, chapter.url);
  const key = isTauri ? p.file : p.browserKey;
  const record: ChapterCacheRecord = {
    version: 1, sourceUrl: source.bookSourceUrl, bookUrl: book.bookUrl,
    chapterUrl: chapter.url, title: chapter.title, content: clean, savedAt: Date.now(),
  };
  return enqueue(key, async () => {
    const text = JSON.stringify(record);
    if (!isTauri) { localStorage.setItem(p.browserKey, text); return; }
    const { mkdir, writeTextFile, rename, remove, exists, BaseDirectory } = await import('@tauri-apps/plugin-fs');
    const baseDir = BaseDirectory.AppData;
    await mkdir(p.directory, { baseDir, recursive: true });
    const temp = `${p.file}.tmp`;
    const old = `${p.file}.old`;
    await writeTextFile(temp, text, { baseDir });
    const hadOld = await exists(p.file, { baseDir });
    try {
      if (await exists(old, { baseDir })) await remove(old, { baseDir });
      if (hadOld) await rename(p.file, old, { oldPathBaseDir: baseDir, newPathBaseDir: baseDir });
      await rename(temp, p.file, { oldPathBaseDir: baseDir, newPathBaseDir: baseDir });
      if (hadOld && await exists(old, { baseDir })) await remove(old, { baseDir });
    } catch (error) {
      if (!(await exists(p.file, { baseDir })) && await exists(old, { baseDir })) {
        await rename(old, p.file, { oldPathBaseDir: baseDir, newPathBaseDir: baseDir }).catch(() => {});
      }
      throw error;
    } finally {
      if (await exists(temp, { baseDir })) await remove(temp, { baseDir }).catch(() => {});
    }
  });
}

export async function cachedChapterUrls(
  book: Pick<Book, 'id' | 'bookUrl' | 'sourceUrl'>,
  source: BookSource,
  chapters: Chapter[],
): Promise<Set<string>> {
  const base = await paths(book, source);
  let names = new Set<string>();
  if (!isTauri) {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(base.browserPrefix)) names.add(key.slice(base.browserPrefix.length));
    }
  } else {
    const { readDir, exists, BaseDirectory } = await import('@tauri-apps/plugin-fs');
    if (!(await exists(base.directory, { baseDir: BaseDirectory.AppData }))) return new Set();
    const entries = await readDir(base.directory, { baseDir: BaseDirectory.AppData });
    names = new Set(entries.filter((e) => !e.isDirectory && e.name.endsWith('.json')).map((e) => e.name.slice(0, -5)));
  }
  const result = new Set<string>();
  await Promise.all(chapters.map(async (chapter) => {
    const chapterKey = await digest([chapter.url]);
    if (names.has(chapterKey)) result.add(chapter.url);
  }));
  return result;
}

export async function clearBookChapterCache(book: Pick<Book, 'id'>): Promise<void> {
  await waitForChapterCacheWrites();
  const bookKey = await digest([book.id]);
  if (!isTauri) {
    const prefix = `${BROWSER_PREFIX}${bookKey}:`;
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    keys.forEach((key) => localStorage.removeItem(key));
    return;
  }
  const directory = `${ROOT}/${bookKey}`;
  const { remove, exists, BaseDirectory } = await import('@tauri-apps/plugin-fs');
  if (await exists(directory, { baseDir: BaseDirectory.AppData })) {
    await remove(directory, { baseDir: BaseDirectory.AppData, recursive: true });
  }
}

export async function waitForChapterCacheWrites(): Promise<void> {
  const results = await Promise.allSettled([...writes]);
  const failed = results.find((item): item is PromiseRejectedResult => item.status === 'rejected');
  if (failed) throw failed.reason;
}
