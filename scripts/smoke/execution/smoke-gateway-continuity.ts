import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { WebSocket, WebSocketServer } from 'ws';
import { AppHostServer } from '../../../packages/app-host-server/src/index.ts';
import { WebSocketTransport } from '../../../packages/appserver-transport-websocket/src/index.ts';
import { createWorkbenchWebServer } from '../../serve-workbench-web.mjs';
import { createHeadlessBackendProxy } from '../../web-deployment/headless-backend.mjs';

const webRoot=resolve(process.env.OPENCRAFT_CONTINUITY_WEB_ROOT??'apps/workbench-web/dist');
const output=resolve(process.env.OPENCRAFT_CONTINUITY_OUTPUT??'.local/gateway-continuity');await mkdir(output,{recursive:true});
async function stop(child:ChildProcess|undefined) {
  if(!child||child.exitCode!==null||child.signalCode)return;
  const exited=once(child,'exit');child.kill('SIGTERM');const deadline=setTimeout(()=>child.kill('SIGKILL'),20000);
  try {const [code,signal]=await exited;assert.equal(code,0,`fixture did not stop cleanly (${signal??code})`);}finally{clearTimeout(deadline);}
}
async function start(entry:URL,args:string[]) {
  const child=fork(entry,args,{execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc']});
  let errors='';child.stderr?.on('data',data=>{errors+=data;process.stderr.write(data);});
  const message=await Promise.race([once(child,'message').then(([value])=>value as any),once(child,'exit').then(()=>{throw Error(errors||'fixture startup exited');})]);
  if(message.error)throw Error(message.error);return {child,...message};
}
const native=await start(new URL('../../../tests/fixtures/connection-physical-process.ts',import.meta.url),[]);
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const results=[];
try {
  for(const mode of ['stable-apphost-entry','bounded-reconnect']) {
    const root=await mkdtemp(join(tmpdir(),'oc-gateway-browser-'));let backend:any,web:any,proxy:any,appHost:any,originBridge:any;
    const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage();
    const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    let closes=0,rawCloses=0,updatedAt=Infinity,restoredAt=0;
    page.on('websocket',socket=>{
      const appHostWire=socket.url().includes('/apphost');if(!appHostWire&&!socket.url().includes('/appserver'))return;
      const pending=new Map<string,string>();
      socket.on('close',()=>{if(updatedAt!==Infinity){if(appHostWire)closes++;else rawCloses++;}});
      socket.on('framesent',event=>{try{const outer=JSON.parse(String(event.payload)),rpc=outer.type==='host/send'?JSON.parse(outer.frame):outer;pending.set(String(rpc.id),rpc.method);}catch{}});
      socket.on('framereceived',event=>{try{const outer=JSON.parse(String(event.payload)),rpc=outer.type==='host/frame'?JSON.parse(outer.frame):outer;if(Date.now()>=updatedAt&&pending.get(String(rpc.id))==='thread/list'&&rpc.result&&!restoredAt)restoredAt=Date.now();}catch{}});
    });
    async function boot(port=0){backend=await start(new URL('../../../tests/fixtures/gateway-process.mjs',import.meta.url),[JSON.stringify({root,webRoot,dataDirectory:join(root,'data'),port,nativeUrl:`ws://127.0.0.1:${native.port}`})]);}
    try {
      await boot();const backendPort=Number(new URL(backend.url).port);let url;
      if(mode==='stable-apphost-entry') {
        const target=()=>backend.url.replace('http','ws')+'/appserver';
        // A private test-owned adapter supplies the backend's exact Origin;
        // the real backend admission policy remains enabled.
        originBridge=new WebSocketServer({host:'127.0.0.1',port:0});await once(originBridge,'listening');
        originBridge.on('connection',(client:WebSocket)=>{
          const peer=new WebSocket(target(),{origin:backend.url}),queued:Buffer[]=[];
          client.on('error',()=>peer.terminate());peer.on('error',()=>client.terminate());
          client.on('close',()=>peer.terminate());peer.on('close',()=>client.terminate());
          client.on('message',data=>{if(peer.readyState===WebSocket.OPEN)peer.send(data);else queued.push(Buffer.from(data as Buffer));});
          peer.on('open',()=>{for(const data of queued.splice(0))peer.send(data);});peer.on('message',data=>{if(client.readyState===WebSocket.OPEN)client.send(data);});
        });
        appHost=new AppHostServer({logicalClientRouting:true,physicalHostLifetime:'server',createTransport:()=>new WebSocketTransport({url:target(),createSocket:url=>new WebSocket(url,{origin:backend.url}) as any})});
        web=await createWorkbenchWebServer({root:webRoot,appHostServer:appHost,loopbackOnly:true,appServerTarget:`ws://127.0.0.1:${originBridge.address().port}`});
        const address=await web.listen({host:'127.0.0.1',port:0});url=`http://127.0.0.1:${address.port}`;
      } else {
        const forwarding=createHeadlessBackendProxy(backend.url),tunnels=new Set();
        proxy=createServer((req,res)=>forwarding!.http(req,res,()=>{}));
        proxy.on('upgrade',(req,socket,head)=>forwarding!.upgrade(req,socket,head,()=>{},tunnels));
        await new Promise<void>(done=>proxy.listen(0,'127.0.0.1',done));url=`http://127.0.0.1:${proxy.address().port}`;
      }
      await page.addInitScript(()=>{(window as any).__name=(v:any)=>v;});
      await page.goto(url);await page.getByRole('button',{name:/^Lifecycle recovery fixture(?:\s|$)/}).first().waitFor({timeout:30000});
      const editor=page.locator('[contenteditable=true]').first();await editor.fill('gateway continuity retained draft');
      const oldPid=backend.pid;updatedAt=Date.now();await stop(backend.child);await boot(backendPort);assert.notEqual(backend.pid,oldPid);
      const end=Date.now()+30000;while(!restoredAt&&Date.now()<end)await page.waitForTimeout(50);
      const retained=await editor.textContent()==='gateway continuity retained draft';
      await page.screenshot({path:join(output,mode+'.png')});
      results.push({mode,gatewayProcessReplaced:true,appHostCloseCount:closes,rawAppServerCloseCount:rawCloses,rpcUnavailableMs:restoredAt?restoredAt-updatedAt:null,recovered:!!restoredAt,draftRetained:retained,pageErrors:errors,
        boundary:'real Chromium and full Web; real Headless process update; synthetic physical Host; stable entry prototype has no production identity assembly'});
    } finally {await context.close();await web?.close();await appHost?.close();if(originBridge){for(const socket of originBridge.clients)socket.terminate();await new Promise<void>(done=>originBridge.close(done));}if(proxy){proxy.closeAllConnections();await new Promise<void>(done=>proxy.close(done));}await stop(backend?.child);await rm(root,{recursive:true,force:true});}
  }
  await writeFile(join(output,'comparison.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
  const chosen=results.find(row=>row.mode==='bounded-reconnect')!;
  assert.ok(chosen.recovered&&chosen.rpcUnavailableMs!==null&&chosen.rpcUnavailableMs<=30000,'the selected recovery path must restore a fresh RPC within thirty seconds');
  assert.equal(chosen.draftRetained,true);assert.deepEqual(chosen.pageErrors,[]);
} finally {await browser.close();await stop(native.child);}
