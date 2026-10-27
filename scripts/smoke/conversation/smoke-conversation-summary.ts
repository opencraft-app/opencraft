import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
const output = process.env.OPENCRAFT_SUMMARY_EVIDENCE ?? '/tmp/opencraft-thread-summary';
await mkdir(output, { recursive: true });
const source = `
import React,{useState} from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createWorkbenchPanelReactRuntime} from '@opencraft/workbench-panels-react';
import {ThreadSummaryPlugin} from '@opencraft/plugin-thread-summary';
import {WorkbenchPanelRuntimeProvider} from '/apps/workbench-web/src/runtime/panel-runtime-context';
import {ConversationSummaryButton,ConversationSummarySurface,ConversationSummaryLayout,useConversationSummary} from '/apps/workbench-web/src/components/conversation-summary';
import {initializeAppearanceTheme,setThemePreference,setAppearanceThemeId,coreThemeId} from '/apps/workbench-web/src/appearance-theme';
import {UiPreferencesRuntime,MemoryUiPreferenceStore} from '@opencraft/ui-preferences';
import {bindInteractionDensity} from '/apps/workbench-web/src/runtime/interaction-density';
import {bindTouchInteractionMode} from '/apps/workbench-web/src/runtime/pointer-modality';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const preferences=await UiPreferencesRuntime.open({installation:new MemoryUiPreferenceStore()});bindInteractionDensity(document,preferences);bindTouchInteractionMode(document);
const runtime=await createWorkbenchPanelReactRuntime();const fiber=await runtime.install(ThreadSummaryPlugin);
const timeline={authoritative:true,frames:[{blocks:[{type:'todo',entries:Array.from({length:16},(_,i)=>({id:String(i),text:['Inspect the current workspace','Build the task information module','Verify desktop and mobile layouts'][i%3]+' '+i,status:i<2?'complete':i===2?'in-progress':'pending'}))}, {type:'patch',changes:['shell-and-layout.md','use-touch-menu-trigger.ts','smoke-composer-add-menu-layout.ts','smoke-home-composer-focus.ts','smoke-sidebar-menu-touch.ts','一个用于验证中英文长文件名截断和扩展名保留的组件.tsx','src/index.ts','tests/index.ts','package.json','styles/task-information.scss','removed-config.json'].map((name,i)=>({path:'/workspace/project/'+name,kind:i===10?'delete':i%3===0?'add':'modify'}))},{type:'command-execution',id:'background',command:'npm run typecheck --workspace @opencraft/workbench-web',status:'running'}, {type:'subagent',id:'agent',label:'Design review',agentId:null,tool:'spawnAgent',status:'complete',activityKind:'started',receiverThreadIds:['child'],agentStates:{child:{status:'running'}},agentPath:null}]}]};
function App(){const[scope,setScope]=useState('account/host/one');const[filesOnly,setFilesOnly]=useState(false);const[frameWidth,setFrameWidth]=useState(null);const[empty,setEmpty]=useState(false);const summary=useConversationSummary(scope,true);window.fixture={setFrameWidth,setEmpty,setDensity:value=>preferences.set('interface.touchFriendly',value),setFilesOnly,setScope,setThemePreference,setAppearanceThemeId,coreThemeId,dispose:()=>fiber.dispose(),runtime};
return <WorkbenchPanelRuntimeProvider runtime={runtime}><div style={{height:'100dvh',width:frameWidth??'100%',maxWidth:'100%',display:'flex',flexDirection:'column'}}><header style={{height:56,display:'flex',alignItems:'center',justifyContent:'space-between',padding:'0 24px'}}><span>Workspace / Task information</span><ConversationSummaryButton controller={summary}/></header><div className='local-conversation-page' style={{flex:1,minHeight:0}}><ConversationSummaryLayout controller={summary}><div className='conversation-summary-reading'><div style={{maxWidth:720,margin:'auto',padding:'32px 24px'}}><h1>Build a task information panel</h1><p>Keep progress, files and activity close to the conversation.</p><textarea aria-label='Draft' defaultValue='Preserve this draft' style={{width:'100%',marginTop:48}}/></div></div><ConversationSummarySurface controller={summary} context={{scopeKey:scope,title:'Desktop server onboarding',timeline:empty?null:filesOnly?{...timeline,frames:[{blocks:[timeline.frames[0].blocks[1]]}]}:timeline,goal:filesOnly||empty?null:{objective:'Make ongoing work easy to follow, on desktop and on the phone.',status:'active'},current:scope!=='cached',onOpenResource:path=>window.opened=path,onOpenThread:id=>window.opened=id}}/></ConversationSummaryLayout></div></div></WorkbenchPanelRuntimeProvider>}
function Root(){return <WorkbenchPanelRuntimeProvider runtime={runtime}><App/></WorkbenchPanelRuntimeProvider>}
createIntlTestRoot(document.getElementById('root')).render(<Root/>);`;
const previewSource = process.env.OPENCRAFT_SUMMARY_PREVIEW_PORT ? source
  .replace('length:16', 'length:3')
  .replace("+' '+i", '')
  .replace("].map((name,i)=>", "].slice(0,2).map((name,i)=>")
  .replace("createIntlTestRoot(document.getElementById('root'))", "createIntlTestRoot(document.getElementById('root'),undefined,'zh-CN')")
  .replace('initializeAppearanceTheme();', "initializeAppearanceTheme();setAppearanceThemeId('opencraft.core.longing');")
  .replaceAll('Desktop server onboarding', '完善桌面工作台')
  .replaceAll('Workspace / Task information', '任务信息预览')
  .replaceAll('Build a task information panel', '任务信息面板')
  .replaceAll('Keep progress, files and activity close to the conversation.', '计划、变更和后台进程，随任务进展更新。')
  .replaceAll('Inspect the current workspace', '检查当前项目')
  .replaceAll('Build the task information module', '完善任务信息展示')
  .replaceAll('Verify desktop and mobile layouts', '验证触控与鼠标操作')
  .replaceAll('Make ongoing work easy to follow, on desktop and on the phone.', '让任务进展清晰可见。') : source;
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',resolve:{dedupe:['react','react-dom','react-intl']},esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:Number(process.env.OPENCRAFT_SUMMARY_PREVIEW_PORT??0),hmr:false},plugins:[react(),{name:'summary-fixture',resolveId:id=>id==='/summary-fixture.tsx'?id:null,load:id=>id==='/summary-fixture.tsx'?previewSource:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/summary-fixture.tsx"></script>')})}}]});
let browser:any;
try {
await vite.listen();
if(process.env.OPENCRAFT_SUMMARY_PREVIEW_PORT){console.log(vite.resolvedUrls!.local[0]);await new Promise(()=>{});}
const {chromium}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');browser=await chromium.launch({headless:true});
const evidence=[];
for(const theme of ['light','dark','lavender']) {
 const page=await browser.newPage({viewport:{width:1680,height:900}});const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));
 await page.addInitScript(()=>{(window as any).__name=(value:unknown)=>value});await page.goto(vite.resolvedUrls!.local[0]!);await page.waitForSelector('.thread-summary__section');
 await page.evaluate(theme=>{const f=(window as any).fixture;f.setThemePreference(theme==='dark'?'dark':'light');f.setAppearanceThemeId(theme==='lavender'?'opencraft.core.lavender':f.coreThemeId)},theme);
 const draft=await page.locator('textarea').elementHandle();
 const layout=page.locator('.conversation-summary-layout');
 await page.waitForFunction(()=>document.querySelector('[data-summary-mode=gutter]'));
 const sharedSurface=await page.locator('.conversation-summary').evaluate(card=>{
   const element=card as HTMLElement;
   element.style.setProperty('--utility-card-radius','19px');
   element.style.setProperty('--utility-card-border-color','rgb(10, 20, 30)');
   element.style.setProperty('--utility-card-shadow','rgb(20, 30, 40) 0px 2px 5px 0px');
   const css=getComputedStyle(element);const result={radius:css.borderTopLeftRadius,border:css.borderTopColor,shadow:css.boxShadow};
   for(const token of ['--utility-card-radius','--utility-card-border-color','--utility-card-shadow'])element.style.removeProperty(token);
   return result;
 });
 assert.deepEqual(sharedSurface,{radius:'19px',border:'rgb(10, 20, 30)',shadow:'rgb(20, 30, 40) 0px 2px 5px 0px'},'task card consumes the shared utility surface');
 assert.equal(await page.locator('.conversation-summary').evaluate(card=>{
   const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
   const context=canvas.getContext('2d')!;context.fillStyle=getComputedStyle(card).backgroundColor;context.fillRect(0,0,1,1);
   return context.getImageData(0,0,1,1).data[3];
 }),255,'detached card stays opaque over conversation text');
 assert.equal(await layout.evaluate(e=>parseFloat(getComputedStyle(e).paddingInlineEnd)),0,'spare gutter does not move the reading column');
 await page.evaluate(()=>(window as any).fixture.setFilesOnly(true));await page.waitForSelector('.thread-summary__filename');
 assert.equal(await page.locator('.thread-summary__file').count(),11);
 assert.equal(await page.locator('.thread-summary__filename small').count(),3);
 const geometry=await page.locator('.thread-summary__file').evaluateAll(rows=>rows.map(row=>({height:row.getBoundingClientRect().height,overflow:row.scrollWidth>row.clientWidth})));
 assert(geometry.every(row=>!row.overflow));assert(geometry.slice(0,6).every(row=>row.height<=44));
 await page.locator('.thread-summary__file').first().click();assert.equal(await page.evaluate(()=>(window as any).opened),'/workspace/project/shell-and-layout.md');
 assert.equal(await page.locator('[data-file-kind=delete]').isDisabled(),true);
 await page.screenshot({path:output+'/'+theme+'-gutter.png'});
 await page.evaluate(()=>(window as any).fixture.setFrameWidth(1280));
 await page.waitForFunction(()=>document.querySelector('[data-summary-mode=shift]')&&parseFloat(getComputedStyle(document.querySelector('.conversation-summary-layout')!).paddingInlineEnd)>359);
 assert((await page.locator('.conversation-summary-reading').boundingBox())!.width>=768,'inline reservation retains the reading budget');
 await page.screenshot({path:output+'/'+theme+'-shift.png'});
 await page.evaluate(()=>(window as any).fixture.setFilesOnly(false));await page.getByRole('button',{name:/Plan/}).click();
 await page.getByRole('button',{name:'Task info',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.conversation-summary'));
 await page.getByRole('button',{name:'Task info',exact:true}).click();await page.waitForSelector('.conversation-summary');
 await page.evaluate(()=>(window as any).fixture.setFrameWidth(960));await page.getByRole('dialog',{name:'Task info',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:/Plan/}).getAttribute('aria-expanded'),'false');
 await page.getByRole('button',{name:/Plan/}).click();
 await page.evaluate(()=>(window as any).fixture.setFrameWidth(840));
 await page.waitForFunction(()=>Math.abs(document.querySelector('[role=dialog]')!.getBoundingClientRect().right-document.querySelector('.conversation-summary-trigger')!.getBoundingClientRect().right)<1);
 await page.locator('[data-summary-present=true] .thread-summary__scroll').evaluate(e=>e.scrollTop=160);
 await page.waitForFunction(()=>document.querySelector('[data-summary-present=true] .thread-summary__scroll')!.scrollTop>=150);
 await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));
 assert.equal(await page.getByRole('button',{name:'Task info',exact:true}).evaluate(e=>e===document.activeElement),true);
 await page.getByRole('button',{name:'Task info',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-summary-present=true] .thread-summary__scroll')!.scrollTop>=150);
 await page.evaluate(()=>(window as any).fixture.setFrameWidth(1680));await page.waitForFunction(()=>document.querySelector('aside[data-summary-present=true]'));
 assert.equal(await page.locator('textarea').inputValue(),'Preserve this draft');assert.equal(await draft!.evaluate(e=>e===document.querySelector('textarea')),true);
 assert.equal(await page.getByRole('button',{name:/Plan/}).getAttribute('aria-expanded'),'true');
 await page.evaluate(()=>(window as any).fixture.setScope('cached'));await page.waitForFunction(()=>document.querySelector('[data-summary-present=true] .thread-summary__scroll')!.scrollTop===0);
 assert.equal(await page.locator('[data-summary-present=true] .thread-summary__link:not(:disabled)').count(),0);
 await page.evaluate(()=>(window as any).fixture.setEmpty(true));await page.waitForSelector('.thread-summary__empty');
 assert((await page.locator('.conversation-summary[data-summary-present=true]').boundingBox())!.height<200,'empty card stays compact');
 await page.waitForFunction(()=>document.querySelectorAll('.conversation-summary').length===1&&getComputedStyle(document.querySelector('.conversation-summary')!).opacity==='1');
 await page.screenshot({path:output+'/'+theme+'-empty.png'});
 await page.evaluate(()=>(window as any).fixture.dispose());await page.waitForFunction(()=>!document.querySelector('.conversation-summary-trigger'));
 assert.equal(await page.locator('.conversation-summary').count(),0);assert.deepEqual(errors,[]);
 evidence.push({theme,modes:['gutter','shift','overlay'],draftPreserved:true,scopeReset:true,errors});await page.close();
 const touch=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
 await touch.addInitScript(()=>{(window as any).__name=(value:unknown)=>value});await touch.goto(vite.resolvedUrls!.local[0]!);await touch.getByRole('button',{name:'Task info',exact:true}).waitFor();
 await touch.evaluate(theme=>{const f=(window as any).fixture;f.setFilesOnly(true);f.setThemePreference(theme==='dark'?'dark':'light')},theme);
 await touch.waitForFunction(()=>document.documentElement.dataset.uiDensity==='touch');
 await touch.getByRole('button',{name:'Task info',exact:true}).tap();await touch.getByRole('dialog').waitFor();
 await touch.waitForFunction(()=>Number(getComputedStyle(document.querySelector('[role=dialog]')!).opacity)>.99);
 const card=await touch.getByRole('dialog').boundingBox();assert(card);assert(card.x>=11&&card.x+card.width<=379);assert(card.y>=0&&card.y+card.height<=833);
 assert((await touch.locator('.thread-summary__file').evaluateAll(rows=>rows.map(row=>row.getBoundingClientRect().height))).every(h=>h>=44));
 await touch.getByRole('button',{name:/Changed files/}).tap();assert.equal(await touch.locator('.thread-summary__file').count(),0);await touch.getByRole('button',{name:/Changed files/}).tap();
 await touch.waitForFunction(()=>!document.querySelector('.thread-summary__section-heading')!.matches(':active'));
 await touch.waitForFunction(()=>getComputedStyle(document.querySelector('.thread-summary__section-heading')!).backgroundColor==='rgba(0, 0, 0, 0)');
 assert.equal(await touch.getByRole('button',{name:/Changed files/}).evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)','touch release has no sticky hover');
 await touch.screenshot({path:output+'/'+theme+'-touch.png'});
 await touch.locator('.thread-summary__file').first().tap();await touch.waitForFunction(()=>!document.querySelector('[role=dialog]'));
 assert.equal(await touch.evaluate(()=>(window as any).opened),'/workspace/project/shell-and-layout.md');
 await touch.setViewportSize({width:1280,height:900});await touch.waitForFunction(()=>document.querySelector('[data-summary-mode=shift]'));
 assert.equal(await touch.locator('aside.conversation-summary').count(),0,'manual dismissal survives the space change');
 await touch.getByRole('button',{name:'Task info',exact:true}).tap();await touch.waitForSelector('aside.conversation-summary');
 await touch.evaluate(()=>(window as any).fixture.setDensity('off'));await touch.waitForFunction(()=>document.documentElement.dataset.uiDensity==='compact');
 assert.equal(await touch.locator('[data-summary-mode=shift]').count(),1,'input preference does not select the space budget');
 await touch.evaluate(()=>(window as any).fixture.setDensity('auto'));await touch.waitForFunction(()=>document.documentElement.dataset.uiDensity==='touch');
 await touch.close();
}
// Observe an interruptible open/close loop on the actual floating consumer.
const rapid=await browser.newPage({viewport:{width:900,height:800}});await rapid.addInitScript(()=>{(window as any).__name=(value:unknown)=>value});await rapid.goto(vite.resolvedUrls!.local[0]!);
const trigger=rapid.getByRole('button',{name:'Task info',exact:true});await trigger.click();await rapid.getByRole('dialog').waitFor();
const motionFrames=[];
for(let i=0;i<4;i++){
 motionFrames.push(await rapid.getByRole('dialog').evaluate(e=>({opacity:Number(getComputedStyle(e).opacity),x:new DOMMatrix(getComputedStyle(e).transform).m41})));
 await rapid.screenshot({path:output+'/motion-'+i+'.png'});
}
assert(motionFrames.some(frame=>frame.x>0),'opening includes a horizontal transition');
await rapid.getByRole('button',{name:'Close',exact:true}).click();
await trigger.click();await rapid.getByRole('dialog').waitFor();
await rapid.waitForFunction(()=>document.querySelectorAll('.conversation-summary').length===1&&getComputedStyle(document.querySelector('.conversation-summary')!).opacity==='1');
assert.equal(await rapid.locator('.conversation-summary[data-summary-present=true]').count(),1);
await rapid.getByLabel('Draft').click();await rapid.waitForFunction(()=>!document.querySelector('[role=dialog]'));
assert.equal(await rapid.getByLabel('Draft').evaluate(e=>e===document.activeElement),true,'outside interaction keeps its new focus');
await rapid.close();
evidence.push({motionFrames,rapidReversal:true,outsideFocusPreserved:true});
const reduced=await browser.newPage({viewport:{width:900,height:800},reducedMotion:'reduce'});await reduced.goto(vite.resolvedUrls!.local[0]!);
await reduced.getByRole('button',{name:'Task info',exact:true}).click();await reduced.getByRole('dialog').waitFor();
assert.equal(await reduced.getByRole('dialog').evaluate(e=>getComputedStyle(e).transform),'none');
await reduced.keyboard.press('Escape');await reduced.waitForFunction(()=>!document.querySelector('[role=dialog]'));await reduced.close();
await writeFile(output+'/result.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify({output,evidence}));
}finally{await browser?.close();await vite.close();}
