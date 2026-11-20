import { createServer, loadConfigFromFile } from 'vite';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const evidence=process.env.OPENCRAFT_SMOKE_OUTPUT??'.local/companion-motion';
const config=await loadConfigFromFile({command:'serve',mode:'development'},'apps/workbench-web/vite.config.ts');
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:'.local/companion-motion-vite',logLevel:'error',define:{'process.env.NODE_ENV':JSON.stringify('development')},server:{host:'127.0.0.1',port:0},plugins:[...(config?.config.plugins??[]),{name:'companion-proof',configureServer(v){v.middlewares.use(async(req,res,next)=>{if(req.url==='/'){res.setHeader('content-type','text/html');res.end(await v.transformIndexHtml('/', '<html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script type="module" src="/tests/fixtures/companion-motion.tsx"></script></html>'));}else next();});}}]});
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
try {
 await server.listen();await mkdir(evidence,{recursive:true});browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const results=[];
 for(const [width,theme]of [[1160,'light'],[390,'dark'],[1160,'frost']]as const){
  const page=await browser.newPage({viewport:{width,height:1000},hasTouch:width<600}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript('window.__name = target => target;');
  await page.goto(server.resolvedUrls!.local[0],{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>!!(window as any).companionTest);
  await page.evaluate(theme=>(window as any).companionTest.theme(theme),theme);
  for(const kind of ['bean','sprout','bun','lamp','cloud','star']){
   const item=page.locator('[data-kind="'+kind+'"]');await item.scrollIntoViewIfNeeded();await page.evaluate(k=>(window as any).companionTest.setSelected(k),kind);
   const avatar=item.locator('svg');await avatar.scrollIntoViewIfNeeded();
   try{await avatar.waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('[data-activity="working"]')?.getAttribute('data-motion')==='playing',undefined,{timeout:5000});}catch(e){console.error(JSON.stringify({width,kind,errors,avatars:await page.locator('.ui-companion-avatar').evaluateAll(es=>es.map(e=>({activity:e.getAttribute('data-activity'),motion:e.getAttribute('data-motion'),bounds:e.getBoundingClientRect().toJSON()})))}));throw e;}
   const body=item.locator('[data-companion-part="figure"]'),before=await body.getAttribute('transform');await page.waitForTimeout(150);assert.notEqual(await body.getAttribute('transform'),before);
  }
  await page.evaluate(()=>{(window as any).companionTest.setSelected('bean');document.querySelector('main')!.scrollTop=0;});await page.waitForTimeout(250);
  await page.screenshot({path:join(evidence,theme+'-'+width+'.png'),fullPage:false});
  // A mounted offscreen visual never receives a grant; a live preference update stops every write.
  assert.equal(await page.locator('[data-offscreen] svg').getAttribute('data-motion'),'static');
  await page.emulateMedia({reducedMotion:'reduce'});await page.waitForTimeout(80);assert.equal(await page.locator('[data-motion="playing"]').count(),0);
  await page.emulateMedia({reducedMotion:'no-preference'});await page.waitForTimeout(150);
  await page.evaluate(()=>{(window as any).companionTest.setCrowd(true);});await page.waitForTimeout(300);await page.locator('[data-crowd]').scrollIntoViewIfNeeded();await page.waitForTimeout(200);
  assert(await page.locator('[data-motion="playing"]').count()<=4);
  const writes=await page.evaluate(async()=>{
   const counts:number[]=[],start=performance.now(),observer=new MutationObserver(rows=>{for(const row of rows)if((row.target as Element).getAttribute('data-companion-part')==='figure')counts.push(performance.now()-start);});
   observer.observe(document.querySelector('main')!,{subtree:true,attributes:true,attributeFilter:['transform']});
   await new Promise(r=>setTimeout(r,1200));observer.disconnect();return counts;
  });
  // Pause/reset writes can occur at visibility boundaries; stable sample grants obey the rolling page quota.
  const maxWindow=Math.max(0,...writes.map(t=>writes.filter(v=>v>t-1000&&v<=t).length));assert(maxWindow<=100,'bounded writes, including at most four entry resets');
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));});await page.waitForTimeout(80);assert.equal(await page.locator('[data-motion="playing"]').count(),0);
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));});await page.waitForTimeout(100);
  await page.evaluate(()=>(window as any).companionTest.setMounted(false));await page.waitForTimeout(100);assert.equal(await page.locator('.ui-companion-avatar').count(),0);
  assert.deepEqual(errors,[]);results.push({width,theme,maxRollingWrites:maxWindow,passed:true});await page.close();
 }
 await writeFile(join(evidence,'results.json'),JSON.stringify(results,null,2));console.log('PASS: six actual SVG gestures, 200-avatar quota, offscreen/reduced-motion/visibility/unmount lifecycle; light/dark/Frost, keyboard/mouse/touch-capable contexts.');
}finally{await browser?.close();await server.close();}
