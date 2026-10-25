import assert from "node:assert/strict";
import test from "node:test";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { DeferredDuplexTransport, type DuplexTransport } from "@opencraft/appserver-client/transport";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import { encodeJsonRpcMessage, isJsonRpcRequest, parseJsonRpcMessage } from "@opencraft/appserver-protocol";
import { ConnectionLifecycleOwner } from "../../packages/workbench-runtime/src/connection-lifecycle";
import { createRecoveryNow } from "../../packages/workbench-runtime/src/recovery-clock";
import { ConversationRecoveryOwner } from "../../packages/workbench-runtime/src/recovery-policy";
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
const params={clientInfo:{name:"revocation",version:"1"}};
const initialized={codexHome:"/fixture",userAgent:"fixture",platformFamily:"unix",platformOs:"linux"};
function gate<T>() {let resolve!:(v:T)=>void,reject!:(e:Error)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function memory() {
  return new MemoryTransport({receive(frame,peer){const request=parseJsonRpcMessage(frame);if(isJsonRpcRequest(request)&&request.method==="initialize")peer.send(encodeJsonRpcMessage({id:request.id,result:initialized}));}});
}
for(const late of ["success","failure"] as const)test(`client releases cancelled initialization before uncooperative dial late ${late}`,{timeout:3_000},async()=>{
  const transport=memory(),pending=gate<void>();let dials=0;
  const connect=transport.connect.bind(transport);
  transport.connect=signal=>++dials===1?pending.promise:connect(signal);
  const client=new JsonRpcAppServerClient({hostId:"cancelled",transport});
  try {
    const abort=new AbortController(),first=client.connect(params,abort.signal);
    const rejected=assert.rejects(first,{code:"ABORTED"});await flush();abort.abort();await rejected;
    await client.connect(params,new AbortController().signal);
    const result=client.initializeResult,generation=client.connectionGeneration;
    if(late==="success")pending.resolve();else pending.reject(Error("retired dial"));
    await flush();assert.equal(dials,2);assert.equal(client.initializeResult,result);assert.equal(client.connectionGeneration,generation);
  } finally {pending.resolve();await client.close();}
});
test("client cancellation releases ownership before transport abort observers reenter",{timeout:3_000},async()=>{
  const transport=memory(),connect=transport.connect.bind(transport);let calls=0,successor:Promise<unknown>|undefined;
  const client=new JsonRpcAppServerClient({hostId:"reentrant",transport});
  transport.connect=signal=>{
    if(++calls!==1)return connect(signal);
    signal?.addEventListener("abort",()=>{successor=client.connect(params);},{once:true});
    return new Promise(()=>{});
  };
  try {
    const abort=new AbortController(),first=client.connect(params,abort.signal),rejected=assert.rejects(first,{code:"ABORTED"});
    await flush();abort.abort();await rejected;await successor;
    assert.equal(calls,2);assert.notEqual(client.initializeResult,null);
  } finally {await client.close();}
});
test("closing the client settles uncooperative initialization before physical close completes",{timeout:3_000},async()=>{
  const transport=memory(),closing=gate<void>();
  transport.connect=()=>new Promise(()=>{});transport.close=()=>closing.promise;
  const client=new JsonRpcAppServerClient({hostId:"closed",transport});
  const first=client.connect(params),rejected=assert.rejects(first,{code:"CLOSED"});await flush();
  const close=client.close();await rejected;closing.resolve();await close;
});
test("deferred local cancellation settles promptly but successor waits for physical close",{timeout:3_000},async()=>{
  const closing=gate<void>(),oldDial=gate<void>();let allocations=0;
  const retired=memory();retired.connect=()=>oldDial.promise;retired.close=()=>closing.promise;
  const current=memory();
  const transport=new DeferredDuplexTransport(async()=>++allocations===1?retired:current);
  try {
    const abort=new AbortController(),first=transport.connect(abort.signal),rejected=assert.rejects(first);
    await flush();abort.abort();await rejected;
    const successor=transport.connect();assert.notEqual(successor,first);await flush();assert.equal(allocations,1);
    closing.resolve();await successor;assert.equal(allocations,2);assert.equal(transport.status.state,"open");
    oldDial.resolve();await flush();assert.equal(transport.status.state,"open");
  } finally {closing.resolve();oldDial.resolve();await transport.close();}
});
test("deferred cancel reentry cannot overwrite the successor or bypass release",{timeout:3_000},async()=>{
  const closing=gate<void>(),firstDial=gate<void>();let count=0,successor:Promise<void>|undefined;
  const first=memory(),second=memory();
  const transport=new DeferredDuplexTransport(async()=>++count===1?first:second);
  first.close=()=>closing.promise;
  first.connect=signal=>{signal?.addEventListener("abort",()=>{successor=transport.connect();},{once:true});return firstDial.promise;};
  try {
    const abort=new AbortController(),start=transport.connect(abort.signal),rejected=assert.rejects(start);
    await flush();abort.abort();await rejected;await flush();assert.equal(count,1);
    assert.equal(transport.status.state,"connecting");closing.resolve();await successor;
    assert.equal(count,2);assert.equal(transport.status.state,"open");
  } finally {closing.resolve();firstDial.resolve();await transport.close();}
});
function ownerFixture(invalidate:()=>void=()=>{}) {
  let steady=0,sequence=0;
  const now=createRecoveryNow(()=>steady),timers=new Map<number,()=>void>(),runs:Array<{signal:AbortSignal;resolve(v:object):void}>=[];
  const owner=new ConnectionLifecycleOwner<object>({clock:{now,setTimeout(fn){const id=++sequence;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id as number);}},
    run:attempt=>new Promise(resolve=>runs.push({signal:attempt.signal,resolve})),valid:()=>true,invalidate,changed(){},usable(){},manual:()=>false,backoff(){}});
  return {owner,runs,advance(ms:number){steady+=ms;},timers};
}
test("explicit reconnect replaces an expired operation before suspended timer callbacks run",async()=>{
  const f=ownerFixture();const first=f.owner.connect(),rejected=assert.rejects(first,/timed out/);await flush();
  f.advance(65_000);const successor=f.owner.connect(true);await rejected;await flush();
  assert.notEqual(first,successor);assert.equal(f.runs[0]!.signal.aborted,true);assert.equal(f.runs.length,2);
  f.runs[1]!.resolve({});await successor;f.owner.dispose();
});
test("expiry observer disposal wins over explicit reconnect admission",async()=>{
  const f=ownerFixture(()=>f.owner.dispose());const first=f.owner.connect(),rejected=assert.rejects(first);await flush();
  f.advance(65_000);await assert.rejects(f.owner.connect(true),/disposed/);await rejected;
  assert.equal(f.runs.length,1);assert.equal(f.owner.snapshot.phase,"disposed");
});
test("elapsed deadlines survive wall-clock reversal during a frozen page",async()=>{
  const original=Date.now,f=ownerFixture();
  try {
    const first=f.owner.connect(),rejected=assert.rejects(first,/timed out/);await flush();
    Date.now=()=>original()-3_600_000;f.advance(65_000);
    const successor=f.owner.connect(true);await rejected;await flush();
    assert.equal(f.runs[0]!.signal.aborted,true);f.runs[1]!.resolve({});await successor;
  } finally {Date.now=original;f.owner.dispose();}
});
test("elapsed fallback rebases on reversal and keeps advancing rather than waiting for wall clock to catch up",()=>{
  let wall=100_000;const now=createRecoveryNow(()=>wall);
  wall+=100;assert.equal(now(),100);wall-=3_600_000;assert.equal(now(),100);
  wall+=30_000;assert.equal(now(),30_100);
});
test("scheduling elapsed time and absolute diagnostic timestamps retain separate domains",()=>{
  let elapsed=0,wall=1_000_000;
  const owner=new ConversationRecoveryOwner({hostId:"clock-domains",clock:{
    now:()=>elapsed,wallNow:()=>wall,setTimeout(){return 1;},clearTimeout(){},
  }});
  owner.connectionStage("connecting");
  assert.equal(owner.getProgress()?.startedAt,wall);
  elapsed=300;wall-=5_000;owner.connectionBackoff(1,500);
  assert.equal(owner.getProgress()?.stageStartedAt,wall);
  assert.equal(owner.getProgress()?.retryAt,wall+500);
  owner.dispose();
});
