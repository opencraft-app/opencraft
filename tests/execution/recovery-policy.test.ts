import assert from "node:assert/strict";
import test from "node:test";
import { ConversationRecoveryOwner, type RecoveryDemand } from "../../packages/workbench-runtime/src/recovery-policy";
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test("queued recovery is owned before a synchronous observer disposes it",async()=>{
 const key={};let owner!:ConversationRecoveryOwner,settled=false,runs=0,once=false;
 owner=new ConversationRecoveryOwner({hostId:"queued-dispose",clock:{setTimeout,clearTimeout:id=>clearTimeout(id as ReturnType<typeof setTimeout>)},log(){},
  changed(){if(!once && owner.getProgress(key)?.stage==="queued"){once=true;owner.dispose();}}});
 try {
  const done=owner.recover({key,demand:()=>"visible",retryable:()=>false,run:async()=>{runs++;}}).then(()=>{settled=true;});
  await tick();assert.equal(settled,true,"disposed queued work must release its caller");assert.equal(runs,0);await done;
 }finally{owner.dispose();}
});
test("removal from the history observer cannot dereference retired progress or start I/O",async()=>{
 const key={};let owner!:ConversationRecoveryOwner,runs=0,once=false,done:Promise<void>|undefined;
 owner=new ConversationRecoveryOwner({hostId:"history-remove",clock:{setTimeout,clearTimeout:id=>clearTimeout(id as ReturnType<typeof setTimeout>)},log(){},
  changed(){if(!once && owner.getProgress(key)?.stage==="history"){once=true;owner.remove(key);}}});
 try {
  assert.doesNotThrow(()=>{done=owner.recover({key,demand:()=>"visible",retryable:()=>false,run:async()=>{runs++;}});});
  await done;await tick();assert.equal(runs,0);assert.equal(owner.getProgress(key),undefined);
 }finally{owner.dispose();}
});
test("an authoritative diagnostic cannot delete work admitted by reentrant invalidation",async()=>{
 const key={};let owner!:ConversationRecoveryOwner,once=false,runs=0,release!:()=>void,successor:Promise<void>|undefined,settled=false;
 owner=new ConversationRecoveryOwner({hostId:"late-cleanup",clock:{setTimeout,clearTimeout:id=>clearTimeout(id as ReturnType<typeof setTimeout>)},
  log(event){if(!once && event.stage==="history-authoritative"){
   once=true;owner.invalidate();successor=owner.recover({key,demand:()=>"visible",retryable:()=>false,
    run:()=>new Promise<void>(resolve=>{runs++;release=resolve;})}).then(()=>{settled=true;});
  }}});
 try {
  await owner.recover({key,demand:()=>"visible",retryable:()=>false,run:async()=>{}});await tick();
  assert.equal(runs,1,"successor admitted by the observer must still start");assert.equal(settled,false);
  release();await successor;assert.equal(settled,true);
 }finally{owner.dispose();release?.();}
});
test("invalidation publishes only after retiring active reservations",async()=>{
 const key={};let owner!:ConversationRecoveryOwner,armed=false,once=false,runs=0,release!:()=>void;
 owner=new ConversationRecoveryOwner({hostId:"invalidate-order",clock:{setTimeout,clearTimeout:id=>clearTimeout(id as ReturnType<typeof setTimeout>)},log(){},
  changed(){if(armed && !once){once=true;void owner.recover({key,demand:()=>"visible",retryable:()=>false,
   run:()=>new Promise<void>(resolve=>{runs++;release=resolve;})});}}});
 try {
  armed=true;owner.invalidate();await tick();
  const same=owner.recover({key,demand:()=>"visible",retryable:()=>false,run:async()=>{runs++;}});
  await tick();assert.equal(runs,1,"old invalidate cannot clear a successor's active reservation");
  release();await same;
 }finally{owner.dispose();release?.();}
});
test("explicit retry from a backoff observer supersedes the not-yet-installed retry timer",async()=>{
 const key={};let owner!:ConversationRecoveryOwner,runs=0,once=false;
 const timers=new Set<unknown>();
 owner=new ConversationRecoveryOwner({hostId:"backoff-retry",clock:{setTimeout(){const id={};timers.add(id);return id;},clearTimeout(id){timers.delete(id);}},log(){},
  changed(){if(!once && owner.getProgress(key)?.stage==="backoff"){
   once=true;void owner.recover({key,demand:()=>"visible",retryable:()=>false,run:async()=>{runs++;}},true);
  }}});
 try {
  let settled=false;
  const done=owner.recover({key,demand:()=>"visible",retryable:()=>true,run:async()=>{runs++;throw Error("first read failed");}}).then(()=>{settled=true;});
  await tick();assert.equal(runs,2);assert.equal(settled,true);assert.equal(timers.size,0);await done;
 }finally{owner.dispose();}
});
test("an explicit retry shares an active read but survives that read's failure",async()=>{
 const f=fixture(),key={};let fail!:(error:Error)=>void,successes=0;
 try {
  const first=f.owner.recover({key,demand:()=>"visible",retryable:()=>false,run:()=>new Promise<void>((_,reject)=>{fail=reject;})});
  await tick();
  const retry=f.owner.recover({key,demand:()=>"visible",retryable:()=>false,run:async()=>{successes++;}},true);
  assert.equal(retry,first);assert.equal(successes,0);
  fail(new Error("shared read failed"));await tick();assert.equal(successes,1);assert.equal(f.timers.size,0);await first;
 }finally{f.owner.dispose();}
});
test("removed active histories release logical capacity and their late cleanup cannot release successors",async()=>{
 const f=fixture(),a={},b={},releases:Array<()=>void>=[];let running=0;
 const task=(key:object)=>({key,demand:()=>"visible" as const,retryable:()=>false,run:()=>new Promise<void>(resolve=>{running++;releases.push(resolve);})});
 try {
  const oldA=f.owner.recover(task(a)),oldB=f.owner.recover(task(b));await tick();assert.equal(running,2);
  f.owner.remove(a);f.owner.remove(b);await Promise.all([oldA,oldB]);
  const nextA=f.owner.recover(task(a)),nextB=f.owner.recover(task(b));await tick();assert.equal(running,4);
  releases[0]!();releases[1]!();await tick();
  assert.equal(f.owner.recover(task(a)),nextA);assert.equal(f.owner.recover(task(b)),nextB);
  await tick();assert.equal(running,4,"retired finally must not remove successor reservations");
  releases[2]!();releases[3]!();await Promise.all([nextA,nextB]);
 }finally{for(const release of releases)release();f.owner.dispose();}
});
function fixture(options: { jitter?: boolean; random?: () => number; delaysMs?: readonly number[] } = {}) {
 let now = 0, seq = 0;
 const timers = new Map<number, { at: number; delay: number; run(): void }>();
 const events: Record<string, string | number>[] = [];
 const owner = new ConversationRecoveryOwner({hostId:"test", clock: {
  now: () => now,
  setTimeout(run, delay) { const id = ++seq; timers.set(id, {at:now+delay,delay,run}); return id; },
  clearTimeout(id) { timers.delete(id as number); },
 }, delaysMs: 'delaysMs' in options ? options.delaysMs : [500,1_000,2_000,5_000,15_000,30_000,60_000],
 jitter: options.jitter, random: options.random, log:event=>events.push({...event})});
 const advance = async (ms: number) => { now+=ms; for(const [id,t] of [...timers]) if(t.at<=now){timers.delete(id);t.run();} await tick(); };
 return {owner,events,advance,timers,};
}
test("visible recovers first, background is bounded, caches stay lazy and promotions start without waiting", async () => {
 const f=fixture(), started:string[]=[], releases=new Map<string,()=>void>();
 const work=(name:string,demand:RecoveryDemand)=>({key:{},demand:()=>demand,retryable:()=>false,
  run:()=>new Promise<void>(resolve=>{started.push(name);releases.set(name,resolve);})});
 const visible=work('visible','visible'), hidden=work('hidden','open'), hidden2=work('hidden2','open'), cached=work('cached','cache');
 const v=f.owner.recover(visible), h=f.owner.recover(hidden), h2=f.owner.recover(hidden2);
 await f.owner.recover(cached); await tick(); assert.deepEqual(started,['visible']);
 releases.get('visible')!(); await v; await tick(); assert.deepEqual(started,['visible','hidden']);
 const promoted=f.owner.recover(work('promoted','visible')); await tick();
 assert.deepEqual(started,['visible','hidden','promoted']);
 releases.get('promoted')!(); await promoted; releases.get('hidden')!(); await h; await tick();
 assert.equal(started.at(-1),'hidden2'); releases.get('hidden2')!(); await h2;
 f.owner.dispose();
});
test("failed visible recovery settles and permits hidden recovery; duplicate triggers coalesce", async () => {
 const f=fixture(); let runs=0;
 const task={key:{},demand:()=>"visible" as const,retryable:()=>false,run:async()=>{runs++;throw Error('semantic');}};
 const first=f.owner.recover(task); assert.equal(f.owner.recover(task),first); await first;
 let hidden=false; await f.owner.recover({key:{},demand:()=>"open",retryable:()=>false,run:async()=>{hidden=true;}});
 assert.equal(runs,1);assert.equal(hidden,true);f.owner.dispose();
});

test("explicit retry wakes delayed history, applies the new policy and shares the active read", async () => {
 const f=fixture(),key={};let reads=0,retried=0,release!:()=>void;
 const first=f.owner.recover({key,demand:()=>"visible",retryable:()=>true,
   run:async()=>{reads++;throw Error('timeout');}});
 await tick();assert.equal(reads,1);assert.equal(f.timers.size,1);
 const retry={key,demand:()=>"visible" as const,retryable:()=>false,
   run:()=>new Promise<void>(resolve=>{retried++;release=resolve;})};
 assert.equal(f.owner.recover(retry,true),first);
 await tick();assert.equal(retried,1);assert.equal(f.timers.size,0);
 assert.equal(f.owner.recover(retry,true),first);await tick();assert.equal(retried,1);
 release();await first;await f.advance(60_000);assert.equal(reads,1);assert.equal(retried,1);
 f.owner.dispose();
});

test("history retries continue beyond three failures, cap backoff and settle after recovery", async () => {
 const f=fixture({jitter:false});let reads=0;
 const done=f.owner.recover({key:{},demand:()=>"visible",retryable:()=>true,propagateFailure:true,
   run:async()=>{if(++reads<=10)throw Error('still unavailable');}});
 await tick();
 for(const delay of [500,1000,2000,5000,15000,30000,60000,60000,60000,60000])await f.advance(delay);
 await done;assert.equal(reads,11);assert.equal(f.timers.size,0);
 await f.advance(60_000);assert.equal(reads,11);f.owner.dispose();
});

test("a cached or released conversation cancels persistent recovery and stale timers", async () => {
 const f=fixture(),key={};let reads=0,demand:RecoveryDemand="visible";
 const done=f.owner.recover({key,demand:()=>demand,retryable:()=>true,
   run:async()=>{reads++;throw Error('unavailable');}});
 await tick();for(const delay of [500,1000,2000,5000])await f.advance(delay);
 const stale=[...f.timers.values()][0]!.run;
 demand="cache";await f.advance(15000);await done;
 stale();await tick();assert.equal(reads,5);assert.equal(f.timers.size,0);
 f.owner.dispose();
});

test("a cancelled history timer cannot consume the replacement retry delay", async () => {
 const f=fixture(),key={};let reads=0;
 const task={key,demand:()=>"visible" as const,retryable:()=>true,run:async()=>{reads++;throw Error('timeout');}};
 const first=f.owner.recover(task);await tick();
 const stale=[...f.timers.values()][0]!.run;
 assert.equal(f.owner.recover(task,true),first);await tick();
 assert.equal(reads,2);assert.equal(f.timers.size,1);
 stale();await tick();assert.equal(reads,2);assert.equal(f.timers.size,1);
 f.owner.invalidate();await first;f.owner.dispose();
});

test("observable progress distinguishes connection backoff and per-conversation history without advancing work", async () => {
 const f=fixture();
 f.owner.begin("connecting");
 assert.equal(f.owner.getProgress()?.stage,"connecting");
 assert.equal(f.owner.getProgress()?.attempt,1);
 const id=f.owner.getProgress()?.recoveryId;
 await f.advance(123);
 f.owner.connectionStage("initializing");
 assert.equal(f.owner.getProgress()?.stageStartedAt,123);
 f.owner.connectionFailed({code:"TIMEOUT",message:"secret",data:{token:"secret"}});
 f.owner.connectionBackoff(1,500);
 assert.equal(f.owner.getProgress()?.recoveryId,id);
 assert.equal(f.owner.getProgress()?.retryAt,623);
 assert.equal(f.owner.getProgress()?.lastFailure?.code,"TIMEOUT");
 for(let i=0;i<100;i++)f.owner.getProgress();
 assert.equal(f.timers.size,0);
 f.owner.hostReady();
 assert.equal(f.owner.getProgress(),undefined);
 const key={},other={};let reads=0,release!:()=>void;
 const done=f.owner.recover({key,demand:()=>"visible",retryable:()=>true,run:async()=>{
  if(++reads===1)throw {code:"TIMEOUT",message:"secret-body"};
  await new Promise<void>(resolve=>{release=resolve;});
 }});
 await tick();
 assert.equal(f.owner.getProgress(key)?.stage,"backoff");
 assert.equal(f.owner.getProgress(key)?.attempt,1);
 assert.equal(f.owner.getProgress(key)?.retryAt,623);
 assert.equal(f.owner.getProgress(other),undefined);
 assert.doesNotMatch(JSON.stringify(f.owner.getProgress(key)),/secret|token|message/);
 await f.advance(500);
 assert.equal(f.owner.getProgress(key)?.stage,"history");
 assert.equal(f.owner.getProgress(key)?.attempt,2);
 assert.equal(f.owner.getProgress(key)?.retryAt,undefined);
 assert.equal(f.owner.getProgress(key)?.lastFailure?.code,"TIMEOUT");
 release();await done;await tick();
 assert.equal(f.owner.getProgress(key),undefined);
 f.owner.dispose();
});

test("diagnostic history is bounded, manual stop has no retry deadline and invalidation fences late work",async()=>{
 const f=fixture();
 for(let i=0;i<20;i++){f.owner.begin("connecting");f.owner.connectionFailed({code:"private text"});f.owner.connectionBackoff(1,500);}
 assert.equal(f.owner.getProgress()?.events.length,12);
 assert.equal(f.owner.getProgress()?.attempt,20);
 assert.equal(f.owner.getProgress()?.lastFailure?.code,"UNCLASSIFIED");
 f.owner.connectionBlocked();
 assert.equal(f.owner.getProgress()?.stage,"blocked");assert.equal(f.owner.getProgress()?.retryAt,undefined);
 const key={};let reject!:(error:unknown)=>void;
 const done=f.owner.recover({key,demand:()=>"visible",retryable:()=>true,run:()=>new Promise<void>((_,fail)=>{reject=fail;})});
 await tick();f.owner.invalidate();await done;reject({code:"TIMEOUT"});await tick();
 assert.equal(f.owner.getProgress(key),undefined);
 f.owner.dispose();
});

test("a new explicit recovery after terminal failure has its own correlation and attempt count",async()=>{
 const f=fixture(),key={};
 const failed=f.owner.recover({key,demand:()=>"visible",retryable:()=>false,run:async()=>{throw {code:"TIMEOUT"};}});
 await failed;await tick();
 const previous=f.owner.getProgress(key)!;assert.equal(previous.stage,"failed");
 f.owner.begin("revalidate");
 let release!:()=>void;
 const retry=f.owner.recover({key,demand:()=>"visible",retryable:()=>false,run:()=>new Promise<void>(resolve=>{release=resolve;})},true);
 await tick();const current=f.owner.getProgress(key)!;
 assert.notEqual(current.recoveryId,previous.recoveryId);
 assert.equal(current.recoveryId,f.events.filter(e=>e.stage==='history-started').at(-1)?.recoveryId);
 assert.equal(current.attempt,1);assert.equal(current.lastFailure,undefined);
 release();await retry;f.owner.dispose();
});

test("default history backoff is jittered within 0.8-1.2 while test schedules stay exact", async () => {
 const f=fixture({delaysMs:undefined,jitter:true,random:()=>0});
 const key={};
 const done=f.owner.recover({key,demand:()=>"visible" as const,retryable:()=>true,run:async()=>{throw Error('timeout');}});
 await tick();
 assert.deepEqual([...f.timers.values()].map(timer=>timer.delay),[400]);
 await f.advance(400);
 assert.deepEqual([...f.timers.values()].map(timer=>timer.delay),[800]);
 f.owner.dispose();
 await done.catch(()=>{});
});
