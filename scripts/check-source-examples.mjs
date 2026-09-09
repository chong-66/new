import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const dom = new JSDOM('', { url: 'https://examples.invalid/' });
for (const key of ['window', 'document', 'Element', 'DOMParser', 'XPathResult']) globalThis[key] = dom.window[key];
const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const engine = await server.ssrLoadModule('/src/engine/source.ts');
  const { parseSourceText } = await server.ssrLoadModule('/src/stores/sources.ts');
  const template = parseSourceText(readFileSync(new URL('../sources/template.json', import.meta.url), 'utf8'))[0];
  const local = parseSourceText(readFileSync(new URL('../sources/local-example.json', import.meta.url), 'utf8'))[0];
  assert.ok(template && local);
  assert.equal(template.enabled, false);
  for (const source of [template, local]) {
    const origin = new URL(source.bookSourceUrl).origin;
    window.fetch = async (url) => {
      const path = new URL(url).pathname;
      let html;
      if (path.endsWith('/search')) {
        html = '<div class="search-results"><div class="book-item book"><a class="book-title" href="/book/1">山间来信</a><span class="book-author">作者：林间</span><span class="author">林间</span><p class="book-intro intro">教学内容</p><img src="/covers/1.jpg"></div></div>';
      } else if (path === '/book/1' && source.ruleBookInfo) {
        html = '<div class="book-info"><h1>山间来信</h1><span class="book-author">作者：林间</span><p class="book-intro">教学内容</p><a class="toc-link" href="/book/1/chapters">目录</a></div>';
      } else if (path.startsWith('/book/')) {
        html = '<div class="chapter-list"><a class="chapter" href="/chapter/1">第一章 初见</a><a class="chapter" href="/chapter/2">第二章 风起</a></div>';
      } else if (path.startsWith('/chapter/')) {
        html = '<div id="content"><p>清晨的山路笼着薄雾。</p><p>远处传来溪水的声音。</p></div><div id="body"><p>清晨的山路笼着薄雾。</p><p>远处传来溪水的声音。</p></div>';
      } else throw new Error(`Unexpected fixture request: ${url}`);
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    };
    const results = await engine.searchSource(source, '山间来信');
    assert.equal(results.length, 1);
    assert.equal(results[0].name, '山间来信');
    assert.equal(results[0].author, '林间');
    assert.equal(results[0].bookUrl, `${origin}/book/1`);
    const book = { name: results[0].name, bookUrl: results[0].bookUrl, tocUrl: '' };
    const info = await engine.getBookInfo(source, book.bookUrl);
    if (source.ruleBookInfo) {
      assert.equal(info.name, '山间来信');
      assert.equal(info.tocUrl, `${origin}/book/1/chapters`);
    }
    book.tocUrl = info.tocUrl || '';
    const chapters = await engine.getToc(source, book);
    assert.equal(chapters.length, 2);
    assert.equal(chapters[0].title, '第一章 初见');
    for (const chapter of chapters) {
      const content = await engine.getContent(source, chapter.url);
      assert.equal(content, '清晨的山路笼着薄雾。\n远处传来溪水的声音。');
    }
    console.log(`通过：${source.bookSourceName}，导入解析 → 搜索 → 详情/目录 → 两章正文`);
  }
} finally {
  await server.close();
  dom.window.close();
}
