import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import WebSocket from 'ws';
import {WebSocketTransport,type AppServerWebSocket} from '@opencraft/appserver-transport-websocket';
import {createAppServerWorkbenchRuntime} from '@opencraft/workbench-runtime';
import {createConversationKey} from '@opencraft/chat-core';
import {startLocalAgentHost} from '../apps/local-agent-host/src/main';
import {DshClient} from '../apps/local-agent-host/src/dsh-client';
import {ModelConfigurationRepository,ModelCredentialRepository} from '../apps/local-agent-host/src/model-config/repository';

const root=await mkdtemp(join(tmpdir(),'opencraft-reasoning-contract-'));
let receivedResolve!:()=>void;
const received=new Promise<void>(r=>{receivedResolve=r});
const requests:Record<string,unknown>[]=[];
let browserToolStep=0;
let browserToolResultSeen=false;
let browserInspected=false;
function findBrowserTab(value:any):string|undefined{
 if(typeof value==='string'){try{return findBrowserTab(JSON.parse(value));}catch{return undefined;}}
 if(!value||typeof value!=='object')return undefined;
 if(typeof value.tabId==='string')return value.tabId;
 for(const child of Object.values(value).reverse()){const found=findBrowserTab(child);if(found)return found;}
 return undefined;
}
const endpoint=createServer(async(req,res)=>{
 if(req.url==='/browser-fixture'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>DSH Browser Fixture</title><h1>DSH browser bridge verified</h1>');return;}
 const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(chunks).toString());requests.push(body);
 const base={id:'fixture',object:'chat.completion.chunk',created:1,model:'plain-model'};
 if(body.stream && JSON.stringify(body.messages).includes('BROWSER_BRIDGE_TEST') && Array.isArray(body.tools)&&body.tools.length){
   const messages=JSON.stringify(body.messages);
   if(messages.includes('panelTabId')&&messages.includes('opened'))browserToolResultSeen=true;
   browserToolStep++;
   if(browserToolStep>4)browserInspected=messages.includes('revision')&&messages.includes('DSH browser bridge verified');
   const tool=browserToolStep===1?'open_in_vela':browserToolStep<=4?'browser_use':null;
   if(tool)assert.ok(body.tools.some((entry:any)=>entry.function?.name===tool),tool+' advertised to actual model');
   const tab=findBrowserTab(body.messages);
   const args=browserToolStep===1?{url:`http://127.0.0.1:${(endpoint.address() as {port:number}).port}/browser-fixture`,placement:'right'}
     :browserToolStep===2?{action:'list_tabs'}
     :browserToolStep===3?{action:'wait',tab_id:tab,text:'DSH browser bridge verified',timeout_ms:5000}
     :{action:'inspect',tab_id:tab};
   const delta=tool?{role:'assistant',tool_calls:[{index:0,id:'browser-call-'+browserToolStep,type:'function',function:{name:tool,arguments:JSON.stringify(args)}}]}:{role:'assistant',content:'BROWSER_BRIDGE_DONE'};
   const chunk=(delta:unknown,finish:string|null=null)=>`data: ${JSON.stringify({...base,choices:[{index:0,delta,finish_reason:finish}]})}\n\n`;
   res.setHeader('Content-Type','text/event-stream');res.end(chunk(delta)+chunk({},tool?'tool_calls':'stop')+'data: [DONE]\n\n');return;
 }
 if(body.stream){res.setHeader('Content-Type','text/event-stream');res.end(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',content:'OK'},finish_reason:null}]})}\n\ndata: ${JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}\n\ndata: [DONE]\n\n`)}
 else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...base,object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:'OK'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}))}
 receivedResolve();
});
let host:Awaited<ReturnType<typeof startLocalAgentHost>>|undefined;
let runtime:ReturnType<typeof createAppServerWorkbenchRuntime>|undefined;
let uiServer:any;
let browser:any;
try{
 await new Promise<void>(r=>endpoint.listen(0,'127.0.0.1',r));const port=(endpoint.address() as {port:number}).port;
 const directory=join(root,'product'),repository=new ModelConfigurationRepository(directory),credentials=new ModelCredentialRepository(directory);
 await credentials.set('TEST_KEY','synthetic-key');
 await repository.initialize({schemaVersion:1,revision:0,providers:[{id:'plain-provider',name:'Plain model',protocol:'openai-completions',baseUrl:`http://127.0.0.1:${port}/v1`,credentialRef:'TEST_KEY',enabled:true,models:[{id:'plain-model',enabled:true}]}],defaultModel:{providerId:'plain-provider',modelId:'plain-model'}});
 host=await startLocalAgentHost({dataDirectory:join(root,'runtime'),modelStorageDirectory:directory,dshExecutable:resolve('runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')});
 runtime=createAppServerWorkbenchRuntime({hostId:'reasoning-test',autoReconnect:false,transport:new WebSocketTransport({url:host.websocketUrl,createSocket:url=>new WebSocket(url) as unknown as AppServerWebSocket})});
 await runtime.connect();
 const catalog=await runtime.resources.composerCatalog.listModels();const model=catalog.data.find(m=>m.displayName==='plain-model')!;assert.ok(model);assert.equal(model.defaultReasoningEffort,null);assert.deepEqual(model.supportedReasoningEfforts,[]);
 const permissionCatalog=await runtime.resources.composerCatalog.listPermissionProfiles();
 const creationPermission=(permissionCatalog.data as any[]).find(profile=>profile.openCraftMode==='accept-edits');
 assert.ok(creationPermission,`DSH Host must advertise a verified workspace preset: ${JSON.stringify((permissionCatalog.data as any[]).map(profile=>({id:profile.id,mode:profile.mode,approval:profile.approval,sandboxMode:profile.sandbox?.mode,openCraftMode:profile.openCraftMode})))}`);
 const thread=await runtime.resources.threads.start({cwd:root,model:model.model,permissions:creationPermission.id});
 const initialPermissionHistory=await new DshClient(host.dshUrl).call<any>('session.history',{sessionId:thread.id,maxMessages:100});
 assert.equal(initialPermissionHistory.events.filter((entry:any)=>entry.event.type==='permission/preset').at(-1)?.event.data.preset,creationPermission.openCraftNativeProfileId);
 // Exercise recovery from a legacy caller. The engine may reject the invalid
 // selection immediately, or retain it until call validation; neither may
 // cause the next correctly compiled request to inherit an invalid effort.
 await new DshClient(host.dshUrl).call('session.selectModel',{sessionId:thread.id,provider:'plain-provider',model:'plain-model',reasoningEffort:'none'}).catch(()=>undefined);
 const lease=await runtime.acquireThread(thread.id);
 await lease.submit({commandId:'reasoning-regression',clientMessageId:'reasoning-message',target:{type:'existing-thread',key:createConversationKey('reasoning-test',thread.id)},document:{version:1,blocks:[{type:'paragraph',children:[{type:'text',text:'Reply OK only.'}]}]},attachments:[],context:[],selections:{model:model.model,effort:'none'},options:{autoContext:false},createdAt:Date.now()});
 await Promise.race([received,new Promise((_,reject)=>setTimeout(()=>reject(Error('No model request')),10000))]);
 assert.ok(requests.length>0);for(const body of requests){assert.equal(Object.hasOwn(body,'reasoning_effort'),false);assert.equal(Object.hasOwn(body,'reasoningEffort'),false);}
 const deadline=Date.now()+10000;
 while(Date.now()<deadline){
   const state=lease.getSnapshot();
   if(state.timeline.frames.some(frame=>frame.type==='assistant' && frame.status==='complete'))break;
   await new Promise(resolve=>setTimeout(resolve,20));
 }
 const completedFrames=lease.getSnapshot().timeline.frames;
 assert.ok(completedFrames.some(frame=>frame.type==='user'),'completion must retain the user message');
 assert.ok(completedFrames.some(frame=>frame.type==='assistant' && frame.status==='complete'),`completion must retain assistant output: ${JSON.stringify(completedFrames.map(frame=>({type:frame.type,status:frame.status})))}`);
 lease.release();
 if(process.env.OPENCRAFT_DSH_UI_SMOKE==='1'){
   process.env.VITE_HYPERNODE_PLUGIN='disabled';
   process.env.VITE_APPSERVER_HOSTS_JSON=JSON.stringify([{hostId:'reasoning-test',label:'Synthetic DSH',kind:'local',url:host.websocketUrl}]);
   const {build,preview}=await import('vite');
   const config={root:resolve('apps/workbench-web'),configFile:resolve('apps/workbench-web/vite.config.ts'),build:{outDir:join(root,'web'),emptyOutDir:true},logLevel:'error' as const};
   await build(config);
   const served=await preview({...config,preview:{host:'127.0.0.1',port:0}});
   uiServer={httpServer:served.httpServer,close:()=>new Promise<void>(resolve=>served.httpServer.close(()=>resolve()))};
   const {chromium}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');
   browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
   const page=await browser.newPage({viewport:{width:1300,height:900}});
   const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));
   page.on('console',(message:any)=>{if(message.type()==='error'&&message.text().includes('[opencraft runtime error]'))errors.push(message.text());});
   await page.goto(`http://127.0.0.1:${uiServer.httpServer.address().port}/local/${thread.id}?hostId=reasoning-test`);
   await page.getByText('OK',{exact:true}).first().waitFor({timeout:30000});
   const editor=page.locator('.codex-composer-editor').first();
   const observed=await runtime.acquireThread(thread.id);
   const profileCatalog=await runtime.resources.composerCatalog.listPermissionProfiles();
   const selectedProfile=profileCatalog.data.find((profile:any)=>/full|danger/i.test(profile.id))??profileCatalog.data.at(-1);
   assert.ok(selectedProfile);
   await page.locator('.codex-composer-mode--permissions').first().click();
   const permissionMenu=page.locator('.codex-composer-selection-menu--permissions[role="menu"]');
   assert.doesNotMatch(await permissionMenu.innerText(),/AppServer default|How should OpenCraft actions be approved/);
   assert.equal(await permissionMenu.getByRole('menuitem').count(),profileCatalog.data.length);
   const displayedProfile=(profile:any)=>profile.openCraftLabel??profile.id.replace(/^:/,'').replace(/[-_]+/g,' ');
   assert.match(await permissionMenu.innerText(),/Engine profiles|Read only|Accept edits|Full access/);
   await page.getByRole('menuitem').filter({hasText:displayedProfile(selectedProfile)}).click();
   await editor.fill('Reply OK only.');
   await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.getAttribute('aria-label')==='Send message'&&!button.disabled),{},{timeout:15000});
   await editor.press('Enter');
   const secondDeadline=Date.now()+30000;
   while(Date.now()<secondDeadline && observed.getSnapshot().timeline.frames.filter(frame=>frame.type==='assistant'&&frame.status==='complete').length<2) await new Promise(resolve=>setTimeout(resolve,25));
   assert.equal(observed.getSnapshot().timeline.frames.filter(frame=>frame.type==='assistant'&&frame.status==='complete').length,2, await page.locator('body').innerText());
   const permissionHistory=await new DshClient(host.dshUrl).call<any>('session.history',{sessionId:thread.id,maxMessages:100});
   assert.equal(permissionHistory.events.filter((entry:any)=>entry.event.type==='permission/preset').at(-1)?.event.data.preset,(selectedProfile as any).openCraftNativeProfileId??selectedProfile.id);
   await page.getByText('OK',{exact:true}).first().waitFor();
   await page.reload();
   await page.getByText('OK',{exact:true}).first().waitFor();
   assert.equal(observed.getSnapshot().timeline.frames.filter(frame=>frame.type==='assistant'&&frame.status==='complete').length,2);
   await page.locator('.codex-composer-mode--permissions').first().click();
   const restoredSelection=permissionMenu.locator('[data-selected="true"]');
   assert.equal(await restoredSelection.count(),1);
   assert.match(await restoredSelection.innerText(),new RegExp(displayedProfile(selectedProfile),'i'));
   await page.getByRole('menuitem').filter({hasText:displayedProfile(profileCatalog.data[0])}).click();
   if(process.env.OPENCRAFT_DSH_BROWSER_SMOKE==='1'){
     await editor.fill('BROWSER_BRIDGE_TEST: open the local fixture and list tabs.');
     await editor.press('Enter');
     await page.getByText('BROWSER_BRIDGE_DONE',{exact:true}).first().waitFor({timeout:30000});
     assert.ok(browserToolResultSeen,'actual browser tool result returned into DSH model context');
     assert.ok(browserInspected,'actual browser inspection returned revision and page text to DSH');
     const browserFrame=page.frameLocator('iframe').getByRole('heading',{name:'DSH browser bridge verified'});
     await browserFrame.first().waitFor({timeout:15000}).catch(async(error:Error)=>{
       await page.screenshot({path:'/tmp/opencraft-dsh-browser-failure.png'});
       console.log('Browser fixture frames',page.frames().map((frame:any)=>frame.url()));
       console.log('Browser fixture UI',await page.locator('body').innerText());
       throw error;
     });
     await page.screenshot({path:'/tmp/opencraft-dsh-actual-browser.png'});
     console.log('Actual DSH -> production capability broker -> OpenCraft browser handler: local page opened, tab list returned, iframe content visible.');
   }
   observed.release();
   await page.screenshot({path:'/tmp/opencraft-dsh-migration-ui.png'});
   await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
   assert.ok(await editor.count(),'BFCache keeps the application mounted');
   await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:false})));
   await page.waitForFunction(()=>document.getElementById('root')?.childElementCount===0);
   await new Promise(resolve=>setTimeout(resolve,100));
   assert.deepEqual(errors,[]);
   console.log('Actual Workbench UI: persisted reply visible, second send visible after completion, both replies survive reload.');
 }
 console.log('Real Workbench -> compiler -> DSH -> local model: unsupported reasoning has null default; stale none is not transmitted. No external model request.');
}finally{await browser?.close();await uiServer?.close();await runtime?.dispose();await host?.close();await new Promise<void>(r=>endpoint.close(()=>r()));await rm(root,{recursive:true,force:true})}
