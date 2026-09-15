import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const dom = new JSDOM('<div id="test-root"></div>', { url: 'https://test.invalid/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'DOMParser', 'XPathResult', 'localStorage']) {
  globalThis[key] = dom.window[key];
}
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
const { default: vuePlugin } = await import('@vitejs/plugin-vue');
const server = await createServer({ configFile: false, plugins: [vuePlugin()], server: { middlewareMode: true, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
const load = (path) => server.ssrLoadModule(`/src/${path}`);
const { createApp, nextTick, ssrContextKey } = await import('vue');
const { createPinia, setActivePinia } = await import('pinia');
const engine = await load('engine/source.ts');
const http = await load('engine/http.ts');
const rule = await load('engine/rule.ts');
const template = await load('engine/template.ts');
const storage = await load('services/storage.ts');
const chapterCache = await load('services/chapterCache.ts');
const { startChapterCacheTask } = await load('services/chapterCacheTask.ts');
const { useLibraryStore } = await load('stores/library.ts');
const { useSourcesStore } = await load('stores/sources.ts');
const { useUiStore } = await load('stores/ui.ts');
const localBooks = await load('services/localBooks.ts');
const txtParser = await load('services/txtParser.ts');
const { useSettingsStore } = await load('stores/settings.ts');
const { matchChapter } = await load('services/reading.ts');
const { THEMES, normalizeTheme, themeById } = await load('themes.ts');

const source = (name) => ({ bookSourceName: name, bookSourceUrl: `https://${name}.invalid`, searchUrl: '/search', ruleSearch: { bookList: '.book', name: 'a@text', author: '.author@text', bookUrl: 'a@href' }, ruleToc: { chapterList: 'a', chapterName: '@text', chapterUrl: '@href' }, ruleContent: { content: '#body' } });
const result = (s) => ({ name: 'Example', author: 'Author', bookUrl: `${s.bookSourceUrl}/book`, source: s, coverUrl: '', intro: '', kind: '' });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); }
  assert.fail('Timed out waiting for component state');
}
function freshStores() {
  const pinia = createPinia();
  setActivePinia(pinia);
  return { pinia, library: useLibraryStore(), sources: useSourcesStore(), ui: useUiStore() };
}
async function mount(path, pinia) {
  const component = (await load(path)).default;
  // Use the real SFC setup/lifecycle with a minimal render for deterministic state tests.
  const app = createApp({ ...component, render: () => null });
  app.use(pinia);
  app.provide(ssrContextKey, { modules: new Set() });
  const host = document.createElement('div'); document.body.append(host);
  const vm = app.mount(host);
  return { state: vm.$.setupState, unmount: () => { app.unmount(); host.remove(); } };
}

try {
  await test('native saved exit has destroy permission and uses direct destruction', async () => {
    const caps = JSON.parse(await readFile(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'));
    assert.ok(caps.permissions.includes('core:window:allow-destroy'));
    const tray = await readFile(new URL('../src/services/tray.ts', import.meta.url), 'utf8');
    assert.match(tray, /close: \(\) => win\.destroy\(\)/);
  });
  await test('tray close hides, explicit quit saves once before closing', async () => {
    const { createWindowCloseController } = await load('services/windowClose.ts');
    const calls = [];
    let resolveSave;
    const c = createWindowCloseController({
      trayOnly: () => true,
      hide: async () => { calls.push('hide'); },
      save: () => new Promise(resolve => { calls.push('save'); resolveSave = resolve; }),
      close: async () => { calls.push('close'); c.onCloseRequested({ preventDefault: () => calls.push('prevent-again') }); },
      failed: async () => { calls.push('failed'); },
    });
    await c.onCloseRequested({ preventDefault: () => calls.push('prevent') });
    assert.deepEqual(calls, ['prevent', 'hide']);
    const quitting = c.request(true);
    await c.request(true);
    assert.deepEqual(calls, ['prevent', 'hide', 'save']);
    resolveSave(); await quitting;
    assert.deepEqual(calls, ['prevent', 'hide', 'save', 'close']);
  });
  await test('failed save keeps window open and allows a later exit retry', async () => {
    const { createWindowCloseController } = await load('services/windowClose.ts');
    let fail = true, closes = 0, errors = 0;
    const c = createWindowCloseController({
      trayOnly: () => false, hide: async () => assert.fail('unexpected hide'),
      save: async () => { if (fail) throw new Error('disk full'); },
      close: async () => { closes++; }, failed: async () => { errors++; },
    });
    await c.request();
    assert.equal(closes, 0); assert.equal(errors, 1);
    fail = false; await c.request(); assert.equal(closes, 1);
  });
  await test('search incrementally groups duplicates while retaining selectable sources', async () => {
    window.fetch = async () => new Response('<div class="book"><a href="/book">Example</a><span class="author">Author</span></div>');
    let displayed = [];
    const r = await engine.searchAll([source('a'), source('b')], 'Example', (_, all) => { displayed = all; });
    assert.equal(displayed.length, 1);
    assert.equal(r.results.length, 1);
    assert.equal(displayed[0].alternatives.length, 2);
  });
  await test('cancelling a search aborts active requests and does not start queued sources', async () => {
    let started = 0;
    const signals = [];
    window.fetch = (_url, options) => { started++; signals.push(options.signal); return new Promise(() => {}); };
    const controller = new AbortController();
    const promise = engine.searchAll(Array.from({ length: 10 }, (_, i) => source(`cancel${i}`)), 'Example', undefined, undefined, controller.signal);
    await until(() => started === 4);
    controller.abort();
    await assert.rejects(promise, { name: 'AbortError' });
    assert.equal(started, 4);
    assert.ok(signals.every((s) => s.aborted));
  });
  await test('HTTP status errors, timeout and already aborted requests reject cleanly', async () => {
    window.fetch = async () => new Response('Unavailable', { status: 503 });
    await assert.rejects(http.fetchText('https://http.invalid/fail'), /503/);
    window.fetch = () => new Promise(() => {});
    await assert.rejects(http.fetchText('https://http.invalid/slow', { timeoutMs: 10 }), /超时/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(http.fetchText('https://http.invalid/abort', { signal: controller.signal }), { name: 'AbortError' });
  });
  await test('empty content is retried, successful cache is used, forced retry bypasses cache', async () => {
    let requests = 0;
    window.fetch = async () => { requests++; return new Response(requests === 1 ? '<div></div>' : `<div id="body">text ${requests}</div>`); };
    const s = source('retry');
    await assert.rejects(engine.getContent(s, `${s.bookSourceUrl}/chapter`), /正文为空/);
    assert.equal(await engine.getContent(s, `${s.bookSourceUrl}/chapter`), 'text 2');
    assert.equal(await engine.getContent(s, `${s.bookSourceUrl}/chapter`), 'text 2');
    assert.equal(requests, 2);
    assert.equal(await engine.getContent(s, `${s.bookSourceUrl}/chapter`, undefined, { force: true }), 'text 3');
  });
  await test('content replacement applies to list rules and cache respects rule changes', async () => {
    const ctx = { baseUrl: 'https://rules.invalid', doc: new DOMParser().parseFromString('<div id="body">hello AD world</div>', 'text/html') };
    assert.deepEqual(await rule.evalRuleList('#body@text##AD##', ctx), ['hello  world']);
    window.fetch = async () => new Response('<div id="body">old</div><div id="new">new</div>');
    const s = source('rulecache');
    assert.equal(await engine.getContent(s, `${s.bookSourceUrl}/chapter`), 'old');
    s.ruleContent.content = '#new';
    assert.equal(await engine.getContent(s, `${s.bookSourceUrl}/chapter`), 'new');
  });
  await test('Legado URL templates support encoded keys and page expressions', () => {
    assert.equal(
      template.expandTemplate('/search?q={{java.encodeURI(key)}}&start={{(page-1)*20}}', { key: '测试 a', page: 3 }),
      '/search?q=%E6%B5%8B%E8%AF%95%20a&start=40',
    );
    assert.equal(template.expandTemplate('/list/{{page==1?"":page}}', { page: 1 }), '/list/');
  });
  await test('Legado CSS positions, Default chains and list interleaving work', async () => {
    const doc = new DOMParser().parseFromString(`
      <div class="novel_info"><p><a>A</a></p><p><a>B</a></p><p><a>C</a></p></div>
      <div class="items"><a>one</a><a>two</a><a>three</a></div>
      <i class="left">L1</i><i class="left">L2</i><i class="right">R1</i><i class="right">R2</i>`, 'text/html');
    const ctx = { baseUrl: 'https://legado.invalid/book', doc, raw: doc.documentElement.outerHTML };
    assert.equal(await rule.evalRule('@css:.novel_info p:eq(1) a@text', ctx), 'B');
    assert.equal(await rule.evalRule('@css:.novel_info p:eq(1)>a@text', ctx), 'B');
    assert.equal(await rule.evalRule('class.items@tag.a.1@text', ctx), 'two');
    assert.equal(await rule.evalRule('##one##1###', { ...ctx, raw: 'one one' }), '1 one');
    assert.equal(await rule.evalRule('@js:result.includes("payload") ? "ok" : ""', { ...ctx, raw: 'payload' }), 'ok');
    const interleaved = await rule.evalRuleList('.left%%.right', ctx);
    assert.deepEqual(interleaved.map((item) => item.textContent), ['L1', 'R1', 'L2', 'R2']);
  });
  await test('Legado JavaScript result and request helpers use source context', async () => {
    let captured;
    window.fetch = async (url, options) => {
      captured = { url: String(url), options };
      return new Response('posted');
    };
    const ctx = {
      baseUrl: 'https://legado-js.invalid/book/1',
      raw: 'payload',
      source: { header: '{"X-Source":"source-value"}' },
    };
    assert.equal(await rule.evalRule('@js:result.includes("payload") ? "ok" : ""', ctx), 'ok');
    assert.equal(await rule.evalRule('<js>return await java.post("/api", "a=1", {"X-Rule":"rule-value"});</js>', ctx), 'posted');
    assert.equal(captured.url, 'https://legado-js.invalid/api');
    assert.equal(captured.options.method, 'POST');
    assert.equal(captured.options.body, 'a=1');
    assert.equal(captured.options.headers['X-Source'], 'source-value');
    assert.equal(captured.options.headers['X-Rule'], 'rule-value');
    assert.equal(await rule.evalRule('<js>java.put("id", "42"); return java.get("id");</js>', ctx), '42');
  });
  await test('Legado raw XPath stays scoped to each search item', async () => {
    const s = {
      ...source('legado-xpath'),
      ruleSearch: { bookList: '//dl', name: '//h3/a/text()', author: '//dd[2]/text()', bookUrl: '//h3/a/@href' },
    };
    window.fetch = async () => new Response(`
      <dl><h3><a href="/a">Book A</a></h3><dd>kind</dd><dd>Author A</dd></dl>
      <dl><h3><a href="/b">Book B</a></h3><dd>kind</dd><dd>Author B</dd></dl>`);
    const results = await engine.searchSource(s, 'book');
    assert.deepEqual(results.map((item) => [item.name, item.author]), [['Book A', 'Author A'], ['Book B', 'Author B']]);
  });
  await test('Legado AllInOne captures build chapters and can reverse the list', async () => {
    const s = {
      ...source('legado-regex'),
      ruleToc: { chapterList: '-:href="([^"]+)">([^<]+)', chapterName: '$2', chapterUrl: '$1' },
    };
    window.fetch = async () => new Response('<a href="/read/1.html">First</a><a href="/read/2.html">Second</a>');
    const chapters = await engine.getToc(s, { name: 'Book', bookUrl: s.bookSourceUrl + '/book', tocUrl: s.bookSourceUrl + '/toc' });
    assert.deepEqual(chapters.map((item) => item.title), ['Second', 'First']);
    assert.equal(chapters[0].url, s.bookSourceUrl + '/read/2.html');
  });
  await test('the Alice Legado source expands search and Jsoup eq detail rules', async () => {
    const alice = JSON.parse(await readFile(new URL('../sources/alicesw-format-fixed.json', import.meta.url), 'utf8'));
    let requested = '';
    window.fetch = async (url) => {
      requested = String(url);
      return new Response(`<div class="list-group-item">
        <h5><a href="/novel/1">1. 测试书</a><small>[都市]</small></h5>
        <p class="mb-1"><a>作者甲</a>　字数：12万</p><p class="timedesc">更新时间：今天</p>
        <div class="content-txt">简介文字</div></div>`);
    };
    const results = await engine.searchSource(alice, '测试');
    assert.match(requested, /q=%E6%B5%8B%E8%AF%95/);
    assert.equal(results[0].name, '测试书');
    window.fetch = async () => new Response(`<h1 class="novel_title">测试书</h1>
      <div class="novel_info"><p><a>作者甲</a></p><p><a>都市</a></p><p>状态</p><p>字 数：12万</p><p>更新</p><p><a>末章</a></p></div>
      <div class="pic"><img src="/cover.jpg"></div><div class="jianjie"><p>详情简介</p></div>
      <div class="book_newchap"><div class="tit"><a href="/novel/1/toc">目录</a></div></div>`);
    const info = await engine.getBookInfo(alice, alice.bookSourceUrl + '/novel/1');
    assert.equal(info.author, '作者甲');
    assert.equal(info.tocUrl, alice.bookSourceUrl + '/novel/1/toc');
  });
  await test('persistent chapter cache survives memory eviction and stays isolated by book URL', async () => {
    const { library } = freshStores();
    const s = source('persistent-cache');
    const b = library.addFromSearch(result(s));
    const chapters = Array.from({ length: 35 }, (_, i) => ({ title: `Chapter ${i + 1}`, url: `${s.bookSourceUrl}/chapter/${i + 1}` }));
    for (let i = 0; i < chapters.length; i++) {
      await chapterCache.writeCachedChapter(b, s, chapters[i], `saved ${i + 1}`);
    }
    window.fetch = async () => { throw new Error('offline'); };
    assert.equal(await engine.getContent(s, chapters[0].url, b), 'saved 1');
    assert.equal(await engine.getContent(s, chapters[34].url, b), 'saved 35');
    const otherBook = { ...b, bookUrl: b.bookUrl + '/other', progress: { chapterIndex: 0 } };
    await assert.rejects(engine.getContent(s, chapters[0].url, otherBook), /offline/);
    window.fetch = async () => new Response('Unavailable', { status: 503 });
    await assert.rejects(engine.getContent(s, chapters[0].url, b, { force: true }), /503/);
    assert.equal(await engine.getContent(s, chapters[0].url, b), 'saved 1');
    await chapterCache.clearBookChapterCache(b);
  });

  await test('cache task uses an exact range, skips saved chapters and preserves reading progress', async () => {
    const { library } = freshStores();
    const s = source('cache-task');
    const b = library.addFromSearch(result(s));
    b.progress = { chapterIndex: 1, chapterUrl: `${s.bookSourceUrl}/chapter/2`, scrollRatio: 0.4 };
    const before = { ...b.progress };
    const chapters = Array.from({ length: 5 }, (_, i) => ({ title: `C${i + 1}`, url: `${s.bookSourceUrl}/chapter/${i + 1}` }));
    await chapterCache.writeCachedChapter(b, s, chapters[1], 'already saved');
    let requests = 0;
    let persisted = 0;
    window.fetch = async () => { requests++; return new Response('<div id="body">downloaded</div>'); };
    const job = startChapterCacheTask({
      book: b, source: s, chapters, start: 1, count: 2, delayMs: 0,
      persistToc: async () => { persisted++; },
    });
    const final = await job.done;
    assert.equal(final.status, 'completed');
    assert.deepEqual(
      { total: final.total, saved: final.saved, skipped: final.skipped, failed: final.failed },
      { total: 2, saved: 1, skipped: 1, failed: 0 },
    );
    assert.equal(requests, 1);
    assert.equal(persisted, 1);
    assert.deepEqual(b.progress, before);
    assert.equal(await chapterCache.readCachedChapter(b, s, chapters[2].url), 'downloaded');
    assert.equal(await chapterCache.readCachedChapter(b, s, chapters[3].url), null);
    await chapterCache.clearBookChapterCache(b);
  });

  await test('chapter matching accepts formatting differences and rejects ambiguous titles', () => {
    assert.equal(matchChapter([{ title: '第１章： 初见', url: 'a' }], '第1章 初见'), 0);
    assert.equal(matchChapter([{ title: '序章', url: 'a' }, { title: '序章', url: 'b' }], '序章'), -1);
    assert.equal(matchChapter([{ title: '第一章', url: 'a' }], ''), -1);
  });
  await test('group identity stays stable when selecting a source with a book-name suffix', () => {
    const a = result(source('edition-a'));
    const b = { ...result(source('edition-b')), name: 'Example (Complete)' };
    const groups = engine.dedupeResults([a, b]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].alternatives.length, 2);
    assert.equal(engine.searchResultKey(a), engine.searchResultKey(b));
  });
  await test('flushing writes newest snapshot and recovers corrupted JSON from backup', async () => {
    await storage.writeJson('test-save.json', { version: 1 });
    storage.writeJsonDebounced('test-save.json', { version: 2 }, 60000);
    storage.writeJsonDebounced('test-save.json', { version: 3 }, 60000);
    await storage.flushStorage();
    assert.deepEqual(await storage.readJson('test-save.json', null), { version: 3 });
    localStorage.setItem('toudu:test-save.json', '{broken');
    assert.deepEqual(await storage.readJson('test-save.json', null), { version: 1 });
  });
  await test('failed writes stay retryable and clear the error once saved', async () => {
    const original = dom.window.Storage.prototype.setItem;
    dom.window.Storage.prototype.setItem = function () { throw new Error('Disk full'); };
    try {
      storage.writeJsonDebounced('retry-save.json', { value: 42 }, 60000);
      await assert.rejects(storage.flushStorage(), /Disk full/);
      assert.match(storage.storageStatus.error, /保存失败/);
    } finally { dom.window.Storage.prototype.setItem = original; }
    await storage.flushStorage();
    assert.deepEqual(await storage.readJson('retry-save.json', null), { value: 42 });
    assert.equal(storage.storageStatus.error, '');
  });
  await test('source switching preserves book identity and matches progress without adding a book', async () => {
    const { library } = freshStores();
    const b = library.addFromSearch(result(source('original')));
    const id = b.id;
    const chapters = [{ title: 'First', url: 'https://replacement.invalid/1' }, { title: 'Second', url: 'https://replacement.invalid/2' }];
    await library.changeSource(b, result(source('replacement')), 'https://replacement.invalid/toc', chapters, 1);
    assert.equal(library.books.length, 1);
    assert.equal(b.id, id);
    assert.equal(b.progress.chapterIndex, 1);
    assert.equal(b.progress.chapterTitle, 'Second');
    assert.equal(b.sourceUrl, 'https://replacement.invalid');
  });
  await test('a cached TOC from a different source is ignored after a partial save', async () => {
    const { library } = freshStores();
    const b = library.addFromSearch(result(source('toc-original')));
    await storage.writeJson(`toc_${b.id}.json`, { sourceUrl: 'https://different.invalid', bookUrl: b.bookUrl, chapters: [{ title: 'Wrong source', url: 'https://different.invalid/1' }] });
    assert.equal(await library.getToc(b), null);
  });
  await test('unmatched source chapters require selection, failed source loading preserves the original', async () => {
    const { pinia, library, ui } = freshStores();
    const b = library.addFromSearch(result(source('switch-old')));
    b.progress = { chapterIndex: 1, chapterTitle: 'Original title' }; b.lastReadTime = 1;
    ui.openSearch('', b.id);
    const overlay = await mount('views/SearchOverlay.vue', pinia);
    try {
      window.fetch = async () => new Response('Unavailable', { status: 503 });
      await overlay.state.read(result(source('switch-failed')));
      assert.equal(b.sourceUrl, 'https://switch-old.invalid');
      assert.match(overlay.state.switchError, /503/);
      window.fetch = async () => new Response('<a href="/chapter/1">New first</a><a href="/chapter/2">New second</a>');
      await overlay.state.read(result(source('switch-new')));
      assert.ok(overlay.state.prepared);
      assert.equal(b.sourceUrl, 'https://switch-old.invalid');
      overlay.state.selectedChapter = 1;
      await overlay.state.commitSource();
      assert.equal(b.sourceUrl, 'https://switch-new.invalid');
      assert.equal(b.progress.chapterTitle, 'New second');
      assert.equal(library.books.length, 1);
    } finally { overlay.unmount(); }
  });
  await test('reader discards late chapters and never advances progress after a failed load', async () => {
    const { pinia, library, sources, ui } = freshStores();
    const s = source('reader-race'); sources.list = [s];
    const b = library.addFromSearch(result(s));
    const chapters = [{ title: 'A', url: `${s.bookSourceUrl}/a` }, { title: 'B', url: `${s.bookSourceUrl}/b` }];
    library.tocCache[b.id] = chapters;
    ui.openBook(b.id);
    const pending = new Map();
    window.fetch = (url) => new Promise((resolve) => { pending.set(url, resolve); });
    const reader = await mount('views/ReaderView.vue', pinia);
    try {
      await until(() => pending.has(chapters[0].url));
      const a = pending.get(chapters[0].url);
      const switching = reader.state.loadChapter(1);
      await until(() => pending.has(chapters[1].url));
      pending.get(chapters[1].url)(new Response('<div id="body">chapter B</div>'));
      await switching;
      a(new Response('<div id="body">chapter A</div>'));
      await tick();
      assert.equal(reader.state.idx, 1);
      assert.equal(reader.state.content, 'chapter B');
      assert.equal(library.byId(b.id).progress.chapterIndex, 1);
      window.fetch = async () => new Response('Failure', { status: 503 });
      await reader.state.loadChapter(0, true);
      assert.match(reader.state.loadError, /503/);
      assert.equal(library.byId(b.id).progress.chapterIndex, 1);
    } finally { reader.unmount(); }
  });
  await test('reader ignores shortcuts in overlays and editable fields; Escape closes TOC first', async () => {
    const { pinia, library, sources, ui } = freshStores();
    const s = source('keys'); sources.list = [s]; const b = library.addFromSearch(result(s));
    library.tocCache[b.id] = [{ title: 'A', url: `${s.bookSourceUrl}/a` }]; ui.openBook(b.id);
    window.fetch = async () => new Response('<div id="body">A</div>');
    const reader = await mount('views/ReaderView.vue', pinia);
    try {
      await until(() => reader.state.content === 'A');
      ui.searchOpen = true;
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
      assert.equal(ui.readingId, b.id);
      ui.searchOpen = false;
      const input = document.createElement('input'); document.body.append(input);
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert.equal(ui.readingId, b.id); input.remove();
      reader.state.showToc = true;
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
      assert.equal(reader.state.showToc, false);
      assert.equal(ui.readingId, b.id);
    } finally { reader.unmount(); }
  });
  await test('Escape in settings closes only settings while a book remains open', async () => {
    const { pinia, library, sources, ui } = freshStores();
    const s = source('settings-keys'); sources.list = [s]; const b = library.addFromSearch(result(s));
    library.tocCache[b.id] = [{ title: 'A', url: `${s.bookSourceUrl}/a` }]; ui.openBook(b.id);
    window.fetch = async () => new Response('<div id="body">A</div>');
    const reader = await mount('views/ReaderView.vue', pinia);
    ui.openPanel('appearance');
    const settings = await mount('views/SettingsPanel.vue', pinia);
    try {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
      assert.equal(ui.panelOpen, false);
      assert.equal(ui.readingId, b.id);
    } finally { settings.unmount(); reader.unmount(); }
  });
  await test('purification save clears the unsaved state', async () => {
    const { pinia } = freshStores();
    const panel = await mount('views/PurificationManager.vue', pinia);
    try {
      panel.state.addRule();
      panel.state.rules[0].find = '广告.Conn';
      assert.equal(panel.state.hasUnsaved, true);
      assert.equal(await panel.state.save(), true);
      assert.equal(panel.state.hasUnsaved, false);
    } finally { panel.unmount(); }
  });
  await test('reader chrome reveals only near the top edge', async () => {
    const { pinia, ui } = freshStores();
    const app = await mount('App.vue', pinia);
    try {
      ui.openBook('reader-test');
      await nextTick();
      assert.equal(app.state.readerChromeVisible, true);
      app.state.trackReaderChrome({ clientY: 120 });
      assert.equal(app.state.readerChromeVisible, false);
      app.state.trackReaderChrome({ clientY: 5 });
      assert.equal(app.state.readerChromeVisible, true);
    } finally { app.unmount(); }
  });
  await test('immersive chrome CSS hides only toolbars, never the app root', async () => {
    const appSource = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8');
    const readerSource = await readFile(new URL('../src/views/ReaderView.vue', import.meta.url), 'utf8');
    assert.match(appSource, /\.app-root\.reader-mode \.subbar \{/);
    assert.match(appSource, /\.app-root\.reader-mode > \.titlebar \{/);
    assert.doesNotMatch(readerSource, /:global\(\.app-root\.reader-mode\)/);
  });
  await test('theme catalog is complete and readable', async () => {
    assert.equal(THEMES.length, 6);
    assert.equal(new Set(THEMES.map((theme) => theme.id)).size, THEMES.length);
    assert.equal(normalizeTheme('missing'), 'dark');
    assert.equal(themeById('light').minimumBackgroundOpacity, 85);
    assert.equal(themeById('sepia').minimumBackgroundOpacity, 72);
    const luminance = (hex) => {
      const channels = hex.slice(1).match(/.{2}/g).map((value) => parseInt(value, 16) / 255);
      const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    for (const theme of THEMES) {
      const values = [luminance(theme.swatch), luminance(theme.textColor)].sort((a, b) => b - a);
      assert.ok((values[0] + 0.05) / (values[1] + 0.05) >= 4.5, `${theme.id} text contrast is too low`);
    }
    const style = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
    for (const theme of THEMES.filter((item) => item.id !== 'dark')) {
      assert.match(style, new RegExp('\\[data-theme="' + theme.id + '"\\]'));
    }
    assert.match(style, /--scroll-thumb:/);
    assert.match(style, /--accent-contrast:/);
    assert.match(style, /--overlay:/);
  });
  await test('local TXT opens without a source and reads persisted chapter text', async () => {
    const parsed = txtParser.parseTxt(new TextEncoder().encode('第一章\n离线本地正文').buffer);
    const stored = await localBooks.saveLocalBook({ name: 'Local reader', originalName: 'removed.txt', parsed });
    const { pinia, library, ui } = freshStores();
    try {
      await library.addLocalBook(stored.book, stored.chapters);
      ui.openBook(stored.book.id);
      const reader = await mount('views/ReaderView.vue', pinia);
      try {
        await until(() => reader.state.rawContent === parsed.text);
        assert.equal(reader.state.rawContent, parsed.text);
        assert.equal(reader.state.content, '离线本地正文');
        assert.equal(reader.state.loadError, '');
      } finally { reader.unmount(); }
      await library.remove(stored.book.id);
    } finally {
      await localBooks.removeLocalBook(stored.book.id).catch(() => {});
    }
  });

  await test('click scrolling uses current line height and ignores drags and selections', async () => {
    const { pinia, library, sources, ui } = freshStores();
    const settings = useSettingsStore();
    settings.clickScrollEnabled = true;
    settings.clickScrollLines = 5;
    const s = source('click-scroll'); sources.list = [s]; const b = library.addFromSearch(result(s));
    library.tocCache[b.id] = [{ title: 'A', url: s.bookSourceUrl + '/a' }]; ui.openBook(b.id);
    window.fetch = async () => new Response('<div id="body">' + '正文'.repeat(200) + '</div>');
    const reader = await mount('views/ReaderView.vue', pinia);
    try {
      await until(() => !!reader.state.rawContent);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const el = document.createElement('div');
      const para = document.createElement('p'); para.className = 'para'; para.style.lineHeight = '20px'; el.append(para);
      Object.defineProperties(el, { clientHeight: { value: 200 }, clientWidth: { value: 300 }, scrollHeight: { value: 1000 } });
      el.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 200, width: 300, height: 200, toJSON() {} });
      reader.state.bodyEl = el;
      const down = { pointerId: 1, button: 0, clientX: 100, clientY: 150, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, target: el };
      reader.state.onPointerDown(down); reader.state.onPointerUp(down);
      reader.state.onBodyClick({ ...down, detail: 1 });
      assert.equal(el.scrollTop, 100);
      const dragStart = { ...down, pointerId: 2 };
      reader.state.onPointerDown(dragStart);
      reader.state.onPointerMove({ ...dragStart, clientX: 120 });
      reader.state.onPointerUp({ ...dragStart, clientX: 120 });
      reader.state.onBodyClick({ ...dragStart, clientX: 120, detail: 1 });
      assert.equal(el.scrollTop, 100);
      reader.state.onPointerDown({ ...down, pointerId: 3, clientY: 50 });
      reader.state.onPointerUp({ ...down, pointerId: 3, clientY: 50 });
      reader.state.onBodyClick({ ...down, clientY: 50, detail: 1 });
      assert.equal(el.scrollTop, 0);
    } finally { reader.unmount(); }
  });

  await test('real tray bridge restores, hides taskbar and closes through granted APIs', async () => {
    const { mockIPC, mockWindows, clearMocks } = await import('@tauri-apps/api/mocks');
    const { emit } = await import('@tauri-apps/api/event');
    const { useSettingsStore } = await load('stores/settings.ts');
    const { initializeTray } = await load('services/tray.ts');
    const { ui } = freshStores();
    const settings = useSettingsStore();
    settings.trayOnly = true;
    const caps = JSON.parse(await readFile(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'));
    const calls = [];
    let items;
    const oldEvent = globalThis.Event;
    globalThis.Event = window.Event;
    mockWindows('main');
    mockIPC((cmd, payload) => {
      calls.push([cmd, payload]);
      const [plugin, action] = cmd.replace('plugin:', '').split('|');
      assert.ok(caps.permissions.includes(`core:${plugin}:allow-${action.replaceAll('_', '-')}`), `Missing permission for ${cmd}`);
      if (cmd === 'plugin:app|default_window_icon') return 1;
      if (cmd === 'plugin:menu|new') { items = payload.options.items; return [2, 'test-menu']; }
      if (cmd === 'plugin:tray|new') return [3, 'toudu-tray'];
    }, { shouldMockEvents: true });
    try {
      await initializeTray();
      await until(() => calls.some(([c]) => c === 'plugin:window|set_skip_taskbar'));
      assert.equal(ui.trayReady, true);
      assert.equal(calls.find(([c]) => c === 'plugin:window|set_skip_taskbar')[1].value, true);
      ui.ghostHidden = true;
      items.find(i => i.id === 'settings').handler.onmessage('settings');
      await until(() => ui.panelOpen);
      assert.equal(ui.ghostHidden, false);
      assert.equal(ui.panelTab, 'window');
      assert.ok(calls.some(([c]) => c === 'plugin:window|unminimize'));
      await emit('tauri://close-requested');
      await until(() => calls.some(([c]) => c === 'plugin:window|hide'));
      assert.ok(!calls.some(([c]) => c === 'plugin:window|destroy'));
      settings.trayOnly = false;
      await until(() => calls.some(([c, p]) => c === 'plugin:window|set_skip_taskbar' && p.value === false));
      await emit('tauri://close-requested');
      await until(() => calls.some(([c]) => c === 'plugin:window|destroy'));
    } finally { clearMocks(); globalThis.Event = oldEvent; }
  });
} finally {
  await storage.flushStorage();
  await server.close();
  dom.window.close();
}
