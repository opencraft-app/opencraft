import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createWorkbenchWebServer } from "../../serve-workbench-web.mjs";
import { AppHostServer } from '@opencraft/app-host-server';
import { WebSocketTransport } from '@opencraft/appserver-transport-websocket';
import { WebSocketServer, WebSocket } from 'ws';
import { chromium } from 'playwright';
const output=process.env.OPENCRAFT_LIFECYCLE_EVIDENCE ?? '.local/connection-process-recovery';
if(!process.env.OPENCRAFT_LIFECYCLE_WEB_ROOT)throw Error('Set OPENCRAFT_LIFECYCLE_WEB_ROOT to the built or installed Web directory');
await mkdir(output,{recursive:true});
let child:any,port=0;const methods:string[]=[];
const start=async()=>{child=fork(new URL("../../../tests/fixtures/connection-physical-process.ts",import.meta.url),[],{env:{...process.env,FIXTURE_PORT:String(port)},stdio:['ignore','ignore','pipe','ipc']});
 await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('fixture startup timed out')),10000);child.once('error',(error:any)=>{clearTimeout(timeout);reject(error);});child.stderr.on('data',(data:any)=>process.stderr.write(data));child.once('exit',(code:any)=>{clearTimeout(timeout);reject(Error('fixture child exited '+code));});child.on('message',(message:any)=>{if(message.port){clearTimeout(timeout);port=message.port;resolve();}if(message.method)methods.push(message.method);});});};
const stop=async()=>{const closed=once(child,'exit');child.kill('SIGTERM');await closed;};
await start();const url=`ws://127.0.0.1:${port}`;
const appHost=new AppHostServer({logicalClientRouting:true,physicalHostLifetime:'server',createTransport:()=>new WebSocketTransport({url,createSocket:url=>new WebSocket(url) as any})});
const web=await createWorkbenchWebServer({appHostServer:appHost,root:process.env.OPENCRAFT_LIFECYCLE_WEB_ROOT!,loopbackOnly:true,appServerTarget:url});
const address=await web.listen({host:'127.0.0.1',port:0});
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try {
 const page=await browser.newPage({viewport:{width:1280,height:900}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{(window as any).__name=(v:any)=>v;localStorage.setItem('opencraft.appearance-theme','light')});
 await page.goto(`http://127.0.0.1:${address.port}`);
 const target=()=>page.locator('.sidebar-activity-row').filter({has:page.getByRole('button',{name:'Lifecycle recovery fixture',exact:true})});
 await target().waitFor({timeout:30000});
 const editor=page.locator('[contenteditable=true]').first();await editor.fill('retained lifecycle draft');
 const cdp=await page.context().newCDPSession(page);await cdp.send('Page.enable');
 for(let iteration=0;iteration<3;iteration++){
  const before=methods.filter(m=>m==='thread/list').length;
  await cdp.send('Page.setWebLifecycleState',{state:'frozen'});
  await stop();await start();
  await cdp.send('Page.setWebLifecycleState',{state:'active'});
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await page.waitForFunction(()=>document.visibilityState==='visible');
  for(let n=0;n<300&&methods.filter(m=>m==='thread/list').length<=before;n++)await page.waitForTimeout(100);
  assert.ok(methods.filter(m=>m==='thread/list').length>before,'physical process restart after browser freeze recovers');
  assert.equal(await editor.textContent(),'retained lifecycle draft');await target().waitFor();
 }
 const reads=methods.filter(m=>m==='thread/list').length;await page.reload();await target().waitFor({timeout:30000});
 for(let i=0;i<100&&methods.filter(m=>m==='thread/list').length<=reads;i++)await page.waitForTimeout(100);
 assert.ok(methods.filter(m=>m==='thread/list').length>reads,'page reentry obtains a new connection');assert.deepEqual(errors,[]);
 assert.ok(!methods.some(m=>['thread/start','thread/resume','turn/start'].includes(m)));
 await page.screenshot({path:`${output}/installed-full-page.png`});
 const result={processRestarts:3,browserFreezeResume:true,draftRetained:true,reentryConnected:true,pageerrors:errors.length,boundary:'installed full Web application with isolated synthetic physical Host; no account, user thread or model'};
 await writeFile(`${output}/installed-full-page.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();await web.close();await stop();}
