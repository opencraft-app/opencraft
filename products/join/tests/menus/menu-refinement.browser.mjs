import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {source} from './menu-refinement.fixture.mjs';
const out=process.env.OPENCRAFT_SYNC_UI_OUTPUT;fs.mkdirSync(out,{recursive:true});
const server=await createServer({configFile:false,root:process.cwd(),publicDir:process.cwd()+'/apps/workbench-web/public',cacheDir:out+'/vite',logLevel:'error',resolve:{dedupe:['react','react-dom','react-intl']},esbuild:{jsx:'automatic',target:'esnext'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'touch-menu-fixture',configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url==='/'){res.setHeader('content-type','text/html');return res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.tsx"></script>')}next()})},resolveId(id){if(id==='/fixture.tsx')return id},load(id){if(id==='/fixture.tsx')return source}}]});
let browser;const results=[];
try{await server.listen();browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 for(const theme of ['light','dark'])for(const width of [320,390]){
  const ctx=await browser.newContext({viewport:{width,height:780},hasTouch:true,isMobile:true});const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>window.__name=x=>x);await page.goto(server.resolvedUrls.local[0]);await page.waitForFunction(()=>window.fixture);await page.evaluate(t=>window.fixture.setTheme(t),theme);await page.waitForFunction(()=>document.documentElement.dataset.uiDensity==='touch');
  await page.getByRole('button',{name:'会话操作',exact:true}).tap();const menu=page.locator('.workbench-context-menu');await menu.waitFor();
  await menu.evaluate(e=>Promise.all(e.getAnimations().map(a=>a.finished)));const metrics=await menu.evaluate(e=>{const r=e.getBoundingClientRect(),items=[...e.querySelectorAll('[role="menuitem"]')];return{width:r.width,height:r.height,inside:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,sections:e.querySelectorAll('[role="separator"]').length,font:getComputedStyle(items[0]).fontSize,weight:getComputedStyle(items[0]).fontWeight,shadow:getComputedStyle(e).boxShadow,heights:items.map(i=>i.getBoundingClientRect().height)}});
  assert.equal(metrics.font,'15px');assert.equal(metrics.weight,'400');assert.ok(metrics.sections>=3);assert.ok(metrics.inside);assert.ok(metrics.heights.every(h=>h>=44));assert.ok(!metrics.shadow.includes('80px'));
  await page.screenshot({path:out+'/'+width+'-'+theme+'-chat.png'});const pin=page.getByRole('menuitem',{name:'置顶',exact:true});await pin.scrollIntoViewIfNeeded();await pin.tap();await menu.waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>window.invoked),'pin');assert.equal(await page.getByRole('textbox',{name:'保留草稿'}).inputValue(),'未发送的草稿');
  await page.evaluate(()=>window.fixture.setKind('sidebar'));await page.getByRole('button',{name:'docker 标准化分发 的操作'}).tap();await menu.waitFor();await menu.evaluate(e=>Promise.all(e.getAnimations().map(a=>a.finished)));assert.equal(await menu.locator('[role="separator"]').count(),2);await page.screenshot({path:out+'/'+width+'-'+theme+'-sidebar.png'});await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'});assert.deepEqual(errors,[]);
  results.push({width,theme,...metrics,actualConversationCaller:true,actualSidebarCaller:true,actionAndDraftPreserved:true});await ctx.close();
 }
 fs.writeFileSync(out+'/results.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));
}finally{await browser?.close();await server.close()}
