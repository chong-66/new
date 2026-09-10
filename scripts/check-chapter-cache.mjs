import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const dom = new JSDOM('', { url: 'https://cache-test.invalid/' });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'Node', 'DOMParser', 'XPathResult', 'localStorage']) {
  globalThis[key] = dom.window[key];
}
const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
const load = (path) => server.ssrLoadModule(`/src/${path}`);
const engine = await load('engine/source.ts');
const cache = await load('services/chapterCache.ts');
const { startChapterCacheTask } = await load('services/chapterCacheTask.ts');

const source = {
  bookSourceName: 'cache-test', bookSourceUrl: 'https://cache.invalid',
  ruleContent: { content: '#body' },
};
const book = {
  id: crypto.randomUUID(), name: 'Test', author: '', coverUrl: '', intro: '',
  bookUrl: 'https://cache.invalid/book', tocUrl: '', sourceUrl: source.bookSourceUrl,
  sourceName: source.bookSourceName, kind: '', addedTime: 0, lastReadTime: 0,
  totalChapters: 40, latestChapter: '', unreadCount: 0,
  progress: { chapterIndex: 11, chapterUrl: 'https://cache.invalid/12', scrollRatio: 0.4 },
};
const chapters = Array.from({ length: 40 }, (_, i) => ({ title: `C${i + 1}`, url: `https://cache.invalid/${i + 1}` }));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); }
  assert.fail('Timed out');
}

try {
  await test('more than the memory LRU remains readable offline and cache is source isolated', async () => {
    for (let i = 0; i < 35; i++) await cache.writeCachedChapter(book, source, chapters[i], `saved ${i + 1}`);
    window.fetch = async () => { throw new Error('offline'); };
    assert.equal(await engine.getContent(source, chapters[0].url, book), 'saved 1');
    assert.equal(await engine.getContent(source, chapters[34].url, book), 'saved 35');
    const otherSource = { ...source, bookSourceUrl: 'https://other.invalid' };
    await assert.rejects(engine.getContent(otherSource, chapters[0].url, book), /offline/);
  });

  await test('selected range skips existing chapters without changing reading progress', async () => {
    const before = { ...book.progress };
    let requests = 0;
    window.fetch = async () => { requests++; return new Response('<div id="body">downloaded</div>'); };
    const task = startChapterCacheTask({
      book, source, chapters, start: 34, count: 10, delayMs: 0, persistToc: async () => {},
    });
    const result = await task.done;
    assert.equal(result.total, 6);
    assert.equal(result.skipped, 1);
    assert.equal(result.saved, 5);
    assert.equal(requests, 5);
    assert.deepEqual(book.progress, before);
  });

  await test('stop aborts the active request and does not start a later chapter', async () => {
    const cancelBook = { ...book, id: crypto.randomUUID(), bookUrl: book.bookUrl + '/cancel' };
    let requests = 0;
    let activeSignal;
    window.fetch = (_url, options) => {
      requests++;
      if (requests === 1) return Promise.resolve(new Response('<div id="body">first</div>'));
      activeSignal = options.signal;
      return new Promise(() => {});
    };
    const task = startChapterCacheTask({
      book: cancelBook, source, chapters: chapters.slice(0, 3), start: 0, count: 3,
      delayMs: 0, persistToc: async () => {},
    });
    await until(() => requests === 2);
    task.cancel();
    const result = await task.done;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.saved, 1);
    assert.equal(result.failed, 0);
    assert.equal(requests, 2);
    assert.equal(activeSignal.aborted, true);
    assert.equal(await cache.readCachedChapter(cancelBook, source, chapters[0].url), 'first');
    await cache.clearBookChapterCache(cancelBook);
  });
} finally {
  await cache.clearBookChapterCache(book);
  await server.close();
  dom.window.close();
}
