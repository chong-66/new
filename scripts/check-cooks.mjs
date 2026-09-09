import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';
const live=process.argv.includes('--live');
const dom=new JSDOM('');
for(const k of ['window','document','Element','DOMParser','XPathResult'])globalThis[k]=dom.window[k];
const server=await createServer({configFile:false,server:{middlewareMode:true,watch:null},appType:'custom',optimizeDeps:{noDiscovery:true,include:[]}});
try {
 const engine=await server.ssrLoadModule('/src/engine/source.ts');
 const rule=await server.ssrLoadModule('/src/engine/rule.ts');
 const source=JSON.parse(readFileSync('sources/cooks.json','utf8'));
 if(live) window.fetch=globalThis.fetch;
 else window.fetch=async url=>{
  const path=new URL(url).pathname;
  let data;
  if(path.endsWith('/search'))data={items:[{articleid:177543,articlename:'西游记',author:'吴承恩'}]};
  else if(path.includes('/detail/'))data={articleid:Number(path.split('/').pop()),articlename:'西游记',author:'吴承恩',intro:'测试'};
  else if(path.includes('/list/'))data=[{chapterid:341689,chaptername:'第一回'}];
  else if(path.includes('/content/'))data={content:'<p>第一段&nbsp;文字</p><p>第二段文字</p>'};
  else throw new Error('Unexpected URL '+url);
  return new Response(JSON.stringify({code:200,data}),{headers:{'Content-Type':'application/json'}});
 };
 const results=await engine.searchSource(source,'西游记');
 assert.ok(results.length>0);
 const result=results.find(b=>b.bookUrl.includes('/177543?'))||results[0];
 assert.ok(!/[{}]/.test(result.bookUrl));
 assert.match(result.coverUrl,/pic\.cooks\.tw/);
 const book={name:result.name,bookUrl:result.bookUrl,tocUrl:''};
 const info=await engine.getBookInfo(source,book.bookUrl);
 assert.equal(info.name,result.name);book.tocUrl=info.tocUrl;
 // Deliberately initialize a second book between first-book detail and TOC.
 if(!live)await engine.getBookInfo(source,'https://novel.cooks.tw/api/novel/detail/999?lang=zh-CN');
 const toc=await engine.getToc(source,book);
 assert.ok(toc.length>0);assert.ok(toc[0].url.includes('/177543/'));
 const content=await engine.getContent(source,toc[0].url,undefined,{force:true});
 assert.ok(content.length>10);assert.ok(!content.includes('<p>'));
 if(!live){
  assert.equal(content,'第一段 文字\n第二段文字');
  const changed={...source,jsLib:source.jsLib+'\nvar previousClean=Clean; Clean=function(c){return previousClean(c)+"\\n规则更新";};'};
  const refreshed=await engine.getContent(changed,toc[0].url);
  assert.ok(refreshed.endsWith('规则更新'));
  const initialized={...source,ruleBookInfo:{...source.ruleBookInfo,init:'<js>var j=J(result);j.data.articlename="初始化后的名称";JSON.stringify(j);</js>'}};
  assert.equal((await engine.getBookInfo(initialized,book.bookUrl)).name,'初始化后的名称');
  const ctx={baseUrl:source.bookSourceUrl,source,text:'',memory:new Map()};
  assert.equal(await rule.evalRule('<js>function pick(){return "ok";} pick();</js>',ctx),'ok');
  assert.equal(await rule.evalRule('<js>var x=""; x || "fallback";</js>',ctx),'fallback');
  assert.equal(await rule.evalRule('<js>return "explicit";</js>',ctx),'explicit');
  assert.equal(await rule.evalRule('<js>if(true){result="assigned";}</js>',ctx),'assigned');
  assert.equal(await rule.evalRule('<js>cache.putMemory("id","123"); result;</js>',ctx),'');
  assert.equal(await rule.evalRule('<js>cache.getFromMemory("id");</js>',ctx),'123');
  assert.equal(await rule.evalRule('$.id@js:result+"x"',{...ctx,json:{id:4},text:undefined}),'4x');
 }
 console.log(JSON.stringify({mode:live?'live':'fixture',searchResults:results.length,name:info.name,chapters:toc.length,contentCharacters:content.length,passed:true}));
}finally{await server.close();dom.window.close()}
