import assert from "node:assert/strict";
import test from "node:test";
import { ConversationRecoveryOwner, type RecoveryDemand } from "../../packages/workbench-runtime/src/recovery-policy";
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
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

test("transient history retries are bounded and explicit callers receive the final failure", async () => {
 const f=fixture();let reads=0;
 const done=assert.rejects(f.owner.recover({key:{},demand:()=>"visible",retryable:()=>true,propagateFailure:true,
   run:async()=>{reads++;throw Error('still unavailable');}}),/still unavailable/);
 await tick();
 for(const delay of [500,1000,2000])await f.advance(delay);
 await done;assert.equal(reads,4);assert.equal(f.timers.size,0);
 await f.advance(60_000);assert.equal(reads,4);f.owner.dispose();
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
