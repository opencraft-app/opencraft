import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {AppHostServer} from '../../packages/app-host-server/src/index';
import {controlDiagnostic} from '@opencraft/appserver-protocol';
import {callConversationHost,createConversationExecution} from '../../scripts/conversation-execution.mjs';
import {applyThreadDefaults} from '../../apps/opencraft-daemon/src/thread-defaults-control';
const sensitive='SYNTHETIC_SECRET_body_path_actor_key_stack';
function capture(t:test.TestContext){const events:any[]=[];t.mock.method(console,'info',(...args:any[])=>{if(args[0]==='[codex-engine-diagnostic]')events.push(JSON.parse(args[1]));});return events;}
function host(t:test.TestContext,behavior:string,root=''){
 let starts=0;const listeners=new Set<(f:string)=>void>(),statuses=new Set<(s:any)=>void>();
 const owner=new AppHostServer({physicalHostLifetime:'server',createTransport(){return {status:{state:'open' as const},async connect(){},async close(){},subscribeStatus(fn:any){statuses.add(fn);return()=>statuses.delete(fn);},subscribeMessage(fn:any){listeners.add(fn);return()=>listeners.delete(fn);},async send(raw:string){
  const m=JSON.parse(raw);if(m.id===undefined)return;
  let result:any={};
  if(m.method==='initialize'&&behavior==='init-error'){for(const fn of listeners)fn(JSON.stringify({id:m.id,error:{code:-32602,message:sensitive,data:{body:sensitive}}}));return;}
  if(m.method==='project/list')result={data:[{id:'project',roots:[{path:root}]}],nextCursor:null};
  if(m.method==='thread/start'){
   starts++;
   if(behavior==='lost-ack')return;
   if(behavior==='disconnect'){for(const fn of statuses)fn({state:'closed'});return;}
   if(behavior==='rpc-error'){for(const fn of listeners)fn(JSON.stringify({id:m.id,error:{code:-32602,message:sensitive,data:{body:sensitive,stack:sensitive}}}));return;}
   result={thread:{id:'synthetic-created'}};
  }
  for(const fn of listeners)fn(JSON.stringify({id:m.id,result}));
 }};}});t.after(()=>owner.close());return {owner,get starts(){return starts;}};
}
function context(){return {sender:null,controlObservation:{traceId:randomUUID(),control:'create' as const},resourceOwner:{id:sensitive,assertCurrent(){}}};}
for(const behavior of ['init-error','rpc-error','disconnect','lost-ack','success'])test(`real AppHost create diagnostic ${behavior} preserves request outcome and excludes payload`,async t=>{
 const events=capture(t),f=host(t,behavior),c=context();const keep=setTimeout(()=>{},500);t.after(()=>clearTimeout(keep));
 const promise=callConversationHost(f.owner,{hostId:'local-codex',threadId:''},sensitive,'thread/start',{cwd:sensitive,input:sensitive},c,25);
 if(behavior==='success'){assert.equal((await promise).thread.id,'synthetic-created');assert.equal(events.some(e=>e.outcome==='disconnected'),false);}
 else await assert.rejects(promise,(e:any)=>{if(behavior==='rpc-error'||behavior==='init-error'){assert.equal(e.code,-32602);assert.equal(e.status,undefined);}return true;});
 assert.equal(f.starts,behavior==='init-error'?0:1);assert.ok(events.every(e=>e.traceId===c.controlObservation.traceId));assert.equal(events.some(e=>e.phase==='dispatch'),behavior!=='init-error');
 if(behavior==='init-error')assert.ok(events.some(e=>e.rpcCode===-32602&&e.rpcMethod==='initialize'));
 if(behavior==='rpc-error')assert.ok(events.some(e=>e.rpcCode===-32602&&e.rpcMethod==='thread/start'));
 if(behavior==='lost-ack')assert.ok(events.some(e=>e.outcome==='timeout'));
 if(behavior==='disconnect')assert.ok(events.some(e=>e.outcome==='disconnected'||e.outcome==='failed'));
 assert.equal(JSON.stringify(events).includes(sensitive),false);
});
test('actual prepare rejection is visible without a Native start or exposing the target',async t=>{
 const events=capture(t),root=await mkdtemp('/tmp/oc-safe-control-');t.after(()=>rm(root,{recursive:true,force:true}));
 const f=host(t,'success',root),c=context(),port=createConversationExecution(()=>f.owner,{serverId:'server',hostId:'local-codex',projectHostId:'opencraft-server'});
 await assert.rejects(port.prepareCreate({serverId:'server',projectId:'project',cwd:join(root,sensitive)},c));
 assert.equal(f.starts,0);assert.ok(events.some(e=>e.phase==='prepare'&&e.outcome==='failed'));assert.equal(JSON.stringify(events).includes(root),false);assert.equal(JSON.stringify(events).includes(sensitive),false);
});
test('defaults conservative catch reports only safe failure metadata and never retries the write',async()=>{
 for(const code of [-32000,'arbitrary-'+sensitive,2**40]){
  const events:any[]=[];let writes=0,reads=0;const observation={traceId:randomUUID(),control:'thread-defaults' as const};
  const failure=Object.assign(Error(sensitive),{code,status:503,data:{message:sensitive},stack:sensitive});
  const result=await applyThreadDefaults({serverId:'server',threadId:sensitive},{permissionMode:'read-only',mode:'default',model:'sol',reasoningEffort:'medium'},
   {assertCurrent(){},async prepare(){return {body:sensitive};},async write(_wire,admit){assert.equal(admit(),true);writes++;throw failure;},async observe(){reads++;throw failure;},diagnostic(phase,error){events.push(controlDiagnostic(observation,phase,'failed',error));}});
  assert.equal(result.requestState,'unknown');assert.equal(writes,1);assert.equal(reads,1);assert.equal(result.actualTurnSettings,null);assert.equal(events.length,2);assert.equal(JSON.stringify(events).includes(sensitive),false);
  assert.equal(events[0].rpcCode,code===-32000?-32000:null);assert.equal(events[0].status,503);
 }
});
test('unknown string codes, hostile accessors and diagnostic sink failures cannot change settlement',async()=>{
 const observation={traceId:randomUUID(),control:'create' as const};
 assert.equal(controlDiagnostic({...observation,traceId:sensitive},'prepare','failed'),undefined);
 assert.equal(controlDiagnostic(observation,'prepare','failed',{get code(){throw Error(sensitive);}})?.category,'unknown-error');
 let writes=0;const result=await applyThreadDefaults({serverId:'s',threadId:'t'},{permissionMode:'read-only',mode:'default',model:'sol',reasoningEffort:'medium'},
  {assertCurrent(){},async prepare(){return {};},async write(_,admit){admit();writes++;throw Error(sensitive);},async observe(){throw Error(sensitive);},diagnostic(){throw Error('sink');}});
 assert.equal(result.requestState,'unknown');assert.equal(writes,1);
});

test('actual generation router and callback lane preserve a terminal Native error or lost ACK without replay',async t=>{
 const {createServer}=await import('node:http');
 const {default:WebSocket,WebSocketServer}=await import('ws');
 const {WebSocketTransport}=await import('@opencraft/appserver-transport-websocket');
 const {CodexGenerationRegistry}=await import('../../apps/codex-core/src/generation-registry');
 const {CodexGenerationRouter,startGenerationSocket}=await import('../../apps/codex-core/src/generation-router');
 const {startOrchestrationCallbackRelay}=await import('../../apps/codex-core/src/orchestration-callback-lane');
 const events=capture(t),root=await mkdtemp('/tmp/oc-control-router-');
 const registry=new CodexGenerationRegistry(join(root,'registry'));
 const nativePath=join(root,'native.sock'),callbackPath=join(root,'callback.sock'),routerPath=join(root,'router.sock');
 const http=createServer(),ws=new WebSocketServer({noServer:true});let starts=0,behavior='rpc-error';
 http.on('upgrade',(r,s,h)=>ws.handleUpgrade(r,s,h,c=>ws.emit('connection',c)));
 ws.on('connection',socket=>socket.on('message',raw=>{const m=JSON.parse(String(raw));if(m.id===undefined)return;
  if(m.method==='thread/start'){starts++;if(behavior==='lost-ack')return;socket.send(JSON.stringify({id:m.id,error:{code:-32602,message:sensitive,data:{body:sensitive}}}));return;}
  socket.send(JSON.stringify({id:m.id,result:{}}));
 }));
 await new Promise<void>(resolve=>http.listen(nativePath,resolve));
 const relay=await startOrchestrationCallbackRelay(callbackPath,nativePath);
 registry.register({id:'synthetic',endpoint:join(root,'control.sock'),runtimeDataDirectory:join(root,'home'),executable:join(root,'stub'),bundle:join(root,'stub-app'),node:process.execPath,cwd:root});registry.ready('synthetic');registry.activate('synthetic',0);
 const router=new CodexGenerationRouter({registry,async ensure(){return {protocolVersion:1,pid:1,codexPid:2,dataDirectory:root,proxyBaseUrl:'http://127.0.0.1:1',nativeSocket:callbackPath,callbackProtocolVersion:1,pendingCallbacks:0,pendingOrchestrationMutations:0};},admit(ticket){assert.equal(registry.valid(ticket),true);return()=>{};},observe(){}});
 const listener=await startGenerationSocket(routerPath,router);
 const makeApp=()=>new AppHostServer({physicalHostLifetime:'server',createTransport:()=>new WebSocketTransport({url:`ws+unix://${routerPath}:/?opencraftLane=fixture-diagnostics`,createSocket:url=>new WebSocket(url) as any})});
 try{
  for(const selected of ['rpc-error','lost-ack']){behavior=selected;const before=starts;const app=makeApp();
   try {await assert.rejects(callConversationHost(app,{hostId:'local-codex',threadId:''},'synthetic-only','thread/start',{cwd:sensitive},context(),selected==='lost-ack'?100:1000));
   assert.equal(starts,before+1);}finally{await app.close();}
  }
  assert.ok(events.some(e=>e.rpcCode===-32602));assert.ok(events.some(e=>e.outcome==='timeout'));
  assert.equal(JSON.stringify(events).includes(sensitive),false);
 }finally{await listener.close();await relay.close();for(const c of ws.clients)c.terminate();await new Promise<void>(resolve=>ws.close(()=>resolve()));await new Promise<void>(resolve=>http.close(()=>resolve()));registry.close();await rm(root,{recursive:true,force:true});}
});
