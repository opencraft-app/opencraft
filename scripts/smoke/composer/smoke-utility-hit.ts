import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createServer} from 'vite';
const {chromium}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');
const output=process.env.OPENCRAFT_UTILITY_OUTPUT??'/tmp/opencraft-utility-hit';
const source=`
import React,{useEffect,useState}from'react';
import{createIntlTestRoot}from'/tests/fixtures/intl-root.tsx';
import{useUiPreferencesRuntime}from'/apps/workbench-web/src/runtime/ui-preferences-runtime';
import{bindInteractionDensity}from'/apps/workbench-web/src/runtime/interaction-density';
import{useAsyncNotices}from'/apps/workbench-web/src/components/async-notices';
import{ComposerQueueTray}from'/packages/composer-editor/src/queue-tray.tsx';
import{OpenCraftComposer}from'@opencraft/composer-editor';
import{createComposerController}from'@opencraft/composer-core';
import{createConversationKey}from'@opencraft/chat-core';
import{initializeAppearanceTheme,setThemePreference,setAppearanceThemeId,frostThemeId}from'/apps/workbench-web/src/appearance-theme.ts';
import'/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();setAppearanceThemeId(frostThemeId);
const controller=createComposerController({type:'existing-thread',key:createConversationKey('fixture','utility-hit')},{now:Date.now,createId:()=>crypto.randomUUID()});
controller.dispatch({type:'set-lifecycle',phase:'failed',error:'Send failed — retained draft'});
let events=[];let serial=0;const call=n=>async(...args)=>{events.push([n,...args])};
const items=[{id:'normal',preview:'Retained queued message',state:'queued',operation:'idle',actionable:true,editing:false},{id:'editing',preview:'Retained editing message',state:'queued',operation:'idle',actionable:true,editing:true},{id:'review',preview:'Review before discarding',state:'unknown',operation:'idle',actionable:true,editing:false},{id:'disabled',preview:'Submitted — read-only',state:'queued',operation:'idle',actionable:false,editing:false}];
function App(){const[unconfirmed,setUnconfirmed]=useState(false);const preferences=useUiPreferencesRuntime(),notices=useAsyncNotices();useEffect(()=>bindInteractionDensity(document,preferences),[preferences]);window.fixture={setUnconfirmed,setDensity:v=>preferences.set('interface.touchFriendly',v),setThemePreference,events:()=>events,fail:()=>controller.dispatch({type:'set-lifecycle',phase:'failed',error:'Send failed — retained draft'}),notice:()=>notices.error({key:'probe-'+(++serial),message:'Notification / 操作状态 '+('long-text-'.repeat(8)),detail:'Retained feedback text — long localized description'}),dismiss:()=>notices.dismissAll()};return <main style={{padding:12,maxWidth:800,margin:'auto'}}><h1>Utility controls</h1><ComposerQueueTray items={items.map(i=>i.id==='review'&&unconfirmed?{...i,unconfirmedTargetTurnId:'fixture-turn'}:i)} isResponseInProgress={false} onEdit={call('edit')} onDelete={call('delete')} onSteer={call('send')} onCancelEdit={call('cancel')} onDiscardUnconfirmed={call('review')}/><div className='thread-composer-region'><OpenCraftComposer controller={controller} isStreaming={false} onSubmit={()=>false} onCancel={()=>{}}/></div></main>}
createIntlTestRoot(document.getElementById('root')).render(<App/>);`;
const vite=await createServer({root:process.cwd(),configFile:false,publicDir:'apps/workbench-web/public',logLevel:'error',cacheDir:'node_modules/.vite-utility-hit',resolve:{dedupe:['react','react-dom']},esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,hmr:false},optimizeDeps:{include:['react','react-dom/client','@radix-ui/react-dialog','@radix-ui/react-dropdown-menu','@radix-ui/react-popover','@radix-ui/react-tooltip','@tanstack/react-query']},plugins:[{name:'utility-hit-fixture',enforce:'pre',resolveId:id=>id==='/utility-probe.tsx'?id:null,load(id){if(id==='/utility-probe.tsx')return source},configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/utility-probe.tsx"></script>')})}}]});
let browser:any;const evidence:any[]=[];const errors:string[]=[];
try{await mkdir(output,{recursive:true});await vite.listen();browser=await chromium.launch({headless:true});
for(const theme of ['light','dark'])for(const hasTouch of [false,true]){
 const context=await browser.newContext({hasTouch,viewport:{width:480,height:900}}),page=await context.newPage();page.on('pageerror',e=>{errors.push(e.message);console.log('BROWSER_ERROR',e.message)});await page.addInitScript('window.__name=value=>value');await page.goto(`http://127.0.0.1:${(vite.httpServer!.address()as any).port}`);await page.locator('.opencraft-composer-editor').waitFor({timeout:60000});
 if(process.env.OPENCRAFT_UTILITY_CSS){await page.evaluate(()=>{for(const s of document.querySelectorAll('style,link[rel="stylesheet"]'))s.remove()});await page.addStyleTag({content:await readFile(process.env.OPENCRAFT_UTILITY_CSS,'utf8')})}
 await page.evaluate(v=>(window as any).fixture.setThemePreference(v),theme);
 const editor=page.locator('.opencraft-composer-editor');await editor.fill('Draft kept while changing input density');await editor.evaluate(e=>(window as any).retainedEditor=e);
 for(const choice of ['auto','on','off'])for(const width of [352,900]){
  await page.setViewportSize({width,height:900});await page.evaluate(v=>(window as any).fixture.setDensity(v),choice);const touch=choice==='on'||choice==='auto'&&hasTouch;
  await page.waitForFunction(d=>document.documentElement.dataset.uiDensity===d,touch?'touch':'compact');
  await page.evaluate(()=>{(window as any).fixture.fail();(window as any).fixture.notice()});await page.locator('[data-sonner-toast][data-mounted="true"]').last().waitFor();
  const metrics=await page.evaluate(()=>{const rect=(e:Element)=>{let r=e.getBoundingClientRect();return{w:r.width,h:r.height,x:r.x,y:r.y,font:getComputedStyle(e).fontSize}};return{queue:[...document.querySelectorAll('.opencraft-composer-queue-item__actions button')].map(rect),glyphs:[...document.querySelectorAll('.opencraft-composer-queue-item__actions svg')].map(rect),error:rect(document.querySelector('.opencraft-composer-error button')!),toasts:[...document.querySelectorAll('[data-sonner-toast][data-mounted="true"]')].map(e=>({r:rect(e),close:rect(e.querySelector('[data-close-button]')!)})),bodyWidth:document.documentElement.scrollWidth}});
  const min=touch?44:22;for(const r of [...metrics.queue,metrics.error])assert.ok(r.w+.02>=min&&r.h+.02>=min,'utility hit floor '+JSON.stringify({choice,hasTouch,r}));
  if(!touch){assert.ok(Math.abs(metrics.error.w-22)<.02);assert.ok(Math.abs(metrics.queue[1].w-22)<.02)}
  for(const r of metrics.glyphs)assert.ok(Math.abs(r.w-12)<.02&&Math.abs(r.h-12)<.02,'glyph artwork remains12px');
  for(const{r,close}of metrics.toasts){assert.ok(Math.abs(close.w-(touch?44:32))<.02&&Math.abs(close.h-(touch?44:32))<.02,'notice follows preference, not hardware');assert.ok(close.x+.02>=r.x&&close.x+close.w<=r.x+r.w+.02&&close.y+close.h<=r.y+r.h+.02,'dismiss stays within toast')}
  assert.ok(metrics.bodyWidth<=width,'narrow document remains contained');
  assert.equal(await editor.evaluate(e=>e===(window as any).retainedEditor),true);assert.equal(await editor.innerText(),'Draft kept while changing input density');
  const actions=page.locator('.opencraft-composer-queue-item__actions').first();const before=await page.evaluate(()=>(window as any).fixture.events().length);
  if(hasTouch)await actions.locator('button').nth(1).tap();else{await actions.locator('button').nth(1).focus();await page.keyboard.press('Enter')}
  assert.equal(await page.evaluate(()=>(window as any).fixture.events().length),before+1);
  const err=page.locator('.opencraft-composer-error button');if(hasTouch)await err.tap();else{await err.focus();await page.keyboard.press('Enter')};await page.locator('.opencraft-composer-error').waitFor({state:'hidden'});
  await page.evaluate(()=>{(window as any).fixture.dismiss();(window as any).fixture.notice()});await page.locator('[data-sonner-toast][data-mounted="true"] [data-close-button]').last().waitFor();
  const close=page.locator('[data-sonner-toast][data-mounted="true"] [data-close-button]').last();if(hasTouch)await close.tap();else{await close.focus();await page.keyboard.press('Enter')};await page.waitForFunction(()=>document.querySelectorAll('[data-sonner-toast][data-mounted="true"]').length===0);
  if(choice==='on'&&width===352){await page.evaluate(()=>(window as any).fixture.fail());await page.screenshot({path:output+'/'+theme+'-'+(hasTouch?'touch':'pointer')+'.png'})}
  evidence.push({theme,hasTouch,choice,width,metrics});
 }
 // A52px shared hit floor reaches every action and all dismissal controls.
 await page.evaluate(()=>{(window as any).fixture.setDensity('on');document.documentElement.style.setProperty('--size-control-hit-min','52px');(window as any).fixture.fail();(window as any).fixture.notice()});
 await page.locator('[data-sonner-toast][data-mounted="true"]').last().waitFor();
 const mutated=await page.locator('.opencraft-composer-queue-item__actions button,.opencraft-composer-error button,[data-sonner-toast][data-mounted="true"] [data-close-button]').evaluateAll(es=>es.map(e=>{let r=e.getBoundingClientRect();return[r.width,r.height]}));for(const[w,h]of mutated)assert.ok(w+.02>=52&&h+.02>=52,'shared token must reach every control');
 await page.evaluate(()=>(window as any).fixture.dismiss());
 // Additional existing callbacks remain correctly wired; disabled actions cannot fire.
 for(const index of [0,2]){await page.locator('.opencraft-composer-queue-item__actions').first().locator('button').nth(index).click()}
 await page.locator('.opencraft-composer-queue-item__actions').nth(1).locator('button').click();await page.evaluate(()=>(window as any).fixture.setUnconfirmed(true));await page.locator('.opencraft-composer-queue-item__actions').nth(2).getByText('Review & discard',{exact:true}).click();await page.getByRole('alertdialog').getByRole('button',{name:'Discard claim',exact:true}).click();await page.getByRole('alertdialog').waitFor({state:'hidden'});assert.equal(await page.locator('.opencraft-composer-queue-item__actions').nth(3).locator('button:disabled').count(),3);
 const events=await page.evaluate(()=>(window as any).fixture.events());for(const name of ['edit','send','delete','cancel','review'])assert.ok(events.some((e:any)=>e[0]===name),'preserved '+name+' callback');
 await context.close();
}
assert.deepEqual(errors,[]);await writeFile(output+'/evidence.json',JSON.stringify(evidence,null,2));console.log('PASS utility hit targets: actual Composer, QueueTray and notification provider; pointer/coarse auto/on/off,352/900px,light/dark,keyboard/touch actions,52px token propagation,glyph/draft continuity');
}finally{await browser?.close();await vite.close()}
