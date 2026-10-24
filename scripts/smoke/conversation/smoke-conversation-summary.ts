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
import {ConversationSummaryButton,ConversationSummarySurface,useConversationSummary} from '/apps/workbench-web/src/components/conversation-summary';
import {initializeAppearanceTheme,setThemePreference,setAppearanceThemeId,coreThemeId} from '/apps/workbench-web/src/appearance-theme';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const runtime=await createWorkbenchPanelReactRuntime();const fiber=await runtime.install(ThreadSummaryPlugin);
const timeline={authoritative:true,frames:[{blocks:[{type:'todo',entries:Array.from({length:16},(_,i)=>({id:String(i),text:['Inspect the current workspace','Build the task information module','Verify desktop and mobile layouts'][i%3]+' '+i,status:i<2?'complete':i===2?'in-progress':'pending'}))}, {type:'patch',changes:[{path:'src/features/conversation/components/a-very-long-component-name.tsx',kind:'modify'},{path:'src/styles/task-information.scss',kind:'add'}]},{type:'subagent',id:'agent',label:'Design review',agentId:null,tool:'spawnAgent',status:'complete',activityKind:'started',receiverThreadIds:['child'],agentStates:{child:{status:'running'}},agentPath:null}]}]};
function App(){const[scope,setScope]=useState('account/host/one');const summary=useConversationSummary(scope,true);window.fixture={setScope,setThemePreference,setAppearanceThemeId,coreThemeId,dispose:()=>fiber.dispose(),runtime};
return <WorkbenchPanelRuntimeProvider runtime={runtime}><div style={{height:'100dvh',display:'flex',flexDirection:'column'}}><header style={{height:56,display:'flex',alignItems:'center',justifyContent:'space-between',padding:'0 24px'}}><span>Workspace / Task information</span><ConversationSummaryButton controller={summary}/></header><div className='local-conversation-page' style={{flex:1,minHeight:0}}><div ref={summary.layoutRef} className='conversation-summary-layout' data-summary-open={summary.wide&&summary.open}><div className='conversation-summary-reading'><div style={{maxWidth:720,margin:'auto',padding:'32px 24px'}}><h1>Build a task information panel</h1><p>Keep progress, files and activity close to the conversation.</p><textarea aria-label='Draft' defaultValue='Preserve this draft' style={{width:'100%',marginTop:48}}/></div></div><ConversationSummarySurface controller={summary} context={{scopeKey:scope,timeline,goal:{objective:'Make ongoing work easy to follow, on desktop and on the phone.',status:'active'},current:scope!=='cached',onOpenResource:path=>window.opened=path,onOpenThread:id=>window.opened=id}}/></div></div></div></WorkbenchPanelRuntimeProvider>}
function Root(){return <WorkbenchPanelRuntimeProvider runtime={runtime}><App/></WorkbenchPanelRuntimeProvider>}
createIntlTestRoot(document.getElementById('root')).render(<Root/>);`;
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',resolve:{dedupe:['react','react-dom','react-intl']},esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[react(),{name:'summary-fixture',resolveId:id=>id==='/summary-fixture.tsx'?id:null,load:id=>id==='/summary-fixture.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/summary-fixture.tsx"></script>')})}}]});
let browser:any;
try {
await vite.listen();const {chromium}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');browser=await chromium.launch({headless:true});
const evidence=[];
for(const theme of ['light','dark','lavender']) {
 const page=await browser.newPage({viewport:{width:1440,height:900}});const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));
 let releaseSheet: (() => void) | undefined;
 let importArrived: () => void;
 let importTimeout: ReturnType<typeof setTimeout>;
 const sheetImport=new Promise<void>((resolve,reject)=>{importTimeout=setTimeout(()=>reject(new Error('Sheet import was not requested')),30_000);importArrived=()=>{clearTimeout(importTimeout);resolve()};});
 await page.route('**/modal/adaptive-sheet-handle*',async route=>{await new Promise<void>(resolve=>{releaseSheet=resolve;importArrived()});await route.continue();});
 await page.goto(vite.resolvedUrls!.local[0]!); await page.waitForSelector('.thread-summary__section');
 await page.evaluate(theme=>{(window as any).fixture.setThemePreference(theme==='dark'?'dark':'light');(window as any).fixture.setAppearanceThemeId(theme==='lavender'?'opencraft.core.lavender':(window as any).fixture.coreThemeId)},theme);
 const draft=await page.locator('textarea').elementHandle();
 assert.equal(await page.locator('aside.conversation-summary').count(),1);
 await page.getByRole('button',{name:/Plan/}).click();
 await page.screenshot({path:output+'/'+theme+'-desktop.png'});
 await page.setViewportSize({width:390,height:844}); await page.waitForFunction(()=>!document.querySelector('aside.conversation-summary'));
 await page.getByRole('button',{name:'Task info',exact:true}).click();
 await sheetImport;
 try { assert.equal(await page.getByRole('dialog').count(),0,'sheet cannot paint without its presentation styles'); }
 finally { releaseSheet?.(); }
 await page.getByRole('dialog').waitFor();
 await page.waitForFunction(()=>{const r=document.querySelector('[role=dialog]')?.getBoundingClientRect();return r&&Math.abs(r.bottom-innerHeight)<1});
 const sheet=await page.getByRole('dialog').boundingBox();assert(sheet);assert(Math.abs(sheet.width-390)<1);assert(Math.abs(sheet.x)<1);assert(Math.abs(sheet.y+sheet.height-844)<1);
 assert.equal(await page.getByRole('button',{name:/Plan/}).getAttribute('aria-expanded'),'false');
 await page.getByRole('button',{name:/Plan/}).click();
 await page.locator('.thread-summary__scroll').evaluate(e=>e.scrollTop=160);
 await page.waitForFunction(()=>document.querySelector('.thread-summary__scroll')!.scrollTop>=150);
 await page.screenshot({path:output+'/'+theme+'-mobile.png',animations:'disabled'});
 await page.keyboard.press('Escape'); await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));
 assert.equal(await page.getByRole('button',{name:'Task info',exact:true}).evaluate(e=>e===document.activeElement),true);
 await page.getByRole('button',{name:'Task info',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.thread-summary__scroll')!.scrollTop>=150);
 await page.setViewportSize({width:1440,height:900}); await page.waitForSelector('aside.conversation-summary');
 assert.equal(await page.locator('textarea').inputValue(),'Preserve this draft');
 assert.equal(await draft!.evaluate(e=>e===document.querySelector('textarea')),true);
 await page.evaluate(()=>(window as any).fixture.setScope('cached'));
 assert.equal(await page.locator('.thread-summary__link:not(:disabled)').count(),0);
 await page.evaluate(()=>(window as any).fixture.setScope('account/host/two'));
 await page.waitForFunction(()=>document.querySelector('.thread-summary__scroll')!.scrollTop===0);
 assert.equal(await page.getByRole('button',{name:/Plan/}).getAttribute('aria-expanded'),'true');
 await page.evaluate(()=>(window as any).fixture.dispose());
 await page.waitForFunction(()=>!document.querySelector('.conversation-summary-trigger'));
 assert.equal(await page.locator('.conversation-summary').count(),0);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.deepEqual(errors,[]);evidence.push({theme,desktop:1440,mobile:390,errors});await page.close();
}
await writeFile(output+'/result.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify({output,evidence}));
}finally{await browser?.close();await vite.close();}
