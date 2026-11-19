import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {source} from './touch-menu.fixture.mjs';
const out=process.env.OPENCRAFT_SYNC_UI_OUTPUT;fs.mkdirSync(out,{recursive:true});
const server=await createServer({configFile:false,root:process.cwd(),publicDir:process.cwd()+'/apps/workbench-web/public',cacheDir:out+'/vite',logLevel:'error',resolve:{dedupe:['react','react-dom','react-intl']},esbuild:{jsx:'automatic',target:'esnext'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'touch-menu-fixture',configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url==='/'){res.setHeader('content-type','text/html');return res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.tsx"></script>')}next()})},resolveId(id){if(id==='/fixture.tsx')return id},load(id){if(id==='/fixture.tsx')return source}}]});
let browser;const results=[];
try{await server.listen();browser=await chromium.launch({headless:true,args:['--no-sandbox']});
for(const [width,touch] of [[320,true],[390,true],[1200,true],[390,false],[1200,false]])for(const theme of ['light','dark']){
 const ctx=await browser.newContext({viewport:{width,height:850},hasTouch:touch,isMobile:touch&&width<500});const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.stack)});
 await page.addInitScript(()=>window.__name=x=>x);await page.goto(server.resolvedUrls.local[0]);await page.waitForFunction(()=>window.fixture);await page.evaluate(theme=>window.fixture.setTheme(theme),theme);
 await page.waitForFunction(t=>document.documentElement.dataset.uiDensity===(t?'touch':'compact'),touch);
 const open=page.getByRole('button',{name:'会话操作',exact:true});const act=async l=>touch?l.tap():l.click();await act(open);
 const menu=page.locator('.workbench-context-menu');await menu.waitFor();await menu.evaluate(e=>Promise.all(e.getAnimations().map(a=>a.finished)));
 const metrics=await menu.evaluate(e=>{const r=e.getBoundingClientRect(),c=getComputedStyle(e),items=[...e.querySelectorAll('[role="menuitem"]')];return {radius:parseFloat(c.borderRadius),gap:parseFloat(c.rowGap),padding:parseFloat(c.paddingTop),inside:r.left>=0&&r.right<=innerWidth,heights:items.map(i=>i.getBoundingClientRect().height),font:parseFloat(getComputedStyle(items[0]).fontSize),icon:items[0].querySelector('svg').getBoundingClientRect().width,scrollable:e.scrollHeight>e.clientHeight}});
 assert.equal(metrics.radius,touch?16:12);assert.equal(metrics.font,touch?15:13);assert.equal(metrics.gap,touch?0:2);assert.ok(metrics.inside);assert.ok(metrics.heights.every(h=>h>=(touch?44:28)));assert.equal(metrics.icon,touch?18:14);
 if(touch){const last=menu.getByRole('menuitem').last();assert.ok(await last.evaluate(e=>{const m=e.closest('.workbench-context-menu');return e.getBoundingClientRect().bottom<=m.getBoundingClientRect().bottom}),'available tall viewport should expose the final action')}
 await page.screenshot({path:out+'/'+width+'-'+(touch?'touch':'mouse')+'-'+theme+'.png'});
 const archive=page.getByRole('menuitem',{name:'归档',exact:true});await archive.scrollIntoViewIfNeeded();await act(archive);await menu.waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>window.invoked),'归档');
 await act(page.getByRole('button',{name:'选择服务',exact:true}));const option=page.getByRole('menuitemradio',{name:'GitHub',exact:true});assert.equal(await option.evaluate(e=>parseFloat(getComputedStyle(e).fontSize)),touch?15:13);await act(option);assert.match(await page.getByRole('button',{name:'选择服务',exact:true}).innerText(),/GitHub/);await page.locator('.ui-choice-select__menu').waitFor({state:'hidden'});
 if(!touch){await open.focus();await page.keyboard.press('Enter');await menu.waitFor();await page.keyboard.press('ArrowDown');await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'});await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='会话操作')}
 // Nested toolbar glyphs and choice semantics must follow the menu, not the trigger.
 const hostTrigger=page.getByRole('button',{name:'选择工作环境',exact:true});await act(hostTrigger);
 const hostMenu=page.locator('.app-shell-toolbar-menu');await hostMenu.waitFor();await hostMenu.evaluate(e=>Promise.all(e.getAnimations().map(a=>a.finished)));
 await page.screenshot({path:out+'/'+width+'-'+theme+'-host-open.png'});console.log('host-open',width,theme,await hostMenu.innerText());
 const local=page.getByRole('menuitemradio',{name:'当前服务器',exact:true});const remote=page.getByRole('menuitemradio',{name:'独立云端环境',exact:true});
 assert.equal(await local.getAttribute('aria-checked'),'true');
 assert.equal(await page.getByRole('menuitemradio',{name:'暂不可用',exact:true}).getAttribute('aria-disabled'),'true');
 const glyphs=await local.locator('svg').evaluateAll(es=>es.map(e=>parseFloat(getComputedStyle(e).width)));assert.deepEqual(glyphs,[touch?18:14,touch?18:14]);
 // Move focus away so persistent checked styling is not confused with highlight.
 await remote.focus();assert.notEqual(await local.evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');
 await page.screenshot({path:out+'/'+width+'-'+(touch?'touch':'mouse')+'-'+theme+'-toolbar.png'});
 await act(remote);await hostMenu.waitFor({state:'hidden'});assert.match(await hostTrigger.innerText(),/独立云端环境/);
 await act(hostTrigger);assert.equal(await page.getByRole('menuitemradio',{name:'独立云端环境',exact:true}).getAttribute('aria-checked'),'true');await page.keyboard.press('Escape');await hostMenu.waitFor({state:'hidden'});
 // Short viewports still clip within available space; native touch pan reaches the last action.
 if(touch&&width<500){await page.setViewportSize({width,height:300});await act(open);await menu.waitFor();await menu.evaluate(e=>Promise.all(e.getAnimations().map(a=>a.finished)));
 const box=await menu.boundingBox();assert.ok(box.y>=0&&box.y+box.height<=300);assert.ok(await menu.evaluate(e=>e.scrollHeight>e.clientHeight));
 const cdp=await ctx.newCDPSession(page);const x=box.x+box.width/2,start=box.y+box.height-20,end=box.y+20;
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y:start}]});for(let i=1;i<=8;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:start+(end-start)*i/8}]});await page.waitForTimeout(20)}await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForFunction(()=>document.querySelector('.workbench-context-menu')?.scrollTop>0);
 await page.screenshot({path:out+'/'+width+'-'+theme+'-short.png'});await page.keyboard.press('End');await page.waitForFunction(()=>{const m=document.querySelector('.workbench-context-menu');const e=m?.querySelector('[role="menuitem"]:last-child');return e&&e.getBoundingClientRect().bottom<=m.getBoundingClientRect().bottom+1});await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'});await page.setViewportSize({width,height:850});await cdp.detach()}
 // Input preference changes preserve the mounted draft and are not viewport breakpoints.
 const input=page.getByRole('textbox',{name:'保留草稿'});const handle=await input.elementHandle();await page.evaluate(t=>window.fixture.setTouch(t?'off':'on'),touch);await page.waitForFunction(t=>document.documentElement.dataset.uiDensity===(t?'compact':'touch'),touch);assert.ok(await handle.evaluate(e=>e.isConnected));assert.equal(await input.inputValue(),'未保存的内容');assert.deepEqual(errors,[]);
 results.push({width,touch,theme,...metrics,selection:true,keyboard:!touch,draftRetained:true});console.log(JSON.stringify(results.at(-1)));await ctx.close();
}
fs.writeFileSync(out+'/results.json',JSON.stringify(results,null,2));
}finally{await browser?.close();await server.close()}
