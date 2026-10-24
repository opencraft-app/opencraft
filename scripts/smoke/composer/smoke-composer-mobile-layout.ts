import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? 'playwright');
const { chromium } = playwright.default ?? playwright;
const before = process.argv.includes('--record-before');
const failures: string[] = [], evidence: unknown[] = [];
function verify(value: unknown, message: string) { if (before) { if (!value) failures.push(message); } else assert.ok(value, message); }
const source = `import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createComposerController} from '@opencraft/composer-core';
import {OpenCraftComposer} from '@opencraft/composer-editor';
import {useTimelineViewportHost} from '/apps/workbench-web/src/timeline-viewport.ts';
import * as theme from '@opencraft/design-system/theme-engine';
import '/apps/workbench-web/src/styles/app.scss';
const params=new URLSearchParams(location.search), mode=params.get('theme')||'light';
document.documentElement.dataset.theme=mode;document.documentElement.dataset.uiDensity=params.has('desktop')?'compact':'touch';document.documentElement.dataset.touchNewera=params.has('ordinary')?'off':'on';
for(const [key,value] of Object.entries(theme.buildOpenCraftThemeCssProperties(mode,theme.opencraftNeutralThemePalette[mode])))document.documentElement.style.setProperty(key,value);
const controller=createComposerController({type:'existing-thread',key:{hostId:'fixture',threadId:'one'}},{now:Date.now,createId:()=>crypto.randomUUID()});
window.fixture={controller};
const models=Array.from({length:18},(_,i)=>({id:'model-'+i,value:'model-'+i,label:i===0?'GPT-6.1-Sol':'Model '+i,description:null,isDefault:i===0,defaultEffort:'medium',source:'custom',contextWindow:200000,maxTokens:32000,inputModalities:['text','image'],supportsReasoning:true,efforts:['low','medium','high','xhigh','max','ultra'].map(value=>({value,label:value,description:null}))}));
function App(){useTimelineViewportHost({kind:'browser',platform:'linux',safeArea:{left:0,right:0}});return <div className='app-shell-root'><header style={{height:56,flexShrink:0}}>Home</header><main style={{display:'grid',alignContent:'center',height:'calc(100% - 56px)',padding:16}}><div style={{width:'100%',maxWidth:760,margin:'auto'}}><OpenCraftComposer controller={controller} selectionCatalog={{models,permissionProfiles:[]}} chromeHeader={<div style={{height:36,padding:'6px 12px'}}>Machine · OpenCraft › data</div>} placeholder={params.has('chinese')?'分享你的想法，或让我帮你一起完成一些事情':'Share your thoughts, or ask me to help with something'} endActions={<button aria-label='Microphone' className='opencraft-composer-icon-button'>M</button>} onSubmit={()=>false} onCancel={()=>{}} /></div></main></div>}
createIntlTestRoot(document.getElementById('root')).render(<App/>);`;
const vite = await createServer({configFile:false,root:process.cwd(),logLevel:'error',resolve:{dedupe:['react','react-dom']},cacheDir:'node_modules/.vite-mobile-composer-layout',optimizeDeps:{include:['react','react-dom/client','react-intl','@radix-ui/react-dropdown-menu','@radix-ui/react-dialog','@radix-ui/react-tooltip']},esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0},plugins:[{name:'fixture',resolveId:id=>id==='/mobile-layout.tsx'?id:null,load:id=>id==='/mobile-layout.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(!req.url?.startsWith('/?'))return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/mobile-layout.tsx"></script>');});}}]});
await mkdir('.local/mobile-composer',{recursive:true});await vite.listen();
const browser = await chromium.launch({executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
try {
 for(const width of before?[390]:[320,390,430,1280]) for(const theme of ['light','dark']) {
  const desktop=width===1280;
  const context=await browser.newContext({viewport:{width,height:844},isMobile:!desktop,hasTouch:!desktop,reducedMotion:'reduce',...(!desktop?{userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'}:{})});
  await context.addInitScript(({width})=>{(window as any).__name=(v:unknown)=>v;const v=new EventTarget();Object.assign(v,{width,height:844,offsetTop:0,offsetLeft:0,scale:1});Object.defineProperty(window,'visualViewport',{value:v});(window as any).setViewport=(height:number,offsetTop:number)=>{Object.assign(v,{height,offsetTop});v.dispatchEvent(new Event('resize'));v.dispatchEvent(new Event('scroll'));};},{width});
  const page=await context.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  for(const ordinary of desktop?[false]:[false,true]) for(const chinese of [false,true]) {
   await page.goto(`${vite.resolvedUrls!.local[0]}?theme=${theme}${desktop?'&desktop':''}${ordinary?'&ordinary':''}${chinese?'&chinese':''}`);
   const editor=page.locator('.opencraft-composer-editor'),shell=page.locator('.opencraft-composer-shell');await editor.waitFor();
   const label=`${width}/${theme}/${ordinary?'ordinary':'newera'}/${chinese?'zh':'en'}`;
   const initial=await editor.evaluate(e=>{const p=e.querySelector('p')!,r=e.getBoundingClientRect(),ph=getComputedStyle(p,'::before');return {editor:r.toJSON(),placeholderWidth:parseFloat(ph.width),placeholderHeight:parseFloat(ph.height),lineHeight:parseFloat(getComputedStyle(e).lineHeight),shell:e.closest('.opencraft-composer-shell')!.getBoundingClientRect().toJSON()};});
   verify(initial.placeholderWidth<=initial.editor.width+1,`${label}: placeholder overlaps neighboring controls ${JSON.stringify(initial)}`);
   if(!desktop&&!ordinary)verify(initial.placeholderHeight<=initial.lineHeight+1,`${label}: compact placeholder must fit one line`);
   evidence.push({label,initial});
   if(!ordinary&&!chinese)await page.screenshot({path:`.local/mobile-composer/${before?'before':'after'}-${width}-${theme}-home.png`});
   // Focus expansion and blur return must preserve one editor and contained text.
   await editor.evaluate(e=>(window as any).keptEditor=e);await editor.focus();await editor.fill('Keep this draft');
   for(const [height,offset] of desktop?[[844,0]]:[[420,0],[300,100],[260,180]]) {
    await page.evaluate(([h,t])=>(window as any).setViewport(h,t),[height,offset]);
    await page.waitForFunction(([h,t])=>getComputedStyle(document.documentElement).getPropertyValue('--timeline-visual-viewport-height')===h+'px'&&getComputedStyle(document.documentElement).getPropertyValue('--timeline-visual-viewport-offset-top')===t+'px',[height,offset]);
    const model=page.locator('.opencraft-composer-mode--intelligence');
    if(desktop)await model.click();else await model.tap();
    const menu=page.locator('.opencraft-composer-selection-menu--intelligence');await menu.waitFor();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const detail=page.locator('.opencraft-composer-intelligence-detail');
    // Native menu scroll must reveal even the final declared reasoning option.
    const option=menu.locator('.ui-discrete-slider__control');
    if(!before&&!desktop&&!ordinary&&!chinese&&height===300){
     await detail.evaluate(e=>{e.scrollTop=0;});const rect=await detail.boundingBox();assert(rect);
     const cdp=await context.newCDPSession(page),x=rect.x+rect.width/2,start=rect.y+rect.height-8;
     await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y:start}]});
     for(let i=1;i<=8;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:start-i*(rect.height-16)/8}]});
     await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
     await page.waitForFunction(()=>(document.querySelector('.opencraft-composer-intelligence-detail')?.scrollTop??0)>0);
     await cdp.detach();
    }
    await detail.evaluate(e=>{e.scrollTop=e.scrollHeight;});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const geometry=await option.evaluate(e=>{const r=e.getBoundingClientRect(),m=e.closest('[role="menu"]')!.getBoundingClientRect(),d=e.closest('.opencraft-composer-intelligence-detail')!.getBoundingClientRect(),v=visualViewport!,hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {option:r.toJSON(),menu:m.toJSON(),detail:d.toJSON(),viewport:{top:v.offsetTop,bottom:v.offsetTop+v.height},hit:e===hit||e.contains(hit)};});
    evidence.push({label,height,offset,geometry});
    verify(geometry.hit&&geometry.option.y>=geometry.menu.y&&geometry.option.bottom<=geometry.menu.bottom+1,`${label}/${height}: reasoning option clipped ${JSON.stringify(geometry)}`);
    verify(geometry.menu.y>=offset-1&&geometry.menu.bottom<=offset+height+1,`${label}/${height}: popup outside visible viewport`);
    if(!ordinary&&!chinese&&height===300)await page.screenshot({path:`.local/mobile-composer/${before?'before':'after'}-${width}-${theme}-menu.png`});
    if(geometry.hit){
     const r=await option.boundingBox();assert(r);
     if(desktop)await option.click({position:{x:r.width-2,y:r.height/2}});else await option.tap({position:{x:r.width-2,y:r.height/2}});
     await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'});
     assert.equal(await page.evaluate(()=>(window as any).fixture.controller.getSnapshot().draft.selections.effort),'ultra');
    }else await page.keyboard.press('Escape');
    assert.equal(await editor.innerText(),'Keep this draft');
    assert(await editor.evaluate(e=>e===(window as any).keptEditor),'layout must not remount editor');
    if(!desktop)assert(await editor.evaluate(e=>e===document.activeElement),'touch menu selection must retain editor focus');
   }
   if(!before&&width===390&&theme==='light'&&!ordinary&&!chinese){
    for(const value of ['low','medium','high','xhigh','max','ultra']){
     await page.locator('.opencraft-composer-mode--intelligence').tap();
     const menu=page.locator('.opencraft-composer-selection-menu--intelligence');await menu.waitFor();
     await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
     const control=menu.locator('.ui-discrete-slider__control');
     await control.scrollIntoViewIfNeeded();await control.screenshot();
     const r=await control.boundingBox();assert(r);
     const index=['low','medium','high','xhigh','max','ultra'].indexOf(value);
     await control.tap({position:{x:Math.max(2,Math.min(r.width-2,r.width*index/5)),y:r.height/2}});
     await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'});
     assert.equal(await page.evaluate(()=>(window as any).fixture.controller.getSnapshot().draft.selections.effort),value);
     assert.equal(await editor.innerText(),'Keep this draft');
    }
   }
   await page.evaluate(()=>(window as any).setViewport(844,0));await editor.fill('');await editor.evaluate(e=>(e as HTMLElement).blur());
   assert.equal(await shell.count(),1);
  }
  assert.deepEqual(errors,[]);await context.close();
 }
 await writeFile(`.local/mobile-composer/${before?'before':'after'}.json`,JSON.stringify({failures,evidence},null,2));
 if(before)assert(failures.length>0,'baseline must reproduce a failure');
 console.log(JSON.stringify({passed:!failures.length,baseline:before,failureCount:failures.length,cases:evidence.length}));
} finally {await browser.close();await vite.close();}
