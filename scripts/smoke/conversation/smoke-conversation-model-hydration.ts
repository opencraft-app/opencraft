import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { createWorkbenchWebConfig } from "../../../apps/workbench-web/vite.config";
const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? 'playwright');
const { chromium } = playwright.default ?? playwright;
// Only Host/account I/O is synthetic. Query lifecycle, catalog hook, model
// projection, Composer controller, editor and picker are production code.
const source = `import React,{useState} from 'react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createComposerController} from '@opencraft/composer-core';
import {OpenCraftComposer} from '@opencraft/composer-editor';
import {projectComposerModelChoices} from '@opencraft/workbench-runtime';
import {OPENCRAFT_SCOPED_MODEL_CATALOG_EXTENSION} from '@opencraft/appserver-protocol';
import {ApplicationRuntimeContext,ConversationViewRuntimeContext,useComposerCatalog} from '/apps/workbench-web/src/runtime/appserver-runtime-context.tsx';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const noop=()=>()=>{},client=new QueryClient(),pending=new Map(),calls=[],counts={defaults:0,account:0};
const model=(id,name)=>({id,model:id,displayName:name,isDefault:true,hidden:false,description:'',defaultReasoningEffort:'low',supportedReasoningEfforts:['low','medium','high'].map(reasoningEffort=>({reasoningEffort,description:''})),serviceTiers:[{id:'fast',name:'Fast',description:''},{id:'priority',name:'FAST',description:'Host-specific fast tier'}]});
const alpha=model('alpha','Alpha model'),beta=model('beta','Beta model');
const account={id:'fixture-account',subscribe:noop,getSnapshot:()=>({readStateScope:'fixture',phase:'ready'}),modelDefaults:{read:async()=>{counts.account++;return {revision:0,selection:{model:'wrong',effort:'low'}}}}};
const application={threadAttention:{subscribe:noop,getScope:()=> 'fixture'},displayContinuity:{subscribe:noop,getScope:()=> 'fixture'},platformAccounts:{subscribe:noop,getSnapshot:()=>accountSnapshot}};
const accountSnapshot={contribution:account},hostSnapshot={hostId:'fixture',phase:'ready'};
const runtime={subscribe:noop,getSnapshot:()=>hostSnapshot,resources:{host:{getInitializeResult:()=>({capabilities:{extensions:{[OPENCRAFT_SCOPED_MODEL_CATALOG_EXTENSION]:{}}}})},composerCatalog:{listModels:params=>{calls.push(params);return new Promise((resolve,reject)=>pending.set(params.threadId+':'+params.cursor,{resolve,reject}))},listPermissionProfiles:async()=>({data:[]}),readNewThreadDefaults:async()=>{counts.defaults++;return {model:'wrong',effort:'low'}}}}};
const controllers=new Map();function controller(id){if(!controllers.has(id))controllers.set(id,createComposerController({type:'existing-thread',key:{hostId:'fixture',threadId:id}},{now:Date.now,createId:()=>crypto.randomUUID()}));return controllers.get(id)}
const selections={a:{model:'alpha',effort:'high',serviceTier:'fast'},b:{model:'alpha',effort:'medium'},c:{model:'beta',effort:null},unknown:{}};
window.fixture={calls,counts,client,alpha,beta,pending,theme:setThemePreference,intents:[],resolve:(key,data,nextCursor=null)=>pending.get(key).resolve({data,nextCursor}),reject:key=>pending.get(key).reject(Error('offline')),controller};
function Catalog({id}){const [readOnly,setReadOnly]=useState(false);window.fixture.setReadOnly=setReadOnly;const [effectiveTier,setEffectiveTier]=useState(undefined);window.fixture.setEffectiveTier=setEffectiveTier;const catalog=useComposerCatalog('/fixture',id);window.fixture.catalog=catalog;return <OpenCraftComposer controller={controller(id)} modelDisplayOnly={readOnly} shortcutCommands={[{name:'side',description:'Open side chat'}]} effectiveSelections={effectiveTier===undefined?selections[id]:{...selections[id],serviceTier:effectiveTier}} selectionCatalog={{models:projectComposerModelChoices(catalog.models),displayModels:projectComposerModelChoices(catalog.displayModels),permissionProfiles:[],isFetching:catalog.isFetching,modelError:catalog.modelError?.message}} onSubmit={intent=>{window.fixture.intents.push(intent);return false}} onCancel={()=>{}}/>}
function App(){const [id,setId]=useState('a');window.fixture.switch=setId;return <QueryClientProvider client={client}><ApplicationRuntimeContext.Provider value={application}><ConversationViewRuntimeContext.Provider value={{runtime}}><main style={{padding:24,paddingTop:220,maxWidth:800}} data-thread={id}><Catalog id={id}/></main></ConversationViewRuntimeContext.Provider></ApplicationRuntimeContext.Provider></QueryClientProvider>}
createIntlTestRoot(document.getElementById('root')).render(<App/>);`;
const optimizeDeps = createWorkbenchWebConfig({mode:'development',command:'serve'},{pluginBranding:false}).optimizeDeps;
const vite = await createServer({configFile:false,root:process.cwd(),logLevel:'error',cacheDir:'node_modules/.vite-model-hydration',optimizeDeps:{...optimizeDeps,entries:[]},resolve:{dedupe:['react','react-dom']},esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{
  name:'conversation-model-fixture',
  resolveId:id=>id==='/model-hydration.tsx'?id:null,load:id=>id==='/model-hydration.tsx'?source:null,
  transform(code,id){if(id.endsWith('/runtime/appserver-runtime-context.tsx'))return code+'\nexport {ApplicationRuntimeContext,ConversationViewRuntimeContext};';},
  configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/model-hydration.tsx"></script>');});},
}]});
await vite.listen();await mkdir('.local/model-hydration',{recursive:true});
const browser=await chromium.launch({executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});const results=[];
try{
 for(const touch of [false,true]){
  const context=await browser.newContext({viewport:{width:touch?390:1280,height:844},isMobile:touch,hasTouch:touch});const page=await context.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript('window.__name=v=>v');page.setDefaultTimeout(20000);
  await page.goto(vite.resolvedUrls!.local[0],{timeout:120000});const trigger=page.locator('.opencraft-composer-mode--intelligence'),editor=page.locator('.opencraft-composer-editor');await editor.waitFor({timeout:120000});
  const text=()=>trigger.innerText();const switchTo=async(id:string)=>{await page.evaluate(id=>(window as any).fixture.switch(id),id);await page.waitForFunction(id=>document.querySelector('main')?.dataset.thread===id,id)};
  assert.match(await text(),/High/,'cold execution effort paints before directory');assert.doesNotMatch(await text(),/Light/);assert.equal(await trigger.locator('.opencraft-composer-mode__fast').count(),1,'known Fast paints before directory');
  await editor.fill('Draft A');await page.getByRole('button',{name:'Send message',exact:true}).click();await page.waitForFunction(()=>(window as any).fixture.intents.length===1);assert.equal(await page.evaluate(()=>(window as any).fixture.intents[0].selections.serviceTier),'fast','pending directory cannot silently turn Fast off on submit');await page.evaluate(()=>(window as any).fixture.resolve('a:null',[(window as any).fixture.alpha],'second'));
  await page.waitForFunction(()=>(window as any).fixture.pending.has('a:second'));assert.equal(await page.evaluate(()=>(window as any).fixture.catalog.models.length),0,'partial pages do not become selectable');assert.match(await text(),/High/);
  await page.evaluate(()=>(window as any).fixture.resolve('a:second',[(window as any).fixture.beta]));await page.waitForFunction(()=>document.querySelector('.opencraft-composer-mode__model-label')?.textContent==='Alpha model');
  await switchTo('b');assert.match(await text(),/Alpha model/,'same Host metadata paints immediately');assert.match(await text(),/Medium/,'current conversation effort, not A effort');assert.equal(await trigger.locator('.opencraft-composer-mode__fast').count(),0);
  assert.equal(await page.evaluate(()=>(window as any).fixture.catalog.models.length),0,'B choices remain scoped');
  if(touch)await trigger.tap();else await trigger.click();assert.equal(await page.locator('[role=slider]').count(),0,'display metadata cannot enable effort choices');await page.keyboard.press('Escape');
  await switchTo('c');assert.match(await text(),/Beta model/);assert.doesNotMatch(await text(),/Light|High|Medium/,'unknown effort stays unset even with cached model default');
  await page.evaluate(()=>(window as any).fixture.resolve('c:null',[(window as any).fixture.beta]));await page.waitForFunction(()=>(window as any).fixture.catalog.models.length===1);assert.doesNotMatch(await text(),/Light/,'loaded directory cannot invent effort');
  await editor.fill('Draft C');await page.getByRole('button',{name:'Send message',exact:true}).click();await page.waitForFunction(()=>(window as any).fixture.intents.length===2);assert.equal(await page.evaluate(()=>(window as any).fixture.intents[1].selections.effort),undefined,'unknown effort stays inherited on submit');await switchTo('unknown');assert.doesNotMatch(await text(),/Alpha|Beta|Light|Medium|High/,'unknown conversation never borrows a default');
  await page.evaluate(()=>(window as any).fixture.resolve('b:null',[(window as any).fixture.alpha]));await page.waitForTimeout(50);assert.doesNotMatch(await text(),/Alpha|Light|Medium/,'late B response cannot replace current conversation');
  await page.evaluate(()=>(window as any).fixture.reject('unknown:null'));await page.waitForFunction(()=>(window as any).fixture.catalog.modelError!==null);assert.doesNotMatch(await text(),/Alpha|Light/);
  await switchTo('a');assert.match(await text(),/Alpha model/);assert.match(await text(),/High/);assert.equal(await editor.innerText(),'Draft A','retained conversation draft survives switching');
  await page.evaluate(()=>(window as any).fixture.controller('a').dispatch({type:'set-selections',patch:{effort:'medium',serviceTier:null}}));await page.waitForFunction(()=>document.querySelector('.opencraft-composer-mode__effort-label')?.textContent==='Medium');assert.equal(await trigger.locator('.opencraft-composer-mode__fast').count(),0,'local explicit Fast off wins');
  await page.evaluate(()=>(window as any).fixture.controller('a').dispatch({type:'set-selections',patch:{model:'beta',effort:undefined}}));await page.waitForFunction(()=>document.querySelector('.opencraft-composer-mode__model-label')?.textContent==='Beta model');assert.doesNotMatch(await text(),/High|Medium|Light/,'explicit model with unset effort cannot inherit the previous model effort');
  assert.equal(await page.locator('.opencraft-composer-shortcut-trigger').count(),0,'slash commands do not restore a separate footer menu');
  await page.evaluate(()=>{const f=(window as any).fixture;f.controller('a').dispatch({type:'set-selections',patch:{model:'beta',effort:'low',serviceTier:null}});f.setReadOnly(true)});
  const inherited=page.locator('.opencraft-composer-mode--inherited');await inherited.waitFor();assert.match(await inherited.innerText(),/Alpha model/);assert.match(await inherited.innerText(),/High/,'inherited effort ignores stale draft choices');assert.equal(await inherited.locator('.opencraft-composer-mode__fast').count(),1,'inherited Fast ignores stale explicit off');assert.equal(await page.locator('.opencraft-composer-model-quick').count(),0);
  await editor.fill('Side chat draft');await page.getByRole('button',{name:'Send message',exact:true}).click();await page.waitForFunction(()=>(window as any).fixture.intents.length===3);const inheritedIntent=await page.evaluate(()=>(window as any).fixture.intents[2].selections);assert.equal(inheritedIntent.model,undefined);assert.equal(inheritedIntent.effort,undefined);assert.equal(inheritedIntent.serviceTier,undefined);
  await switchTo('unknown');assert.doesNotMatch(await inherited.innerText(),/Alpha|Beta|High|Medium|Low/);assert.equal(await inherited.locator('.opencraft-composer-mode__fast').count(),0,'unknown inherited metadata cannot invent Fast');await switchTo('a');assert.match(await inherited.innerText(),/Alpha model/);assert.equal(await editor.innerText(),'Side chat draft');
  // Side Chat presents the execution snapshot read-only. Its idle touch row
  // hides the metadata group, so the shared collapsed slot must retain Fast.
  await page.evaluate(touch=>{document.documentElement.dataset.uiDensity=touch?'touch':'compact';document.documentElement.dataset.touchNewera='on';(window as any).fixture.setReadOnly(true)},touch);
  const editorNode=await editor.elementHandle();
  const visibleFast=()=>page.locator('[aria-label="Fast"]:visible');
  const assertFilled=async()=>{assert.equal(await visibleFast().count(),1,'exactly one visible execution Fast status');assert.notEqual(await visibleFast().locator('path').evaluate(el=>getComputedStyle(el).fill),'none','active Fast uses the shared filled glyph')};
  for(const theme of ['light','dark']){
   await page.evaluate(theme=>(window as any).fixture.theme(theme),theme);await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);
   await editor.fill('Side draft');if(touch)await editor.tap();else await editor.click();
   // Host tier IDs are opaque. Inherited status uses the same selected-tier
   // metadata as the editable picker, while stale draft intent stays powerless.
   await page.evaluate(()=>(window as any).fixture.controller('a').dispatch({type:'set-selections',patch:{serviceTier:'fast'}}));
   await page.evaluate(()=>(window as any).fixture.setEffectiveTier('priority'));
   await page.screenshot({path:'.local/model-hydration/'+(touch?'touch':'desktop')+'-readonly-host-fast-'+theme+'.png'});
   assert.equal(await visibleFast().count(),1,'Host tier priority named FAST retains inherited Fast status');await assertFilled();
   assert.equal(await editorNode!.evaluate(el=>el===document.querySelector('.opencraft-composer-editor')),true);
   assert.equal(await editor.innerText(),'Side draft','Host metadata changes retain the draft');
   await page.evaluate(()=>(window as any).fixture.setEffectiveTier(null));
   assert.equal(await visibleFast().count(),0,'a stale local Fast choice cannot override the effective off snapshot');
   await page.evaluate(()=>(window as any).fixture.setEffectiveTier('fast'));
   await inherited.waitFor({state:'visible'});assert.match(await inherited.innerText(),/Alpha model/,'read-only model follows execution, not stale local override');assert.match(await inherited.innerText(),/High/);assert.equal(await page.locator('.opencraft-composer-mode--intelligence').count(),0,'read-only status never opens a model picker');await assertFilled();
   await editor.fill('');if(touch)await page.locator('main').tap({position:{x:5,y:5}});else await page.locator('main').click({position:{x:5,y:5}});
   await page.waitForFunction(()=>{const el=document.querySelector('.opencraft-composer-stack') as HTMLElement;return el.dataset.composerEmpty==='true'&&el.dataset.composerEditing==='false'});await assertFilled();assert.equal(await editorNode!.evaluate(el=>el===document.querySelector('.opencraft-composer-editor')),true,'folding keeps the original editor');
   assert.equal(await page.locator('.opencraft-composer-collapsed-fast').isVisible(),touch,'the compact Fast slot only replaces metadata in the touch idle layout');
   await page.screenshot({path:'.local/model-hydration/'+(touch?'touch':'desktop')+'-readonly-idle-'+theme+'.png'});
  }
  await editor.fill('Side draft');if(touch)await editor.tap();else await editor.click();const before=await page.evaluate(()=>(window as any).fixture.intents.length);await page.getByRole('button',{name:'Send message',exact:true}).click();await page.waitForFunction(before=>(window as any).fixture.intents.length===before+1,before);assert.deepEqual(await page.evaluate(()=>(window as any).fixture.intents.at(-1).selections),{},'read-only submit strips stale selection overrides');assert.equal(await editor.innerText(),'Side draft','rejected submit retains the draft');
  const counts=await page.evaluate(()=>(window as any).fixture.counts);assert.deepEqual(counts,{defaults:0,account:0},'historical views never request new conversation defaults');assert.deepEqual(errors,[]);await page.screenshot({path:'.local/model-hydration/'+(touch?'touch':'desktop')+'.png'});results.push({touch,counts,passed:true});await context.close();
 }
 await writeFile('.local/model-hydration/results.json',JSON.stringify(results,null,2));console.log('PASS real catalog hook and Composer: cold/partial/error/late loads, A/B scopes, retained draft, unknown effort, Fast, desktop and touch');
}finally{await browser.close();await vite.close();}
