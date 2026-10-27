import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExecutionLeaseStore } from "../../apps/opencraft-daemon/src/execution-lease-store.js";
import { ExecutionLeaseTracker } from "../../apps/opencraft-daemon/src/execution-ownership-transport.js";
import { ThreadIdentityDatabase, THREAD_IDENTITY_SCHEMA } from "../../apps/opencraft-daemon/src/thread-identity-database.js";
import { observeNativeExecutionProcess, observeStandaloneCodexExecution } from "../../apps/opencraft-daemon/src/native-execution-origin.js";
import { spawn } from "node:child_process";
import { openManagedDatabase } from "../../packages/sqlite-node/src/index.js";
const native = { pid: 1, startTicks: "1", incarnation: "native-1" };
const context = (subject: string) => ({ sender: { kind: "employee" as const, loginName: subject },
  executionPrincipal: { provider: "employee", subject }, validUntil: Date.now() + 10000 });
function fixture(t: test.TestContext) {
  const path = mkdtempSync(join(tmpdir(), "oc-independent-ownership-")); let owner = new ThreadIdentityDatabase(path);
  t.after(() => { owner.close(); rmSync(path, {recursive:true,force:true}); });
  const store = () => new ExecutionLeaseStore(owner.database);
  return { store, get tracker() { return new ExecutionLeaseTracker(store()); }, get db() { return owner.database; },
    restart() { owner.close(); owner = new ThreadIdentityDatabase(path); } };
}
test("queue add persists original subject across gateway restart and another employee's start", t => {
  const f = fixture(t); let tracker = f.tracker;
  tracker.prepare({id:1,method:"thread/queue/add",params:{threadId:"t",clientUserMessageId:"input-A",input:[]}},context("A"),native);
  tracker.observe({id:1,result:{queuedSubmission:{id:"native-queue",__opencraftExecutionAdmission:f.store().queueAdmissionToken("t","input-A")}}}); f.restart(); tracker = f.tracker;
  tracker.prepare({id:2,method:"thread/queue/start",params:{threadId:"t",queuedSubmissionId:"native-queue"}},context("B"),native);
  tracker.observe({id:2,result:{turn:{id:"turn"}}});
  const id = String(f.db.prepare("SELECT execution_id FROM execution_leases").get()!.execution_id);
  const result=f.store().resolve({threadId:"t",executionId:id}); assert.equal(result.status,"active");
  if(result.status==="active") { assert.equal(result.lease.principal?.subject,"A"); assert.equal(result.lease.engineIncarnation,native.incarnation); }
  tracker.prepare({id:3,method:"turn/steer",params:{threadId:"t",expectedTurnId:"turn",clientUserMessageId:"B",input:[]}},context("B"),native);
  tracker.observe({id:3,result:{turnId:"turn"}});
  const after=f.store().resolve({threadId:"t",executionId:id}); if(after.status==="active") assert.equal(after.lease.principal?.subject,"A"); else assert.fail("lease lost");
});
test("automatic native queue start waits for native input identity and never uses a later steer", t => {
  const f=fixture(t),tracker=f.tracker;
  tracker.prepare({id:1,method:"thread/queue/add",params:{threadId:"t",clientUserMessageId:"A",input:[]}},context("A"),native);
  tracker.observe({id:1,result:{queuedSubmission:{id:"automatic-queue",__opencraftExecutionAdmission:f.store().queueAdmissionToken("t","A")}}});
  tracker.observe({method:"turn/started",params:{threadId:"t",turn:{id:"turn"}}},native);
  const id=String(f.db.prepare("SELECT execution_id FROM execution_leases").get()!.execution_id);
  assert.equal(f.store().resolve({threadId:"t",executionId:id}).status,"unknown");
  tracker.observe({method:"item/started",params:{threadId:"t",turnId:"turn",item:{type:"userMessage",clientId:"A"}}});
  const bound=f.store().resolve({threadId:"t",executionId:id}); assert.equal(bound.status,"active");if(bound.status==="active")assert.equal(bound.lease.principal?.subject,"A");
  tracker.prepare({id:2,method:"turn/steer",params:{threadId:"t",expectedTurnId:"turn",clientUserMessageId:"B",input:[]}},context("B"),native);
  tracker.observe({method:"item/started",params:{threadId:"t",turnId:"turn",item:{type:"steeringUserMessage",clientId:"B"}}});
  const after=f.store().resolve({threadId:"t",executionId:id});if(after.status==="active")assert.equal(after.lease.principal?.subject,"A");else assert.fail("lease lost");
});
test("internal schedule/goal executions remain unowned and terminal leases never reactivate", t => {
  const f=fixture(t),tracker=f.tracker;
  for(const inputId of ["schedule:one","goal:two"]) {
    tracker.prepare({id:inputId,method:"turn/start",params:{threadId:"t",clientUserMessageId:inputId,input:[]}}, {sender:null},native);
    tracker.observe({id:inputId,result:{turn:{id:inputId}}});
    const row=f.db.prepare("SELECT execution_id FROM execution_leases WHERE turn_id=?").get(inputId)!;
    assert.equal(f.store().resolve({threadId:"t",executionId:String(row.execution_id)}).status,"unowned");
    tracker.observe({method:"turn/completed",params:{threadId:"t",turn:{id:inputId}}});
    tracker.observe({method:"turn/started",params:{threadId:"t",turn:{id:inputId}}},native);
    assert.equal(f.store().resolve({threadId:"t",executionId:String(row.execution_id)}).status,"expired");
  }
});
test("identity v1 upgrade preserves previous data and published ledger; no invented historical principal", t => {
  const path=mkdtempSync(join(tmpdir(),"oc-identity-v1-"));t.after(()=>rmSync(path,{recursive:true,force:true}));
  const old=openManagedDatabase({path:join(path,"thread-identity.sqlite"),migrations:[{version:1,name:"thread-identity",sql:THREAD_IDENTITY_SCHEMA}]});
  old.database.prepare("INSERT INTO ioa_thread_creators VALUES('t','original-label')").run();const row=old.database.prepare("SELECT * FROM schema_migrations").get();old.database.close();
  const next=new ThreadIdentityDatabase(path);try{assert.equal(next.outcome.status,"migrated");
    assert.deepEqual(next.database.prepare("SELECT * FROM schema_migrations WHERE version=1").get(),row);
    assert.equal(next.database.prepare("SELECT login_name FROM ioa_thread_creators").get()!.login_name,"original-label");
    assert.equal(new ExecutionLeaseStore(next.database).getSubmission("t","any"),null);
  }finally{next.close();}
});
test("local managed Host process observer fences process birth and boot", {skip:process.platform!=="linux"}, async()=>{
  const a=await observeNativeExecutionProcess(process.pid),b=await observeNativeExecutionProcess(process.pid);
  assert.deepEqual(a,b);assert.equal(a.pid,process.pid);assert.match(a.startTicks,/^\d+$/u);
  assert.ok(JSON.parse(a.incarnation)[1]);await assert.rejects(observeNativeExecutionProcess(-1));
});

test("live reader refuses a missed completion, unknown native state and replacement while checking", async t => {
  const { LiveExecutionLeaseReader } = await import("../../apps/opencraft-daemon/src/execution-lease-store.js");
  const f = fixture(t); f.store().capture("t", "a", {principal:{provider:"fixture",subject:"A"},ownership:"human"});
  const id=f.store().begin("t","a","native");f.store().started("t","one","a");
  f.db.prepare("UPDATE execution_leases SET admitted_at_ms=1000 WHERE execution_id=?").run(id);
  const query={threadId:"t",engineIncarnation:"native",startedAtMs:1100,uncertaintyMs:20};
  assert.equal((await new LiveExecutionLeaseReader(f.store(),async()=>"finished").resolveJobOrigin(query)).status,"expired");
  assert.equal((await new LiveExecutionLeaseReader(f.store(),async()=>"unknown").resolveJobOrigin(query)).status,"unknown");
  assert.equal((await new LiveExecutionLeaseReader(f.store(),async()=>{throw new Error("native down");}).resolveJobOrigin(query)).status,"unknown");
  assert.equal((await new LiveExecutionLeaseReader(f.store(),async()=>"active").resolveJobOrigin(query)).status,"active");
  const changed=new LiveExecutionLeaseReader(f.store(),async()=>{f.store().finished("t","one");return "active";});
  assert.equal((await changed.resolveJobOrigin(query)).status,"expired");
});

test("native inspector performs only a bounded read and never guesses from empty/malformed history", async()=>{
  const { createNativeExecutionTurnInspector }=await import("../../apps/opencraft-daemon/src/native-execution-inspector.js");
  const lease={threadId:"t",turnId:"one",engineIncarnation:"native"} as any;
  const calls:any[]=[];
  const inspect=createNativeExecutionTurnInspector(async(method,params)=>{calls.push([method,params]);return {data:[{id:"one",status:"inProgress"}]};});
  assert.equal(await inspect(lease),"active");assert.deepEqual(calls,[["thread/turns/list",{threadId:"t",limit:1,sortDirection:"desc",itemsView:"notLoaded"}]]);
  for(const [response,expected] of [[{data:[{id:"two",status:"inProgress"}]},"finished"],[{data:[{id:"one",status:"completed"}]},"finished"],[{data:[]},"unknown"],[{data:[{id:"one",status:"future"}]},"unknown"]] as const)
    assert.equal(await createNativeExecutionTurnInspector(async()=>response)(lease),expected);
  assert.equal(await createNativeExecutionTurnInspector(async()=>{throw new Error("offline");})(lease),"unknown");
});

test("independent Host inspection never answers unsolicited tools or claims an execution lane", async t=>{
  const { WebSocketServer }=await import("ws");
  const { createWebSocketExecutionTurnInspector }=await import("../../apps/opencraft-daemon/src/native-execution-inspector.js");
  const server=new WebSocketServer({port:0,host:"127.0.0.1"});
  await new Promise<void>(resolve=>server.once("listening",resolve));
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const sent:any[]=[];
  server.on("connection",socket=>socket.on("message",raw=>{
    const v=JSON.parse(String(raw));sent.push(v);
    if(v.method==="initialize") {
      socket.send(JSON.stringify({id:v.id,result:{capabilities:{}}}));
      socket.send(JSON.stringify({id:"unsolicited-tool",method:"item/tool/call",params:{threadId:"t",turnId:"one"}}));
    }
    if(v.method==="thread/turns/list")socket.send(JSON.stringify({id:v.id,result:{data:[{id:"one",status:"inProgress"}]}}));
  }));
  const port=(server.address() as import("node:net").AddressInfo).port;
  const probe=await createWebSocketExecutionTurnInspector(async()=>`ws://127.0.0.1:${port}/rpc?token=fixture`);t.after(()=>probe.close());
  assert.equal(await probe.inspect({threadId:"t",turnId:"one",engineIncarnation:"native"} as any),"active");
  assert.deepEqual(sent.map(v=>v.method),["initialize","initialized","thread/turns/list"]);
  assert.ok(sent.every(v=>v.id!=="unsolicited-tool"));assert.ok(sent.every(v=>!v.params?.callbackLaneId));
  probe.close();assert.equal(await probe.inspect({threadId:"t",turnId:"one",engineIncarnation:"native"} as any),"unknown");
});


test("a legacy queue replay with missing original principal cannot acquire the replaying employee's identity", t=>{
  const f=fixture(t),tracker=f.tracker;
  tracker.prepare({id:1,method:"thread/queue/add",params:{threadId:"t",clientUserMessageId:"legacy-input",input:[]}},context("B"),native);
  tracker.observe({id:1,result:{queuedSubmission:{id:"old-queue",createdAt:1}}});
  tracker.prepare({id:2,method:"thread/queue/start",params:{threadId:"t",queuedSubmissionId:"old-queue"}},context("B"),native);
  tracker.observe({id:2,result:{turn:{id:"legacy-turn"}}});
  const id=String(f.db.prepare("SELECT execution_id FROM execution_leases").get()!.execution_id);
  assert.equal(f.store().resolve({threadId:"t",executionId:id}).status,"unknown");
});

test("an automatic A queue Turn never binds the sole pending B start that loses admission", t=>{
  const f=fixture(t),tracker=f.tracker;
  tracker.prepare({id:1,method:"thread/queue/add",params:{threadId:"t",clientUserMessageId:"A",input:[]}},context("A"),native);
  tracker.observe({id:1,result:{queuedSubmission:{id:"queue-A",__opencraftExecutionAdmission:f.store().queueAdmissionToken("t","A")}}});
  tracker.prepare({id:2,method:"turn/start",params:{threadId:"t",clientUserMessageId:"B",input:[]}},context("B"),native);
  const bId=String(f.db.prepare("SELECT execution_id FROM execution_leases WHERE input_id='B'").get()!.execution_id);
  tracker.observe({method:"turn/started",params:{threadId:"t",turn:{id:"queue-turn-A",items:[{type:"userMessage",clientId:"A"}]}}},native);
  tracker.observe({id:2,error:{code:-32600,message:"already active"}});
  const row=f.db.prepare("SELECT execution_id FROM execution_leases WHERE turn_id='queue-turn-A'").get()!;
  const result=f.store().resolve({threadId:"t",executionId:String(row.execution_id)});
  assert.equal(result.status,"active");if(result.status==="active")assert.equal(result.lease.principal?.subject,"A");
  assert.equal(f.store().resolve({threadId:"t",executionId:bId}).status,"expired");
});

test("steer cannot claim an unresolved native Turn through either steering projection", t=>{
  const f=fixture(t),tracker=f.tracker;
  tracker.prepare({id:1,method:"thread/queue/add",params:{threadId:"t",clientUserMessageId:"A",input:[]}},context("A"),native);
  tracker.observe({id:1,result:{queuedSubmission:{id:"queue-A",__opencraftExecutionAdmission:f.store().queueAdmissionToken("t","A")}}});
  tracker.observe({method:"turn/started",params:{threadId:"t",turn:{id:"turn"}}},native);
  const id=String(f.db.prepare("SELECT execution_id FROM execution_leases WHERE turn_id='turn'").get()!.execution_id);
  tracker.prepare({id:2,method:"turn/steer",params:{threadId:"t",expectedTurnId:"turn",clientUserMessageId:"B",input:[]}},context("B"),native);
  for(const item of [{type:"steeringUserMessage",clientId:"B"},{type:"userMessage",clientId:"B",__opencraftMessageKind:"steering"},{type:"userMessage",clientId:"B"}]) {
    tracker.observe({method:"item/started",params:{threadId:"t",turnId:"turn",item}});
    assert.equal(f.store().resolve({threadId:"t",executionId:id}).status,"unknown");
  }
  tracker.observe({id:2,result:{turnId:"turn"}});
  tracker.observe({method:"item/started",params:{threadId:"t",turnId:"turn",item:{type:"userMessage",clientId:"A"}}});
  const result=f.store().resolve({threadId:"t",executionId:id});assert.equal(result.status,"active");if(result.status==="active")assert.equal(result.lease.principal?.subject,"A");
});

test("pre-ACK Gateway loss recovers the original execution ID, incarnation and job birth interval", t=>{
  const f=fixture(t);let tracker=f.tracker;
  tracker.prepare({id:1,method:"turn/start",params:{threadId:"t",clientUserMessageId:"A",input:[]}},context("A"),native);
  const old=f.db.prepare("SELECT execution_id,generation FROM execution_leases").get()!;
  f.db.prepare("UPDATE execution_leases SET admitted_at_ms=1000 WHERE execution_id=?").run(old.execution_id!);
  f.store().suspend();f.restart();tracker=f.tracker;
  tracker.prepare({id:2,method:"turn/steer",params:{threadId:"t",expectedTurnId:"native-turn",clientUserMessageId:"B",input:[]}},context("B"),native);
  tracker.prepare({id:3,method:"thread/read",params:{threadId:"t",includeTurns:true}},context("B"));
  tracker.observe({id:3,result:{thread:{id:"t",turns:[{id:"native-turn",status:"inProgress",items:[
    {type:"userMessage",clientId:"A"},{type:"userMessage",clientId:"B",__opencraftMessageKind:"steering"}]}]}}});
  const restored=f.store().resolveJobOrigin({threadId:"t",engineIncarnation:native.incarnation,startedAtMs:1100,uncertaintyMs:20});
  assert.equal(restored.status,"active");if(restored.status==="active") {
    assert.equal(restored.lease.executionId,old.execution_id);assert.equal(restored.lease.generation,old.generation);
    assert.equal(restored.lease.admittedAtMs,1000);assert.equal(restored.lease.engineIncarnation,native.incarnation);assert.equal(restored.lease.principal?.subject,"A");
  }
});


test("ACP live inspection uses the admitted public Turn and input, never native history numbering", async t=>{
  const {createHostExecutionTurnInspector}=await import("../../apps/opencraft-daemon/src/native-execution-inspector.js");
  const lease={threadId:"dsh_acp_public",turnId:"acp-turn-public",inputId:"A"} as any;
  let fallback=0;
  for(const [observation,expected] of [
    [{pid:42,turn:{id:"acp-turn-public",status:"inProgress",inputId:"A"}},"active"],
    [{pid:42,turn:{id:"acp-turn-public",status:"inProgress",inputId:"B"}},"unknown"],
    [{pid:42,turn:{id:"acp-turn-public",status:"unconfirmed",inputId:"A"}},"unknown"],
    [{pid:42,turn:{id:"acp-turn-new",status:"inProgress",inputId:"B"}},"finished"],
    [{pid:42,turn:null},"unknown"],
    [{pid:42},"finished"],
  ] as const) assert.equal(await createHostExecutionTurnInspector(async()=>observation,async()=>{fallback++;return "finished";})(lease),expected);
  assert.equal(fallback,1);
});

test('a historical queue receipt cannot acquire a new principal through a plausible clock timestamp', t=>{
  const f=fixture(t),tracker=f.tracker;
  const prepared=tracker.prepare({id:1,method:'thread/queue/add',params:{threadId:'t',clientUserMessageId:'old-input',input:[],__opencraftExecutionAdmission:'renderer-forged'}},context('B'),native);
  assert.notEqual(prepared.params.__opencraftExecutionAdmission,'renderer-forged');
  tracker.observe({id:1,result:{queuedSubmission:{id:'old-native-queue',createdAt:Date.now()+10000,__opencraftExecutionAdmission:'original-unknown-nonce'}}});
  tracker.prepare({id:2,method:'thread/queue/start',params:{threadId:'t',queuedSubmissionId:'old-native-queue'}},context('B'),native);
  tracker.observe({id:2,result:{turn:{id:'old-queue-turn'}}});
  const row=f.db.prepare("SELECT execution_id FROM execution_leases WHERE turn_id='old-queue-turn'").get()!;
  assert.equal(f.store().resolve({threadId:'t',executionId:String(row.execution_id)}).status,'unknown');
});

test("standalone Codex rejects unrelated processes and routing health", async () => {
  await assert.rejects(observeStandaloneCodexExecution({pid:process.pid,codexPid:process.pid}));
  await assert.rejects(observeStandaloneCodexExecution({pid:process.pid,codexPid:process.pid,routingEpoch:"routed"}));
});

test("split Core attests the independent runtime's direct native child", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  try {
    const native = await observeStandaloneCodexExecution({ pid: process.ppid, appServerPid: process.pid, codexPid: child.pid! });
    assert.equal(native.incarnation, (await observeNativeExecutionProcess(child.pid!)).incarnation);
    await assert.rejects(observeStandaloneCodexExecution({ pid: process.pid, appServerPid: process.ppid, codexPid: child.pid! }));
  } finally { child.kill(); }
});
