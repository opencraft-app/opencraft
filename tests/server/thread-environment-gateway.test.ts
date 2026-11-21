import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {AppHostServer} from '../../packages/app-host-server/src/index';
import {ActorStore} from '../../packages/access-control/src/actors';
import {ActorAccess} from '../../packages/access-control/src/actor-access';
import {ThreadAccessStore,ThreadAccessSession} from '../../packages/access-control/src/thread-access';
import {createWorkbenchWebServer} from '../../apps/headless-server/src/serve-workbench-web.mjs';
import {EmployeeGitVaultStore} from '@opencraft/execution-environment/employee-git-vault-store';
import {AccountEnvironment} from '@opencraft/execution-environment/account-environment';
import {ExecutionEnvironmentRuntime,EXECUTION_ENVIRONMENT_FIELD} from '@opencraft/execution-environment';
import {ExecutionEnvironmentTransport} from '../../apps/headless-server/src/execution-environment-transport';
async function fixture(t:any){
 const root=await mkdtemp(join(tmpdir(),'thread-env-gateway-'));await writeFile(join(root,'index.html'),'<!doctype html><title>Fixture</title>');
 const actors=new ActorStore(join(root,'actors.sqlite')),store=new ThreadAccessStore(join(root,'access.sqlite'),actors),vault=new EmployeeGitVaultStore(root),runtime=new ExecutionEnvironmentRuntime(root,vault),env=new AccountEnvironment(vault);
 for(const user of ['alice','bob'])env.replace('fixture:'+user,{projectId:null},0,[{name:'SERVICE_KEY',value:'synthetic-'+user,secret:true}]);
 const principals=(request:any)=>({provider:'fixture',subject:String(request.headers['x-fixture-user']??'anonymous'),displayName:'Fixture',expiresAt:Date.now()+60000});
 const revoked=new Set<string>();
 const access=new ActorAccess(actors,{authenticateHuman:principals,admitted:p=>!revoked.has(p.subject),administrator:()=>false,isHumanCurrent:p=>!revoked.has(p.subject)});
 const calls:any[]=[],transports:any[]=[],sockets:WebSocket[]=[];let nextThread=0,seq=0;
 const host=new AppHostServer({logicalClientRouting:true,physicalHostLifetime:'server',createRpcAccessSession:(_h:any,c:any,emit:any)=>new ThreadAccessSession(store,()=> 'server',c.actorContext,emit,undefined,()=>{c.resourceOwner?.assertCurrent()}),createTransport:()=>{
  const listeners=new Set<any>();
  const inner={status:{state:'open'},async connect(){},async close(){listeners.clear()},subscribeStatus(){return()=>{}},subscribeMessage(fn:any){listeners.add(fn);return()=>listeners.delete(fn)},async sendWithContext(frame:string,c:any){
   const p=JSON.parse(frame);let result:any={};
   if(p.method==='initialize')result={capabilities:{extensions:{'opencraft/method-access':{version:1,methods:['thread/read','thread/list','turn/start']}}}};
   if(p.method==='thread/start'||p.method==='thread/fork')result={thread:{id:'task-'+(++nextThread),projectId:null,turns:[]}};
   let account=null,secret=null;
   if(p.method==='turn/start'){
    const scope=runtime.open(p.params[EXECUTION_ENVIRONMENT_FIELD],'local-codex',p.method,p.params);account=scope.account;secret=runtime.snapshot(scope).overlay().SERVICE_KEY;result={accepted:true};
   }
   calls.push({id:p.id,method:p.method,account,secret,principal:c.executionPrincipal?.subject,params:p.params});
   for(const fn of listeners)fn(JSON.stringify({id:p.id,__opencraftClient:p.__opencraftClient,result}));
  },async send(frame:string){return this.sendWithContext(frame,{sender:null})}};
  const transport=new ExecutionEnvironmentTransport(inner as any,runtime,'local-codex');transports.push(transport);return transport;
 }});
 const identity={admissionStatus:()=>204,connectionContext:(r:any)=>({sender:{kind:'employee',loginName:principals(r).subject},executionPrincipal:principals(r),validUntil:Date.now()+60000}),handle:()=>false};
 const gateway=await createWorkbenchWebServer({root,loopbackOnly:true,actorService:access,identityService:identity,appHostServer:host,appServerTarget:null,onAppHostDiagnostic:()=>{}});
 const a=await gateway.listen({host:'127.0.0.1',port:0}),origin=`http://127.0.0.1:${a.port}`;
 t.after(async()=>{for(const s of sockets)s.terminate();await gateway.close();await host.close();runtime.close();vault.close();store.close();actors.close();await rm(root,{recursive:true,force:true})});
 async function page(user:string){
  const socket=new WebSocket(origin.replace('http:','ws:')+'/apphost',{origin,headers:{'x-fixture-user':user}});sockets.push(socket);const frames:any[]=[];socket.on('message',b=>frames.push(JSON.parse(String(b))));await once(socket,'open');
  const wait=async(fn:any)=>{const until=Date.now()+4000;while(Date.now()<until){const found=frames.find(fn);if(found)return found;await new Promise(r=>setTimeout(r,5))}throw Error('Gateway RPC timeout '+JSON.stringify(frames.slice(-2)))};
  socket.send(JSON.stringify({type:'hello',protocolVersion:2,rendererId:user}));await wait((x:any)=>x.type==='ready');socket.send(JSON.stringify({type:'host/connect',hostId:'local-codex',leaseId:'lease',requestId:'connect'}));const generation=(await wait((x:any)=>x.type==='response'&&x.requestId==='connect')).result.generation;
  const rpc=async(method:string,params:any={})=>{const id=++seq;socket.send(JSON.stringify({type:'host/send',requestId:'send-'+id,hostId:'local-codex',leaseId:'lease',generation,frame:JSON.stringify({id,method,params})}));const frame=await wait((x:any)=>x.type==='host/frame'&&JSON.parse(x.frame).id===id||x.type==='response'&&x.requestId==='send-'+id&&x.error);return frame.type==='host/frame'?JSON.parse(frame.frame):{error:frame.error,outer:true}};
  await rpc('initialize');return{rpc,socket,frames};
 }
 const alice=await page('alice'),bob=await page('bob'),threadId=(await alice.rpc('thread/start')).result.thread.id;
 return {root,alice,bob,threadId,calls,store,actors,revoked,runtime,vault,mode:'formal'};
}
function assertRevokedNativeTraffic(calls: any[], offset: number) {
  const traffic = calls.slice(offset);
  // Revocation must close ingress and never forward caller work. Native cleanup
  // is conditional on whether a logical client was still attached; it must not
  // be confused with an execution RPC or contain execution identity/secrets.
  assert.ok(traffic.length <= 1, 'at most one native logical-client cleanup');
  for (const frame of traffic) {
    assert.equal(frame.method, 'runtime/client/disconnect');
    assert.equal(frame.id, undefined);
    assert.equal(frame.params, undefined);
    assert.equal(frame.account, null);
    assert.equal(frame.secret, null);
    assert.equal(frame.principal, undefined);
  }
}
test('shared peer sends keep caller credentials, ignore forged envelopes and retain creator', {timeout:15000},async t=>{
 const f=await fixture(t);
 for(const [user,expected] of [[f.alice,'alice'],[f.bob,'bob'],[f.alice,'alice']] as const){
  const response=await user.rpc('turn/start',{threadId:f.threadId,__opencraftEnvironment:'forged'});
  assert.equal(response.result.accepted,true);const call=f.calls.at(-1);
  assert.equal(call.account,'fixture:'+expected);assert.equal(call.secret,'synthetic-'+expected);assert.equal(call.principal,expected);
 }
 assert.deepEqual(f.runtime.creator('local-codex',f.threadId),{account:'fixture:alice'});
 assert(!JSON.stringify(f.bob.frames).includes('synthetic-'));
});
test('shared queue admission seals the current caller without claiming a native execution transfer', {timeout:15000},async t=>{
 const f=await fixture(t);
 for(const method of ['thread/queue/add','thread/queue/start','thread/queue/update','turn/steer','thread/queue/steer']){
  const response=await f.bob.rpc(method,{threadId:f.threadId});assert.equal(response.error,undefined);
  const call=f.calls.at(-1);assert.equal(call.method,method);assert.equal(call.principal,'bob');
  if (['thread/queue/add','thread/queue/start'].includes(method)) {
   const scope=f.runtime.open(call.params[EXECUTION_ENVIRONMENT_FIELD],'local-codex',method,call.params);
   assert.equal(scope.account,'fixture:bob');assert.equal(f.runtime.snapshot(scope).overlay().SERVICE_KEY,'synthetic-bob');
  } else assert.equal(call.params[EXECUTION_ENVIRONMENT_FIELD],undefined,'editing/steering must not install a new execution environment');
 }
 assert.deepEqual(f.runtime.creator('local-codex',f.threadId),{account:'fixture:alice'});
});
test('private policy denies peer and forged server/creator/envelope before native', {timeout:15000},async t=>{
 const f=await fixture(t);const alice=f.actors.findHuman({provider:'fixture',subject:'alice'});const context=f.actors.resolveHuman({provider:'fixture',subject:'alice',displayName:'Alice',expiresAt:Date.now()+60000});assert(alice);
 f.store.set('server',f.threadId,'private',1,context);const before=f.calls.length;
 for(const method of ['turn/start','turn/steer','thread/shellCommand','thread/queue/add','thread/queue/update','thread/queue/steer','thread/goal/set','review/start']){
  const res=await f.bob.rpc(method,{threadId:f.threadId,serverId:'forged',creatorActorId:alice.id,__opencraftEnvironment:'forged'});assert.equal(res.error.code,-32004);
 }
 assert.equal(f.calls.length,before);assert.equal((await f.alice.rpc('turn/start',{threadId:f.threadId})).result.accepted,true);
});
test('known environment rejection is correlated and a subsequent valid request still succeeds', {timeout:15000},async t=>{
 const f=await fixture(t);f.runtime.bind('local-codex',f.threadId,'project-a');const before=f.calls.length;
 const res=await f.alice.rpc('turn/start',{threadId:f.threadId,projectId:'project-b'});assert(res.error);assert.equal(f.calls.length,before);
 assert.equal(res.outer,undefined);assert.deepEqual(res.error.data,{notSubmitted:true,submissionOutcome:'rejected',retryable:false});
 assert.equal((await f.alice.rpc('turn/start',{threadId:f.threadId})).result.accepted,true);
});
test('fork has independent creator; original creator is not rebound by reads or peer sends', {timeout:15000},async t=>{
 const f=await fixture(t);const fork=(await f.bob.rpc('thread/fork',{threadId:f.threadId})).result.thread.id;
 assert.deepEqual(f.runtime.creator('local-codex',fork),{account:'fixture:bob'});assert.deepEqual(f.runtime.creator('local-codex',f.threadId),{account:'fixture:alice'});
 assert.equal((await f.bob.rpc('turn/start',{threadId:fork})).result.accepted,true);assert.equal(f.calls.at(-1).secret,'synthetic-bob');
 f.revoked.add('bob');const before=f.calls.length;const disconnected=once(f.bob.socket,'close');f.bob.socket.send(JSON.stringify({type:'host/send',requestId:'revoked',hostId:'local-codex',leaseId:'lease',generation:1,frame:JSON.stringify({id:'revoked',method:'turn/start',params:{threadId:fork}})}));await disconnected;await new Promise(r=>setTimeout(r,200));assert.equal(f.bob.socket.readyState,WebSocket.CLOSED);assertRevokedNativeTraffic(f.calls,before);
});

// Real HTTP/WebSocket ingress: viewing a shared Thread does not bypass private
// access or revocation when the control intent is a pure Goal pause.
test('pure Goal pause retains private Thread and current-actor checks', {timeout:15000},async t=>{
 const f=await fixture(t);const owner=f.actors.resolveHuman({provider:'fixture',subject:'alice',displayName:'Alice',expiresAt:Date.now()+60000});
 f.store.set('server',f.threadId,'private',1,owner);
 const before=f.calls.length;const denied=await f.bob.rpc('thread/goal/set',{threadId:f.threadId,status:'paused'});
 assert.equal(denied.error.code,-32004);assert.equal(f.calls.length,before);
 const allowed=await f.alice.rpc('thread/goal/set',{threadId:f.threadId,status:'paused'});
 assert.equal(allowed.error,undefined);assert.equal(f.calls.at(-1).method,'thread/goal/set');
 assert.equal(f.calls.at(-1).params.__opencraftEnvironment,undefined,'pause must not install execution secrets');
 f.revoked.add('alice');const after=f.calls.length;const disconnected=once(f.alice.socket,'close');
 f.alice.socket.send(JSON.stringify({type:'host/send',requestId:'pause-revoked',hostId:'local-codex',leaseId:'lease',generation:1,frame:JSON.stringify({id:'pause-revoked',method:'thread/goal/set',params:{threadId:f.threadId,status:'paused'}})}));
 await disconnected;await new Promise(r=>setTimeout(r,200));assert.equal(f.alice.socket.readyState,WebSocket.CLOSED);assertRevokedNativeTraffic(f.calls,after);
});
