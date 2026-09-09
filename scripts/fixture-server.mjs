// 手动界面测试用书源，仅监听本机，不访问外部小说站。
import { createServer } from 'node:http';
const origin = 'http://127.0.0.1:1422';
const sources = ['a', 'b'].map((id) => ({
  bookSourceName: `本地测试书源 ${id.toUpperCase()}`,
  bookSourceUrl: `${origin}/${id}`,
  searchUrl: `${origin}/${id}/search`,
  ruleSearch: { bookList: '.book', name: 'a@text', author: '.author@text', bookUrl: 'a@href', intro: '.intro@text' },
  ruleToc: { chapterList: 'a.chapter', chapterName: '@text', chapterUrl: '@href' },
  ruleContent: { content: '#body' },
}));
const titles = ['第一章 初见', '第二章 风起', '第三章 归途'];
createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const path = new URL(req.url, origin).pathname;
  if (path === '/sources.json') { res.end(JSON.stringify(sources)); return; }
  const id = path.split('/')[1];
  if (path.endsWith('/search')) {
    res.end(`<div class="book"><a href="/${id}/book">山间来信</a><span class="author">测试作者</span><p class="intro">这是一份本地生成的测试内容，用来检查阅读、换源和进度恢复。</p></div>`);
    return;
  }
  if (path.endsWith('/book')) {
    res.end(titles.map((title, i) => `<a class="chapter" href="/${id}/chapter/${i}">${title}</a>`).join(''));
    return;
  }
  const chapter = path.match(/\/chapter\/(\d+)$/);
  if (chapter) {
    res.end(`<div id="body">${Array.from({ length: 35 }, (_, i) => `<p>第 ${i + 1} 段 · ${titles[Number(chapter[1])]}。清晨的山路笼着薄雾，远处传来溪水的声音。这段文字用于检查滚动位置恢复、字号调整和阅读主题，当前来自书源 ${id.toUpperCase()}。</p>`).join('')}</div>`);
    return;
  }
  res.writeHead(404); res.end('Not found');
}).listen(1422, '127.0.0.1', () => console.log(`本地测试书源：${origin}/sources.json`));
