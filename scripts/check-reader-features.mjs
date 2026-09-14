import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const dom = new JSDOM('', { url: 'https://features.test/' });
globalThis.window = dom.window;
globalThis.localStorage = dom.window.localStorage;
const { default: vuePlugin } = await import('@vitejs/plugin-vue');
const server = await createServer({
  configFile: false, plugins: [vuePlugin()],
  server: { middlewareMode: true, watch: null }, appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
});
const load = (path) => server.ssrLoadModule('/src/' + path);

try {
  const parser = await load('services/txtParser.ts');
  const purification = await load('services/textPurification.ts');
  const localBooks = await load('services/localBooks.ts');
  const purificationTask = await load('services/purificationTask.ts');

  await test('TXT parser recognizes headings and preserves every character', () => {
    const source = [
      '前置说明\r\n',
      '第一章 初见\r\n' + '正文甲'.repeat(30) + '\r\n',
      '第二章：继续\r\n' + '正文乙'.repeat(30) + '\r\n',
      'Chapter III End\r\n' + 'final 😀'.repeat(20),
    ].join('');
    const parsed = parser.parseTxt(new TextEncoder().encode(source).buffer);
    assert.equal(parsed.encoding, 'utf-8');
    assert.equal(parsed.splitMethod, 'headings');
    assert.deepEqual(parsed.sections.map((item) => item.title), ['前言', '第一章 初见', '第二章：继续', 'Chapter III End']);
    assert.equal(parsed.sections.map((item) => parsed.text.slice(item.start, item.end)).join(''), source.replace(/\r\n/g, '\n'));
    parsed.sections.slice(1).forEach((item, i) => assert.equal(item.start, parsed.sections[i].end));
  });

  await test('ordinary prose is not mistaken for a chapter and length splitting keeps surrogate pairs', () => {
    const source = '第一章里说过这件事。\n' + '甲'.repeat(5999) + '😀' + '乙'.repeat(15000);
    const parsed = parser.parseTxt(new TextEncoder().encode(source).buffer);
    assert.equal(parsed.splitMethod, 'length');
    assert.equal(parsed.sections.map((item) => parsed.text.slice(item.start, item.end)).join(''), source);
    for (const section of parsed.sections) {
      assert.ok(!/[\uD800-\uDBFF]$/.test(parsed.text.slice(section.start, section.end)));
      assert.ok(!/^[\uDC00-\uDFFF]/.test(parsed.text.slice(section.start, section.end)));
    }
  });

  await test('special-title prose stays in正文 and a leading TOC keeps the first real chapter', () => {
    const prose = parser.parseDecodedTxt('前言这是正文，不是标题。\n下一行。', 'utf-8');
    assert.equal(prose.splitMethod, 'length');
    const source = ['第一章', '第二章', '第三章', '第四章', '第五章', '',
      '第一章 正文', '真实内容'.repeat(30), '第二章 后续', '下一章内容'.repeat(30)].join('\n');
    const parsed = parser.parseDecodedTxt(source, 'utf-8');
    assert.equal(parsed.sections.some((section) => section.title === '第一章 正文'), true);
    assert.equal(parsed.sections.map((section) => parsed.text.slice(section.start, section.end)).join(''), parsed.text);
  });

  await test('TXT native limit rejects bytes over exactly 30 MiB', () => {
    assert.equal(parser.MAX_TXT_BYTES, 31_457_280);
    assert.throws(() => parser.parseTxt(new ArrayBuffer(parser.MAX_TXT_BYTES + 1)), /30 MiB/);
    const exact = new Uint8Array(parser.MAX_TXT_BYTES);
    exact.fill(65);
    assert.equal(parser.decodeTxt(exact.buffer).text.length, parser.MAX_TXT_BYTES);
  });

  const rule = (patch = {}) => ({
    id: crypto.randomUUID(), name: 'test', enabled: true, mode: 'text',
    find: 'AD', replacement: '', ignoreCase: false, multiline: false, dotAll: false, ...patch,
  });
  await test('purification worker clones reactive-style rules before postMessage', async () => {
    const OriginalWorker = globalThis.Worker;
    class CloneCheckingWorker {
      onmessage;
      onerror;
      postMessage(data) {
        const cloned = structuredClone(data);
        queueMicrotask(() => this.onmessage?.({ data: {
          id: cloned.id, result: purification.applyPurificationRules(cloned.text, cloned.rules),
        } }));
      }
      terminate() {}
    }
    globalThis.Worker = CloneCheckingWorker;
    try {
      const proxiedRules = new Proxy([new Proxy(rule(), {})], {});
      const result = await purificationTask.purifyInWorker('AD正文', proxiedRules);
      assert.equal(result.text, '正文');
    } finally {
      if (OriginalWorker === undefined) delete globalThis.Worker;
      else globalThis.Worker = OriginalWorker;
    }
  });

  await test('purification is ordered, global and treats replacement tokens literally', () => {
    const first = rule({ id: 'a', find: 'AD', replacement: '$1' });
    const second = rule({ id: 'b', find: '$1', replacement: '' });
    const result = purification.applyPurificationRules('AD 正文 AD', [first, second]);
    assert.equal(result.text, ' 正文 ');
    assert.deepEqual(result.counts, { a: 2, b: 2 });
  });

  await test('regex purification handles multiline rules and rejects invalid expressions', () => {
    const remove = rule({ id: 'r', mode: 'regex', find: '^广告：[^\\n]*(?:\\n|$)', multiline: true });
    assert.equal(purification.applyPurificationRules('广告：删除\n正文\n广告：再删\n', [remove]).text, '正文\n');
    assert.match(purification.validateRule(rule({ mode: 'regex', find: '(' })), /无效/);
  });

  await test('local TXT storage survives service reads and does not need the original file', async () => {
    const parsed = parser.parseTxt(new TextEncoder().encode('第一章\n本地正文').buffer);
    const stored = await localBooks.saveLocalBook({ name: '测试本地书', originalName: 'gone.txt', parsed });
    try {
      const toc = await localBooks.loadLocalToc(stored.book);
      assert.equal(toc.length, 1);
      assert.equal(await localBooks.readLocalChapter(stored.book, toc[0].url), parsed.text);
      assert.equal(stored.book.origin, 'local-txt');
      assert.equal(stored.book.localTxt.contentHash, await localBooks.hashLocalText(parsed.text));
    } finally {
      await localBooks.removeLocalBook(stored.book.id);
    }
  });
} finally {
  await server.close();
  dom.window.close();
}
