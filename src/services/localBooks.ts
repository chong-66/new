import type { Book, Chapter } from '../types';
import type { ParsedTxt } from './txtParser';
import { TXT_PARSER_VERSION } from './txtParser';
import { isTauri } from '../utils/env';

const ROOT = 'local-books/v1';
const DB_NAME = 'toudu-local-books-v1';
const DB_STORE = 'entries';
const BROWSER_FALLBACK_LIMIT = 4 * 1024 * 1024;
const writes = new Set<Promise<unknown>>();

export interface LocalBookChapter { id: string; title: string; file: string }
export interface LocalBookManifest {
  version: 1;
  id: string;
  name: string;
  originalName: string;
  encoding: string;
  splitMethod: 'headings' | 'length';
  parserVersion: number;
  contentHash: string;
  importedAt: number;
  chapters: LocalBookChapter[];
}

function validId(value: string): boolean { return /^[0-9a-f-]{20,64}$/i.test(value); }
function chapterUrl(bookId: string, chapterId: string) { return 'local-txt://' + bookId + '/' + chapterId; }
function parseChapterUrl(url: string) {
  const match = /^local-txt:\/\/([0-9a-f-]{20,64})\/([0-9]{6})$/i.exec(url);
  if (!match) throw new Error('本地章节地址无效');
  return { bookId: match[1], chapterId: match[2] };
}
export async function hashLocalText(text: string): Promise<string> {
  const value = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(value), (b) => b.toString(16).padStart(2, '0')).join('');
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('浏览器本地书数据库打开失败'));
  });
}
async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openDb();
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const request = db.transaction(DB_STORE).objectStore(DB_STORE).get(key);
      request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
async function idbWriteBook(manifest: LocalBookManifest, contents: string[]) {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      const store = tx.objectStore(DB_STORE);
      contents.forEach((text, i) => store.put(text, 'chapter:' + manifest.id + ':' + manifest.chapters[i].id));
      store.put(manifest, 'manifest:' + manifest.id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('浏览器本地书保存失败'));
      tx.onabort = () => reject(tx.error ?? new Error('浏览器本地书保存已取消'));
    });
  } finally { db.close(); }
}
async function idbRemoveBook(id: string, manifest: LocalBookManifest | null) {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      const store = tx.objectStore(DB_STORE);
      manifest?.chapters.forEach((chapter) => store.delete('chapter:' + id + ':' + chapter.id));
      store.delete('manifest:' + id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}
function fallbackKey(kind: 'manifest' | 'chapter', id: string, chapterId = '') {
  return 'toudu:local-book:' + kind + ':' + id + (chapterId ? ':' + chapterId : '');
}

async function readManifest(id: string): Promise<LocalBookManifest | null> {
  if (!validId(id)) throw new Error('本地书标识无效');
  if (isTauri) {
    const file = ROOT + '/' + id + '/manifest.json';
    const { readTextFile, exists, BaseDirectory } = await import('@tauri-apps/plugin-fs');
    if (!(await exists(file, { baseDir: BaseDirectory.AppData }))) return null;
    return JSON.parse(await readTextFile(file, { baseDir: BaseDirectory.AppData })) as LocalBookManifest;
  }
  if (typeof indexedDB !== 'undefined') return idbGet<LocalBookManifest>('manifest:' + id);
  const raw = localStorage.getItem(fallbackKey('manifest', id));
  return raw ? JSON.parse(raw) as LocalBookManifest : null;
}
function validateManifest(value: LocalBookManifest | null, id: string): LocalBookManifest {
  if (!value || value.version !== 1 || value.id !== id || !Array.isArray(value.chapters) ||
      value.chapters.some((chapter) => !/^[0-9]{6}$/.test(chapter.id) || chapter.file !== 'chapters/' + chapter.id + '.txt')) {
    throw new Error('本地 TXT 目录损坏');
  }
  return value;
}

export async function getLocalManifest(id: string) {
  return validateManifest(await readManifest(id), id);
}
export async function loadLocalToc(book: Pick<Book, 'id'>): Promise<Chapter[]> {
  const manifest = await getLocalManifest(book.id);
  return manifest.chapters.map((chapter) => ({ title: chapter.title, url: chapterUrl(book.id, chapter.id) }));
}
export async function readLocalChapter(book: Pick<Book, 'id'>, url: string): Promise<string> {
  const parsed = parseChapterUrl(url);
  if (parsed.bookId !== book.id) throw new Error('本地章节不属于当前书籍');
  const manifest = await getLocalManifest(book.id);
  const chapter = manifest.chapters.find((item) => item.id === parsed.chapterId);
  if (!chapter) throw new Error('本地章节记录不存在');
  if (isTauri) {
    const { readTextFile, exists, BaseDirectory } = await import('@tauri-apps/plugin-fs');
    const file = ROOT + '/' + book.id + '/' + chapter.file;
    if (!(await exists(file, { baseDir: BaseDirectory.AppData }))) throw new Error('本地章节文件缺失');
    return readTextFile(file, { baseDir: BaseDirectory.AppData });
  }
  const text = typeof indexedDB !== 'undefined'
    ? await idbGet<string>('chapter:' + book.id + ':' + chapter.id)
    : localStorage.getItem(fallbackKey('chapter', book.id, chapter.id));
  if (typeof text !== 'string') throw new Error('本地章节文件缺失');
  return text;
}

export interface SaveLocalBookOptions {
  name: string;
  originalName: string;
  parsed: ParsedTxt;
  signal?: AbortSignal;
  onProgress?: (saved: number, total: number) => void;
}

async function saveImpl(options: SaveLocalBookOptions): Promise<{ book: Book; chapters: Chapter[] }> {
  const id = crypto.randomUUID();
  const hash = await hashLocalText(options.parsed.text);
  options.signal?.throwIfAborted();
  const importedAt = Date.now();
  const manifest: LocalBookManifest = {
    version: 1, id, name: options.name.trim() || options.originalName.replace(/\.txt$/i, ''),
    originalName: options.originalName, encoding: options.parsed.encoding,
    splitMethod: options.parsed.splitMethod, parserVersion: TXT_PARSER_VERSION,
    contentHash: hash, importedAt,
    chapters: options.parsed.sections.map((section, i) => {
      const chapterId = String(i + 1).padStart(6, '0');
      return { id: chapterId, title: section.title, file: 'chapters/' + chapterId + '.txt' };
    }),
  };
  const contents = options.parsed.sections.map((section) => options.parsed.text.slice(section.start, section.end));
  if (isTauri) {
    const { mkdir, writeTextFile, rename, remove, exists, BaseDirectory } = await import('@tauri-apps/plugin-fs');
    const baseDir = BaseDirectory.AppData;
    const stage = ROOT + '/.tmp-' + id;
    const target = ROOT + '/' + id;
    await mkdir(stage + '/chapters', { baseDir, recursive: true });
    try {
      for (let i = 0; i < contents.length; i++) {
        options.signal?.throwIfAborted();
        await writeTextFile(stage + '/' + manifest.chapters[i].file, contents[i], { baseDir });
        options.onProgress?.(i + 1, contents.length);
      }
      options.signal?.throwIfAborted();
      await writeTextFile(stage + '/manifest.json', JSON.stringify(manifest), { baseDir });
      if (await exists(target, { baseDir })) throw new Error('本地书目录已经存在');
      await rename(stage, target, { oldPathBaseDir: baseDir, newPathBaseDir: baseDir });
    } catch (error) {
      if (await exists(stage, { baseDir })) await remove(stage, { baseDir, recursive: true }).catch(() => {});
      throw error;
    }
  } else if (typeof indexedDB !== 'undefined') {
    options.signal?.throwIfAborted();
    await idbWriteBook(manifest, contents);
    options.onProgress?.(contents.length, contents.length);
  } else {
    const totalBytes = contents.reduce((n, text) => n + text.length * 2, 0);
    if (totalBytes > BROWSER_FALLBACK_LIMIT) throw new Error('当前浏览器不支持大文件存储，请使用桌面版');
    for (let i = 0; i < contents.length; i++) {
      options.signal?.throwIfAborted();
      localStorage.setItem(fallbackKey('chapter', id, manifest.chapters[i].id), contents[i]);
      options.onProgress?.(i + 1, contents.length);
    }
    localStorage.setItem(fallbackKey('manifest', id), JSON.stringify(manifest));
  }
  const chapters = manifest.chapters.map((chapter) => ({ title: chapter.title, url: chapterUrl(id, chapter.id) }));
  const book: Book = {
    id, name: manifest.name, author: '', coverUrl: '', intro: '从 ' + manifest.originalName + ' 导入',
    bookUrl: 'local-txt://' + id, tocUrl: 'local-txt://' + id + '/manifest',
    sourceUrl: 'local-txt', sourceName: '本地 TXT', kind: '本地',
    addedTime: importedAt, lastReadTime: 0, totalChapters: chapters.length,
    latestChapter: chapters[chapters.length - 1]?.title ?? '', unreadCount: Math.max(0, chapters.length - 1),
    origin: 'local-txt',
    localTxt: {
      version: 1, contentHash: hash, originalName: manifest.originalName,
      encoding: manifest.encoding, splitMethod: manifest.splitMethod,
      parserVersion: manifest.parserVersion, importedAt,
    },
    progress: { chapterIndex: 0, chapterUrl: chapters[0]?.url, chapterTitle: chapters[0]?.title, scrollRatio: 0 },
  };
  return { book, chapters };
}

export function saveLocalBook(options: SaveLocalBookOptions) {
  const task = saveImpl(options);
  writes.add(task);
  void task.finally(() => writes.delete(task)).catch(() => {});
  return task;
}
export async function removeLocalBook(id: string): Promise<void> {
  if (!validId(id)) throw new Error('本地书标识无效');
  await Promise.allSettled([...writes]);
  const manifest = await readManifest(id).catch(() => null);
  if (isTauri) {
    const { remove, exists, BaseDirectory } = await import('@tauri-apps/plugin-fs');
    const directory = ROOT + '/' + id;
    if (await exists(directory, { baseDir: BaseDirectory.AppData })) await remove(directory, { baseDir: BaseDirectory.AppData, recursive: true });
  } else if (typeof indexedDB !== 'undefined') await idbRemoveBook(id, manifest);
  else {
    manifest?.chapters.forEach((chapter) => localStorage.removeItem(fallbackKey('chapter', id, chapter.id)));
    localStorage.removeItem(fallbackKey('manifest', id));
  }
}
export async function waitForLocalBookWrites() {
  const results = await Promise.allSettled([...writes]);
  const failed = results.find((item): item is PromiseRejectedResult => item.status === 'rejected');
  if (failed) throw failed.reason;
}
export async function stopLocalBookTasks() {
  await waitForLocalBookWrites();
}
