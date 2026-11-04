import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { RemoteBrowserStorage } from '../../apps/workbench-web/src/browser/remote-browser-storage';
import { RemoteBrowserService } from '../../scripts/remote-browser-service.mjs';
const key='opencraft.browser-pages.v1';
const tick=async()=>{for(let i=0;i<16;i++)await Promise.resolve()};
const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve}};

function direct() {
 const storage:any=new RemoteBrowserStorage(),calls:any[]=[],errors:string[]=[];
 storage.scope='fixture-owner';storage.initialized=true;
 storage.connect=async()=>{};storage.waitForRetry=async()=>{};
 storage.onError((e:Error)=>errors.push(e.message));
 storage.call=async(input:any)=>{calls.push(input);return {revision:calls.length,keyRevision:(storage.keyRevisions[input.key]??0)+1}};
 return {storage,calls,errors};
}
test('long transient outage does not exhaust metadata recovery or mutate the uncertain request',async()=>{
 const f=direct();let attempts=0;
 f.storage.call=async(input:any)=>{f.calls.push(input);if(++attempts<=12)throw Object.assign(new Error('temporary'),{code:'DISCONNECTED'});return {revision:1,keyRevision:1}};
 try{f.storage.setItem(key,'[]');await f.storage.flush();assert.equal(attempts,13);assert.deepEqual(f.errors,[]);assert(f.calls.every(c=>c===f.calls[0]));assert.equal(f.storage.failure,null)}finally{f.storage.dispose()}
});

test('one uncertain request plus four latest field snapshots bound queued work and flush fences do not starve',async()=>{
 const f=direct(),first=gate(),second=gate();let serial=0;
 f.storage.call=async(input:any)=>{f.calls.push(input);if(++serial===1)await first.promise;else await second.promise;return {revision:serial,keyRevision:(f.storage.keyRevisions[input.key]??0)+1}};
 try{
  f.storage.setItem(key,'["first"]');let early=false;const earlyFlush=f.storage.flush().then(()=>early=true);await tick();
  for(let i=0;i<1000;i++){
   f.storage.setItem(key,JSON.stringify(['latest',i]));f.storage.setItem('opencraft.browser-tabs.v1',JSON.stringify([i]));
   f.storage.setItem('opencraft.remote-browser-storage.v1',JSON.stringify({i}));f.storage.setItem('opencraft.conversation-bindings.v1',JSON.stringify({i}));
  }
  assert.equal(f.calls.length,1);assert.equal(f.storage.queued.size,4);
  const all=f.storage.flush();first.resolve();await earlyFlush;assert(early);await tick();assert.equal(f.calls.length,2,'a later write can remain outstanding after the earlier fence');
  second.resolve();await all;assert.equal(f.calls.length,5);assert.equal(f.storage.queued.size,0);assert.equal(f.storage.getItem(key),'["latest",999]');assert.deepEqual(f.errors,[]);
 }finally{first.resolve();second.resolve();f.storage.dispose()}
});

test('terminal CAS conflict blocks instead of silently rebasing a write over another client',async()=>{
 const f=direct();f.storage.call=async()=>{throw Object.assign(new Error('another client'),{code:'STATE_CONFLICT'})};
 try{f.storage.setItem(key,'[]');await assert.rejects(f.storage.flush(),{code:'STATE_CONFLICT'});assert.deepEqual(f.errors,['another client']);assert.throws(()=>f.storage.setItem(key,'[1]'),/another client/);assert.equal(f.storage.queued.size,0)}finally{f.storage.dispose()}
});

test('dispose interrupts backoff, rejects fences and cannot send late writes',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=direct();delete f.storage.waitForRetry;let attempts=0;
 f.storage.call=async()=>{attempts++;throw Object.assign(new Error('temporary'),{code:'DISCONNECTED'})};
 f.storage.setItem(key,'[]');const flush=assert.rejects(f.storage.flush(),/closed/);await tick();assert(f.storage.retryWait);
 f.storage.dispose();await flush;await tick();t.mock.timers.tick(60000);await tick();assert.equal(attempts,1);assert.equal(f.storage.retryWait,null);assert.equal(f.storage.queued.size,0);assert.deepEqual(f.errors,[]);
});

async function realFixture() {
 const directory=await mkdtemp(join(tmpdir(),'browser-storage-recovery-')),service=new RemoteBrowserService({root:directory,dataDirectory:directory,ownerConnector:null});
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
 let drops=0,handoffs=0,loseAck=false;const inputs:any[]=[];
 server.on('connection',socket=>socket.on('message',async bytes=>{
  const m=JSON.parse(String(bytes));
  try{
   if(m.input){inputs.push(m.input);if(handoffs-->0)throw Object.assign(new Error('handoff'),{code:'BROWSER_UNAVAILABLE',retryable:true});if(drops-->0){socket.close(1012);return}}
   const result=await service.metadata('fixture-owner',m.input,()=>{});
   if(m.input&&loseAck){loseAck=false;socket.close(1012);return}
   socket.send(JSON.stringify({type:'result',id:m.id,value:result}));
  }catch(error:any){socket.send(JSON.stringify({type:'result',id:m.id,error:{message:error.message,code:error.code,retryable:error.retryable===true}}))}
 }));
 const saved=new Map(['WebSocket','location','localStorage'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 Object.defineProperty(globalThis,'WebSocket',{configurable:true,value:WebSocket});
 Object.defineProperty(globalThis,'location',{configurable:true,value:{href:`http://127.0.0.1:${(server.address() as any).port}/`}});
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem(){return null}}});
 const storage:any=await RemoteBrowserStorage.create();storage.waitForRetry=async()=>{};
 return {storage,service,server,inputs,drop(n:number){drops=n},handoff(n:number){handoffs=n},lose(){loseAck=true},async close(){storage.dispose();for(const s of server.clients)s.terminate();service.close();await service.persistence;await new Promise<void>(r=>server.close(()=>r()));await rm(directory,{recursive:true,force:true});for(const [k,v]of saved)if(v)Object.defineProperty(globalThis,k,v);else delete(globalThis as any)[k]}};
}

test('real sockets recover after eight dropped writes against the durable metadata owner',async()=>{
 const f=await realFixture();try{
  f.drop(8);f.storage.setItem(key,'[]');await f.storage.flush();assert.equal(f.inputs.length,9);
  assert(f.inputs.every(v=>v.mutationId===f.inputs[0].mutationId&&v.expectedKeyRevision===0));
  const state=await f.service.metadata('fixture-owner',undefined,()=>{});assert.equal(state.revision,1);assert.equal(state.values.pages,'[]');assert.equal(f.storage.failure,null);
 }finally{await f.close()}
});

test('lost committed ACK is reconciled by receipt before newer coalesced snapshots and independent keys',async()=>{
 const f=await realFixture();try{
  f.lose();f.storage.setItem(key,'["first"]');await tick();
  for(let i=0;i<100;i++)f.storage.setItem(key,JSON.stringify([i]));
  f.storage.setItem('opencraft.browser-tabs.v1','[]');await f.storage.flush();
  const state=await f.service.metadata('fixture-owner',undefined,()=>{});assert.equal(state.values.pages,'[99]');assert.equal(state.values.tabs,'[]');assert.equal(state.keyRevisions.pages,2);assert.equal(state.revision,3);
  assert.equal(f.inputs[0].mutationId,f.inputs[1].mutationId);assert.deepEqual(f.inputs[0],f.inputs[1]);assert.equal(f.inputs.length,4);
 }finally{await f.close()}
});

for(const [code,expected]of [[1008,'AUTHORIZATION_REQUIRED'],[1009,'STATE_TOO_LARGE'],[1002,'PROTOCOL_ERROR']]) test(`socket close ${code} is terminal rather than an endless authorization/protocol retry`,async()=>{
 const f=await realFixture();try{
  const errors:string[]=[];f.storage.onError((e:any)=>errors.push(e.code));for(const socket of f.server.clients)socket.close(code as number);
  for(let i=0;i<30&&!f.storage.failure;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(f.storage.failure?.code,expected);assert.throws(()=>f.storage.setItem(key,'[]'),{code:expected});assert.deepEqual(errors,[expected]);assert.equal(f.inputs.length,0);
 }finally{await f.close()}
});

test('UTF8 request bytes and character limits reject locally without retrying an oversized frame',async()=>{
 const f=await realFixture();try{
  f.storage.setItem(key,'中'.repeat(50000));await f.storage.flush();assert.equal(f.inputs.length,1);
  await assert.rejects(f.storage.call({value:'中'.repeat(3*1024*1024)}),{code:'STATE_TOO_LARGE'});assert.equal(f.inputs.length,1);
 }finally{await f.close()}
 const f2=direct();try{assert.throws(()=>f2.storage.setItem(key,'x'.repeat(65537)),{code:'STATE_TOO_LARGE'});assert.equal(f2.storage.getItem(key),null);assert.equal(f2.calls.length,0)}finally{f2.storage.dispose()}
});

test('malformed state data fails once without an uncaught parser exception or reconnect loop',async()=>{
 const f=await realFixture();try{
  for(const socket of f.server.clients)socket.send('not valid JSON');
  for(let i=0;i<30&&!f.storage.failure;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(f.storage.failure?.code,'PROTOCOL_ERROR');assert.equal(f.inputs.length,0);
 }finally{await f.close()}
});

test('a late callback from a retired state socket cannot poison its replacement',async()=>{
 const f=await realFixture();try{
  const old=f.storage.socket;for(const socket of f.server.clients)socket.terminate();await once(old,'close');
  await f.storage.connect();assert.notEqual(old,f.storage.socket);
  old.onmessage?.({data:'malformed retired response'});assert.equal(f.storage.failure,null);
  f.storage.setItem(key,'[]');await f.storage.flush();assert.equal(f.inputs.length,1);assert.equal(f.storage.failure,null);
 }finally{await f.close()}
});

test('transient native-owner handoff errors retain the same mutation while conflicts remain terminal',async()=>{
 const f=direct();let count=0;
 f.storage.call=async(input:any)=>{f.calls.push(input);if(++count<9)throw Object.assign(new Error('handoff'),{code:'BROWSER_UNAVAILABLE',retryable:true});return {revision:1,keyRevision:1}};
 try{f.storage.setItem(key,'[]');await f.storage.flush();assert.equal(count,9);assert(f.calls.every(c=>c===f.calls[0]));assert.equal(f.storage.failure,null)}finally{f.storage.dispose()}
});

test('a canceled flush fence leaves global recovery alive for other consumers',async()=>{
 const f=direct(),blocked=gate(),controller=new AbortController();f.storage.call=async()=>{await blocked.promise;return {revision:1,keyRevision:1}};
 try{
  f.storage.setItem(key,'[]');const abandoned=assert.rejects(f.storage.flush(controller.signal),/canceled/),live=f.storage.flush();controller.abort();await abandoned;
  assert.equal(f.storage.fences.size,1);assert.equal(f.storage.failure,null);blocked.resolve();await live;
 }finally{blocked.resolve();f.storage.dispose()}
});

test('application shutdown drains acknowledged work but cannot hang forever in an offline retry',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=direct();delete f.storage.waitForRetry;let calls=0;
 f.storage.call=async()=>{calls++;throw Object.assign(new Error('offline'),{code:'DISCONNECTED'})};
 f.storage.setItem(key,'[]');await tick();let complete=false;const closing=f.storage.flushAndDispose().then(()=>complete=true);
 t.mock.timers.tick(1999);await tick();assert(!complete);t.mock.timers.tick(1);await closing;assert(complete);assert(f.storage.closed);assert.equal(f.storage.retryWait,null);
 const before=calls;t.mock.timers.tick(60000);await tick();assert.equal(calls,before);assert.equal(f.storage.fences.size,0);
 const online=direct();try{online.storage.setItem(key,'[]');await online.storage.flushAndDispose();assert.equal(online.calls.length,1);assert(online.storage.closed)}finally{online.storage.dispose()}
});


test('real state responses preserve retryable handoff classification',async()=>{
 const f=await realFixture();try{f.handoff(8);f.storage.setItem(key,'[]');await f.storage.flush();assert.equal(f.inputs.length,9);assert.equal(f.storage.failure,null);assert(f.inputs.every(i=>i.mutationId===f.inputs[0].mutationId));}finally{await f.close()}
});

test('conversation catalog larger than the former tab quota round-trips through the durable owner and reloads', async()=>{
 const f=await realFixture();let restarted:any;
 try{
  const value=JSON.stringify(Array.from({length:1200},(_,i)=>({scopeId:`scope-${i}`,hostId:'host-'+ 'h'.repeat(30),threadId:'thread-'+i+'访'.repeat(32)})));
  assert(value.length>64*1024);assert(new TextEncoder().encode(JSON.stringify({value})).byteLength>128*1024);
  f.storage.setItem('opencraft.conversation-bindings.v1',value);await f.storage.flush();
  const state=await f.service.metadata('fixture-owner',undefined,()=>{});
  assert.equal(state.values.bindings,value);assert.equal(f.storage.failure,null);
  restarted=await RemoteBrowserStorage.create();assert.equal(restarted.getItem('opencraft.conversation-bindings.v1'),value);
  assert.equal(f.service.server.options.maxPayload,8*1024*1024);
 }finally{restarted?.dispose();await f.close()}
});

test('local quota rejection retains the acknowledged snapshot and cannot poison independent browser fields',async()=>{
 const f=direct();try{
  f.storage.setItem('opencraft.conversation-bindings.v1','[]');await f.storage.flush();
  assert.throws(()=>f.storage.setItem('opencraft.conversation-bindings.v1','x'.repeat(1024*1024+1)),{code:'STATE_TOO_LARGE'});
  assert.equal(f.storage.getItem('opencraft.conversation-bindings.v1'),'[]');assert.equal(f.storage.failure,null);assert.deepEqual(f.errors,[]);
  assert.throws(()=>f.storage.setItem(key,'x'.repeat(64*1024+1)),{code:'STATE_TOO_LARGE'});
  f.storage.setItem(key,'[]');await f.storage.flush();assert.equal(f.storage.getItem(key),'[]');assert.deepEqual(f.errors,[]);
 }finally{f.storage.dispose()}
});
