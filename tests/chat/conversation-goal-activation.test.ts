import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { ConversationHistory } from "../../packages/app-host-server/src/conversation-history.js";
import { ConversationHistoryTransport } from "../../packages/app-host-server/src/conversation-history-transport.js";

type Value=Record<string,any>;
const metadata=()=>({id:"goal-thread",cwd:"/synthetic",historyMode:"paginated",createdAt:1,updatedAt:2,status:{type:"idle"},turns:[]});
const rows=Array.from({length:3},(_,i)=>({id:`group-${i}`,status:"completed",itemsView:"full",items:[{id:`answer-${i}`,type:"agentMessage",text:`retained answer ${i}`}]}));
class GoalEngine implements DuplexTransport {
 status:TransportStatus={state:"idle"};requests:Value[]=[];listeners=new Set<(frame:string)=>void>();statuses=new Set<(state:TransportStatus)=>void>();
 loaded=false;started=false;goal:Value|null=null;hold=false;fail=false;held:Value[]=[];
 async connect(){this.status={state:"open"};for(const listener of this.statuses)listener(this.status);}
 subscribeMessage(listener:(frame:string)=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
 subscribeStatus(listener:(state:TransportStatus)=>void){this.statuses.add(listener);return()=>this.statuses.delete(listener);}
 reply(request:Value,result:Value,error?:Value){const frame=JSON.stringify({id:request.id,...(error?{error}:{result}),...(request.__opencraftClient?{__opencraftClient:request.__opencraftClient}:{})});for(const listener of this.listeners)listener(frame);}
 release(){for(const request of this.held.splice(0))this.finishResume(request);}
 finishResume(request:Value){if(this.fail){this.reply(request,{}, {code:-32000,message:"Synthetic activation rejected"});return;}this.loaded=true;this.reply(request,{thread:metadata(),model:"synthetic",modelProvider:"synthetic",cwd:"/synthetic",approvalPolicy:"never",approvalsReviewer:"user",sandbox:{type:"dangerFullAccess"},runtimeWorkspaceRoots:["/synthetic"]});}
 async send(frame:string){const request=JSON.parse(frame);this.requests.push(request);if(request.id===undefined)return;
  switch(request.method){
   case "initialize":this.reply(request,{userAgent:"goal-fixture",capabilities:{extensions:{"opencraft/read-history":{version:1,initialTurnsPage:true,itemDetails:true},"opencraft/thread-goal":{version:1,read:true,write:true}}}});break;
   case "thread/read":this.reply(request,{thread:metadata(),initialTurnsPage:{data:[rows[2]],nextCursor:"older"}});break;
   case "thread/turns/list":this.reply(request,{data:rows.slice(0,2).reverse(),nextCursor:null});break;
   case "thread/resume":if(this.hold)this.held.push(request);else this.finishResume(request);break;
   case "thread/goal/get":this.reply(request,{goal:this.goal});break;
   case "thread/goal/clear":this.goal=null;this.reply(request,{cleared:true});break;
   case "thread/goal/set":this.goal={threadId:"goal-thread",objective:request.params.objective??this.goal?.objective??"existing",status:request.params.status??this.goal?.status??"active",tokenBudget:null,tokensUsed:0,timeUsedSeconds:0,createdAt:1,updatedAt:2};this.started=this.loaded&&this.goal.status==="active";this.reply(request,{goal:this.goal});break;
   default:this.reply(request,{});
  }
 }
 async close(){this.status={state:"closed"};for(const listener of this.statuses)listener(this.status);}
}
/** The browser socket can close while the gateway/native execution survives. */
class NetworkTransport implements DuplexTransport {
 status: TransportStatus = {state:"idle"};
 private statuses = new Set<(status:TransportStatus)=>void>();
 constructor(private readonly inner: DuplexTransport) {}
 private publish(status:TransportStatus) { this.status=status; for(const listener of this.statuses) listener(status); }
 disconnect() { this.publish({state:"closed"}); }
 async connect() { await this.inner.connect(); this.publish({state:"open"}); }
 send(frame:string) { return this.inner.send(frame); }
 subscribeMessage(listener:(frame:string)=>void) { return this.inner.subscribeMessage(frame=>{if(this.status.state==="open")listener(frame);}); }
 subscribeStatus(listener:(status:TransportStatus)=>void) { this.statuses.add(listener);return()=>this.statuses.delete(listener); }
 async close() { this.disconnect();await this.inner.close(); }
}
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(check:()=>boolean){for(let i=0;i<80&&!check();i++)await flush();assert.equal(check(),true);}
async function fixture(t:test.TestContext,persisted:boolean,onRequest?:(event:{type:string;method:string})=>void){
 const directory=mkdtempSync(join(tmpdir(),"goal-activation-")),storage=await openServerDatabase(directory),engine=new GoalEngine();
 const history=new ConversationHistory(storage.database,"local-codex");history.importResult("thread/read",{threadId:"goal-thread",includeTurns:true},{thread:{...metadata(),turns:rows}},0);
 const transport=new NetworkTransport(persisted?new ConversationHistoryTransport(engine,history,undefined,200):engine);
 const runtime=createAppServerWorkbenchRuntime({hostId:"local-codex",transport,autoReconnect:false,requestTimeoutMs:500,onRecoveryEvent(){},installClientHandlers:client=>client.subscribeRequestLifecycle(event=>onRequest?.(event))});
 t.after(async()=>{engine.release();await runtime.dispose();await storage.close();rmSync(directory,{recursive:true,force:true});});
 await runtime.connect();return {runtime,engine,disconnect:()=>transport.disconnect(),count:(method:string)=>engine.requests.filter(request=>request.method===method).length};
}

for(const persisted of [false,true])test(`Goal starts after passive history without replacing loaded pages; persisted=${persisted}`,async t=>{
 const f=await fixture(t,persisted),lease=await f.runtime.acquireThread("goal-thread");lease.setRecoveryVisibility(true);await until(()=>lease.getSnapshot().authoritative);await lease.loadOlder();await until(()=>JSON.stringify(lease.getSnapshot().timeline).includes("retained answer 0"));
 await f.runtime.resources.goals.refresh("goal-thread");assert.equal(f.count("thread/resume"),0,"passive reads must not activate execution");
 const before=lease.getSnapshot().history.cursor;
 await f.runtime.resources.goals.create("goal-thread","Do the requested work");
 assert.equal(f.engine.started,true,"a saved active Goal must have a loaded execution session");
 assert.equal(f.runtime.resources.goals.getSnapshot("goal-thread").goal?.objective,"Do the requested work");
 assert.equal(f.count("thread/resume"),1);const resume=f.engine.requests.find(request=>request.method==="thread/resume")!;assert.equal(resume.params.excludeTurns,true);assert.equal(resume.params.initialTurnsPage,undefined);
 assert.match(JSON.stringify(lease.getSnapshot().timeline),/retained answer 0/);assert.equal(lease.getSnapshot().history.cursor,before);lease.release();
});

test("Goal activation waits for its ACK before dispatching one write",async t=>{
 const f=await fixture(t,true);f.engine.hold=true;const operation=f.runtime.resources.goals.set("goal-thread",{objective:"wait",status:"active"});
 await until(()=>f.count("thread/resume")===1);assert.equal(f.count("thread/goal/set"),0);f.engine.release();await operation;assert.equal(f.count("thread/goal/set"),1);assert.equal(f.engine.started,true);
});

test("rejected Goal activation does not dispatch a write",async t=>{
 const f=await fixture(t,true);f.engine.fail=true;
 await assert.rejects(f.runtime.resources.goals.set("goal-thread",{objective:"no dispatch",status:"active"}),/activation rejected/);
 assert.equal(f.count("thread/goal/set"),0);assert.equal(f.engine.goal,null);
});

test("Goal reads, pause and removal do not activate an idle execution session",async t=>{
 const f=await fixture(t,true);await f.runtime.resources.goals.refresh("goal-thread");
 await f.runtime.resources.goals.set("goal-thread",{status:"paused"});await f.runtime.resources.goals.clear("goal-thread");
 assert.equal(f.count("thread/resume"),0);assert.equal(f.engine.started,false);
});

test("editing a paused Goal retains its status without activating execution",async t=>{
 const f=await fixture(t,true);f.engine.goal={threadId:"goal-thread",objective:"paused",status:"paused",tokenBudget:null,tokensUsed:0,timeUsedSeconds:0,createdAt:1,updatedAt:2};
 await f.runtime.resources.goals.refresh("goal-thread");await f.runtime.resources.goals.set("goal-thread",{objective:"edited while paused"});
 assert.equal(f.count("thread/resume"),0);assert.equal(f.engine.goal?.status,"paused");assert.equal(f.engine.started,false);
});

for(const stage of ["queued","started"])test(`Goal write is fenced after synchronous ${stage} disposal`,async t=>{
 let cancel=()=>{};const f=await fixture(t,true,event=>{if(event.method==="thread/goal/set"&&event.type===stage)cancel();});
 cancel=()=>{void f.runtime.dispose();};
 await assert.rejects(f.runtime.resources.goals.set("goal-thread",{objective:"must not dispatch",status:"active"}));
 assert.equal(f.count("thread/goal/set"),0);
});

test("disposing a held Goal activation never dispatches the late write",async t=>{
 const f=await fixture(t,true);f.engine.hold=true;
 const pending=f.runtime.resources.goals.set("goal-thread",{objective:"late",status:"active"}).then(()=>null,error=>error);
 await until(()=>f.count("thread/resume")===1);const disposed=f.runtime.dispose();f.engine.release();await disposed;
 assert.ok(await pending);assert.equal(f.count("thread/goal/set"),0);
});

for (const persisted of [false, true]) test(`physical reconnect rehydrates subscribed Goal metadata without execution; persisted=${persisted}`, async t => {
 const f = await fixture(t, persisted), goals = f.runtime.resources.goals;
 const unsubscribe = goals.subscribe("goal-thread", () => {}); t.after(unsubscribe);
 f.engine.goal = {threadId:"goal-thread",objective:"before disconnect",status:"active",tokenBudget:null,tokensUsed:0,timeUsedSeconds:0,createdAt:1,updatedAt:2};
 await goals.refresh("goal-thread");
 f.disconnect();
 f.engine.goal = {...f.engine.goal, objective:"changed on another client", status:"paused"};
 await f.runtime.reconnect();
 await until(() => goals.getSnapshot("goal-thread").goal?.objective === "changed on another client");
 assert.equal(goals.getSnapshot("goal-thread").goal?.status, "paused");
 assert.equal(f.count("thread/resume"), 0); assert.equal(f.count("thread/goal/set"), 0);
});

for (const beforePresent of [false, true]) test(`physical reconnect replaces cached Goal presence; beforePresent=${beforePresent}`, async t => {
 const f = await fixture(t, true), goals = f.runtime.resources.goals;
 const goal = {threadId:"goal-thread",objective:"native Goal",status:"active",tokenBudget:null,tokensUsed:0,timeUsedSeconds:0,createdAt:1,updatedAt:2};
 const unsubscribe = goals.subscribe("goal-thread", () => {}); t.after(unsubscribe);
 f.engine.goal = beforePresent ? goal : null; await goals.refresh("goal-thread");
 f.disconnect(); f.engine.goal = beforePresent ? null : goal;
 await f.runtime.reconnect();
 await until(() => goals.getSnapshot("goal-thread").phase === "ready" && Boolean(goals.getSnapshot("goal-thread").goal) !== beforePresent);
 assert.equal(f.count("thread/resume"), 0); assert.equal(f.count("thread/goal/set"), 0);
});

test("logical recovery on the same physical connection retains Goal projection", async t => {
 const f = await fixture(t, true), goals = f.runtime.resources.goals;
 const unsubscribe = goals.subscribe("goal-thread", () => {}); t.after(unsubscribe);
 await goals.refresh("goal-thread"); const reads = f.count("thread/goal/get");
 const snapshot = goals.getSnapshot("goal-thread"), generation = f.runtime.getSnapshot().connectionGeneration;
 await f.runtime.reconnect(); await flush();
 assert.equal(f.runtime.getSnapshot().connectionGeneration, generation);
 assert.equal(goals.getSnapshot("goal-thread"), snapshot);
 assert.equal(f.count("thread/goal/get"), reads);
});
