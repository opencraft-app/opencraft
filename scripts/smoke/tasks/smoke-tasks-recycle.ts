import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {TasksService} from "../../../plugins/tasks/src/server";
import {TASKS} from '@opencraft/appserver-protocol';
const output=await mkdtemp(join(tmpdir(),'tasks-recycle-'));
const service=new TasksService(join(output,'tasks.sqlite'));
const source=`
import React from 'react';import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createTasksView} from '/plugins/tasks/src/view.tsx';
import {initializeAppearanceTheme} from '/apps/workbench-web/src/appearance-theme.ts';
import {AsyncNoticesProvider,useAsyncNotices} from '/apps/workbench-web/src/components/async-notices.tsx';
import '/apps/workbench-web/src/styles/app.scss';initializeAppearanceTheme();
const request=async(_,method,params)=>{const res=await fetch('/rpc',{method:'POST',body:JSON.stringify({method,params})});const result=await res.json();if(result.error)throw Object.assign(new Error(result.error.message),result.error);return result.value};
const ports={storageHostId:'local',request,listThreads:async()=>[],listProjects:async()=>[],readConversation:async()=>({title:'Linked conversation',state:'idle'}),subscribe:()=>()=>{}};
const View=createTasksView(ports,new AbortController().signal);
const host={platform:'web',activeHostId:'local',profiles:[{hostId:'local',hostKind:'local',displayName:'Local',enabled:true}],openView(){},pushViewResource(){},replaceViewResource(){},openConversation(){},provisionHost:async()=>{},removeHost:async()=>false};
function App(){const notices=useAsyncNotices();return <View host={host} contribution={{id:'tasks'}} activation={{viewId:'tasks',resourceUri:null}} reportError={notices.error}/>}
createIntlTestRoot(document.getElementById('root')).render(<AsyncNoticesProvider><App/></AsyncNoticesProvider>);`;
let failRestore=false;
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',resolve:{dedupe:['react','react-dom']},esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'fixture',resolveId:id=>id==='/fixture.tsx'?id:null,load:id=>id==='/fixture.tsx'?source:null,configureServer(server){server.middlewares.use(async(req,res,next)=>{
if(req.url==='/rpc'){try{let body='';for await(const chunk of req)body+=chunk;const {method,params}=JSON.parse(body);if(failRestore&&method===TASKS.restore)throw new Error('Simulated unavailable authority');res.setHeader('content-type','application/json');res.end(JSON.stringify({value:service.handle(method,params)}));}catch(e:any){res.setHeader('content-type','application/json');res.end(JSON.stringify({error:{code:e.code,message:'Request failed'}}));}return;}
if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script type="module" src="/fixture.tsx"></script>');})}}]});
let browser:any;
try{await vite.listen();const pw=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');const {chromium}=pw.default??pw;browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
for(const width of [1200,390])for(const theme of ['light','dark']){
const id=`task-${width}-${theme}`,title=`Recover ${width} ${theme}`;
service.handle(TASKS.create,{id,title,description:'Complete original description\nAcceptance criteria retained',status:'todo',projectServerId:null,projectId:null});service.handle(TASKS.attach,{id,expectedRevision:1,serverId:'local',threadId:'linked'});
const page=await browser.newPage({viewport:{width,height:850}});const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));await page.addInitScript('window.__name=v=>v');await page.goto('http://127.0.0.1:'+(vite.httpServer!.address() as any).port);await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
await page.getByRole('button',{name:title,exact:true}).click();
const research=page.locator('.tasks-editor').getByRole('combobox',{name:'AI research',exact:true});
assert.equal(await research.inputValue(),'unassessed');
await research.selectOption('proactive');
await page.getByRole('textbox',{name:'Rationale / missing information',exact:true}).fill('Repository and task context support a first read-only investigation.');
await page.locator('.tasks-editor').getByRole('button',{name:'Save',exact:true}).filter({visible:true}).click();
await page.waitForFunction(()=>!document.querySelector('.tasks-editor [aria-busy="true"]'));
await page.waitForFunction(id=>document.querySelector('[data-task-id="'+id+'"] .tasks-research')?.getAttribute('data-research')==='proactive',id);
const assessed=service.handle(TASKS.read,{id}) as any;assert.equal(assessed.aiResearch,'proactive');assert.equal(assessed.status,'todo');assert.equal(assessed.conversations.length,1);
await page.screenshot({path:join(output,`research-${theme}-${width}.png`)});
await page.keyboard.press('Escape');
await page.getByRole('button',{name:'Filters',exact:true}).click();
await page.getByRole('combobox',{name:'AI research',exact:true}).selectOption('needs_context');
assert.equal(await page.locator('.tasks-card').count(),0);
await page.getByRole('button',{name:'Clear filters',exact:true}).click();
await page.getByRole('button',{name:title,exact:true}).click();
assert.equal(await research.inputValue(),'proactive');
await page.locator('.tasks-activity li').filter({hasText:'AI research、Rationale / missing information'}).waitFor({state:'attached'});
const description=page.getByRole('textbox',{name:'Description',exact:true});const compactHeight=await description.evaluate(e=>e.getBoundingClientRect().height);await description.evaluate(e=>e.dataset.originalNode='true');await page.getByRole('button',{name:'Expand',exact:true}).click();assert.ok(await description.evaluate(e=>e.getBoundingClientRect().height)>compactHeight);assert.equal(await description.getAttribute('data-original-node'),'true');await page.getByRole('button',{name:'Collapse',exact:true}).click();assert.equal(await description.evaluate(e=>e.getBoundingClientRect().height),compactHeight);
await page.getByRole('button',{name:'Delete task',exact:true}).click();await page.getByRole('button',{name:'More actions',exact:true}).click();await page.getByRole('menuitem',{name:'Recycle bin',exact:true}).click();const restore=page.getByRole('button',{name:'Restore '+title,exact:true});await restore.waitFor();await page.getByText('Description',{exact:true}).click();await page.getByText('Complete original description',{exact:false}).waitFor();await page.reload();await page.getByRole('button',{name:'More actions',exact:true}).click();await page.getByRole('menuitem',{name:'Recycle bin',exact:true}).click();await restore.waitFor();
// Failure uses the actual non-blocking notification provider and keeps rows stable.
const row=page.locator('.tasks-recycle__row').filter({has:restore});await page.screenshot({path:join(output,`recycle-${theme}-${width}.png`)});const before=await row.boundingBox();failRestore=true;await restore.click();await page.locator('[data-sonner-toast]').waitFor();await page.waitForFunction(()=>!document.querySelector('.tasks-recycle__row button:disabled'));assert.deepEqual(await row.boundingBox(),before);assert.equal(await page.locator('.tasks-recycle .settings-control-notice').count(),0);failRestore=false;
await restore.click();await restore.waitFor({state:'hidden'});await page.getByRole('button',{name:'Back to tasks',exact:true}).click();await page.getByRole('button',{name:title,exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'Description',exact:true}).inputValue(),'Complete original description\nAcceptance criteria retained');await page.locator('.tasks-link > span').filter({hasText:'Linked conversation'}).waitFor();await page.screenshot({path:join(output,`${theme}-${width}.png`)});assert.deepEqual(errors,[]);await page.close();}
console.log(JSON.stringify({passed:true,output}));}finally{await browser?.close();await vite.close();service.close();}
