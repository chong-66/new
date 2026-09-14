import { defineStore } from 'pinia';
import { isLocalBook, type Book, type Chapter, type SearchResult } from '../types';
import { readJson, writeJson, writeJsonDebounced } from '../services/storage';
import { clearBookChapterCache } from '../services/chapterCache';
import { stopAllChapterCacheTasks } from '../services/chapterCacheTask';
import { loadLocalToc, removeLocalBook } from '../services/localBooks';

const tocFile = (id: string) => `toc_${id}.json`;
type TocData = { sourceUrl: string; bookUrl: string; chapters: Chapter[] };
const tocData = (book: Pick<Book, 'sourceUrl' | 'bookUrl'>, chapters: Chapter[]): TocData => ({ sourceUrl: book.sourceUrl, bookUrl: book.bookUrl, chapters });

export const useLibraryStore = defineStore('library', {
  state: () => ({
    books: [] as Book[],
    /** 目录内存缓存 bookId -> chapters */
    tocCache: {} as Record<string, Chapter[]>,
    loaded: false,
  }),
  getters: {
    sorted(state): Book[] {
      return [...state.books].sort((a, b) => b.lastReadTime - a.lastReadTime);
    },
    byId(state) {
      return (id: string) => state.books.find((b) => b.id === id);
    },
  },
  actions: {
    async load() {
      this.books = await readJson<Book[]>('library.json', []);
      this.loaded = true;
      this.$subscribe((mut, state) => writeJsonDebounced('library.json', state.books));
    },
    save() {
      writeJsonDebounced('library.json', this.books, 0);
    },
    has(bookUrl: string, sourceUrl: string): boolean {
      return this.books.some((b) => b.bookUrl === bookUrl && b.sourceUrl === sourceUrl);
    },
    addFromSearch(r: SearchResult): Book {
      const existing = this.books.find((b) => b.bookUrl === r.bookUrl && b.sourceUrl === r.source.bookSourceUrl);
      if (existing) return existing;
      const book: Book = {
        id: crypto.randomUUID(),
        name: r.name,
        author: r.author,
        coverUrl: r.coverUrl,
        intro: r.intro,
        kind: r.kind,
        bookUrl: r.bookUrl,
        sourceUrl: r.source.bookSourceUrl,
        sourceName: r.source.bookSourceName,
        latestChapter: '',
        unreadCount: 0,
        totalChapters: 0,
        tocUrl: '',
        progress: { chapterIndex: 0 },
        lastReadTime: 0,
        addedTime: Date.now(),
      };
      this.books.push(book);
      this.save();
      return book;
    },
    async addLocalBook(book: Book, chapters: Chapter[]) {
      if (!isLocalBook(book)) throw new Error('不是本地 TXT 书籍');
      if (this.byId(book.id)) return this.byId(book.id)!;
      this.books.push(book);
      this.tocCache[book.id] = chapters;
      try {
        await writeJson('library.json', this.books);
      } catch (error) {
        this.books = this.books.filter((item) => item.id !== book.id);
        delete this.tocCache[book.id];
        await writeJson('library.json', this.books).catch(() => {});
        throw error;
      }
      return book;
    },
    async remove(id: string) {
      const book = this.byId(id);
      if (!book) return;
      await stopAllChapterCacheTasks();
      if (!isLocalBook(book)) await clearBookChapterCache({ id });
      const previousBooks = this.books;
      const previousToc = this.tocCache[id];
      this.books = this.books.filter((b) => b.id !== id);
      delete this.tocCache[id];
      try {
        await writeJson('library.json', this.books);
      } catch (error) {
        this.books = previousBooks;
        if (previousToc) this.tocCache[id] = previousToc;
        await writeJson('library.json', this.books).catch(() => {});
        throw error;
      }
      if (isLocalBook(book)) {
        try {
          await removeLocalBook(id);
        } catch (error) {
          this.books = previousBooks;
          if (previousToc) this.tocCache[id] = previousToc;
          await writeJson('library.json', this.books).catch(() => {});
          throw error;
        }
      }
      const { remove: fsRemove, exists } = await import('@tauri-apps/plugin-fs').catch(() => ({}) as any);
      // 浏览器模式下无 fs，静默失败即可
      try {
        const { BaseDirectory } = await import('@tauri-apps/api/path');
        if (await exists(tocFile(id), { baseDir: BaseDirectory.AppData })) {
          await fsRemove(tocFile(id), { baseDir: BaseDirectory.AppData });
        }
      } catch {
        /* ignore */
      }
    },
    async getToc(book: Book): Promise<Chapter[] | null> {
      if (this.tocCache[book.id]) return this.tocCache[book.id];
      if (isLocalBook(book)) {
        const chapters = await loadLocalToc(book);
        this.tocCache[book.id] = chapters;
        return chapters;
      }
      const disk = await readJson<Chapter[] | TocData | null>(tocFile(book.id), null);
      const chapters = Array.isArray(disk) ? disk : disk?.sourceUrl === book.sourceUrl && disk.bookUrl === book.bookUrl ? disk.chapters : null;
      if (Array.isArray(chapters)) { this.tocCache[book.id] = chapters; return chapters; }
      return null;
    },
    async setToc(book: Book, chapters: Chapter[]) {
      this.tocCache[book.id] = chapters;
      book.totalChapters = chapters.length;
      book.latestChapter = chapters[chapters.length - 1]?.title ?? '';
      this.refreshUnread(book);
      this.save();
      await this.persistToc(book, chapters).catch(() => {});
    },
    async persistToc(book: Book, chapters: Chapter[]) {
      await writeJson(tocFile(book.id), tocData(book, chapters));
    },
    refreshUnread(book: Book) {
      const read = book.progress.chapterIndex;
      book.unreadCount = Math.max(0, book.totalChapters - read - 1);
    },
    updateProgress(book: Book, chapterIndex: number, chapter?: Chapter, scrollRatio = 0) {
      book.progress = { chapterIndex, chapterUrl: chapter?.url, chapterTitle: chapter?.title, scrollRatio };
      book.lastReadTime = Date.now();
      this.refreshUnread(book);
      this.save();
    },
    updatePosition(book: Book, scrollRatio: number) {
      book.progress.scrollRatio = Math.min(1, Math.max(0, scrollRatio));
    },
    /** 新目录准备好后一次提交；保留书籍身份与入架时间。 */
    async changeSource(book: Book, result: SearchResult, tocUrl: string, chapters: Chapter[], chapterIndex: number) {
      if (!this.byId(book.id) || !chapters[chapterIndex]) throw new Error('书籍或章节已失效');
      const replacement: Book = { ...book,
        sourceUrl: result.source.bookSourceUrl, sourceName: result.source.bookSourceName,
        bookUrl: result.bookUrl, tocUrl, coverUrl: result.coverUrl || book.coverUrl,
        intro: result.intro || book.intro,
        totalChapters: chapters.length, latestChapter: chapters[chapters.length - 1]?.title ?? '',
        progress: { chapterIndex, chapterUrl: chapters[chapterIndex].url, chapterTitle: chapters[chapterIndex].title, scrollRatio: 0 },
        lastReadTime: Date.now(), unreadCount: Math.max(0, chapters.length - chapterIndex - 1),
      };
      await writeJson(tocFile(book.id), tocData(replacement, chapters));
      if (!this.byId(book.id)) throw new Error('书籍已被移除');
      Object.assign(book, replacement);
      this.tocCache[book.id] = chapters;
      this.save();
    },
    updateMeta(book: Book, patch: Partial<Book>) {
      Object.assign(book, patch);
      this.save();
    },
    /** 导出备份（书架 + 设置 + 书源由调用方组装） */
    exportData(): Book[] {
      return this.books;
    },
    async importBooks(books: Book[]) {
      const keys = new Set(this.books.map((b) => `${b.sourceUrl}|${b.bookUrl}`));
      for (const b of books) {
        if (!b.id || keys.has(`${b.sourceUrl}|${b.bookUrl}`)) continue;
        keys.add(`${b.sourceUrl}|${b.bookUrl}`);
        this.books.push(b);
      }
      this.save();
    },
    async clear() {
      await stopAllChapterCacheTasks();
      const previousBooks = this.books;
      this.books = [];
      this.tocCache = {};
      try {
        await writeJson('library.json', this.books);
      } catch (error) {
        this.books = previousBooks;
        await writeJson('library.json', this.books).catch(() => {});
        throw error;
      }
      await Promise.all(previousBooks.map((book) => isLocalBook(book) ? removeLocalBook(book.id) : clearBookChapterCache(book)));
    },
  },
});
