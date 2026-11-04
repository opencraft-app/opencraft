import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadIdentityDatabase } from "../../apps/opencraft-daemon/src/thread-identity-database.js";
import { ExecutionLeaseStore } from "../../apps/opencraft-daemon/src/execution-lease-store.js";
import { ExecutionLeaseTracker } from "../../apps/opencraft-daemon/src/execution-ownership-transport.js";
const context = (subject: string) => ({ sender: { kind: "employee" as const, loginName: subject }, executionPrincipal: { provider: "employee", subject }, validUntil: Date.now() + 10000 });
const native = { pid: 1, startTicks: "1", incarnation: "engine-1" };
function fixture(t: test.TestContext) {
  const path = mkdtempSync(join(tmpdir(), "oc-goal-identity-")); let owner = new ThreadIdentityDatabase(path);
  t.after(() => { owner.close(); rmSync(path, { recursive: true, force: true }); });
  return { get store() { return new ExecutionLeaseStore(owner.database); }, get db() { return owner.database; },
    get tracker() { return new ExecutionLeaseTracker(new ExecutionLeaseStore(owner.database)); },
    restart() { owner.close(); owner = new ThreadIdentityDatabase(path); },
    resolution(threadId: string, turnId: string) {
      const row = owner.database.prepare("SELECT execution_id FROM execution_leases WHERE thread_id=? AND turn_id=?").get(threadId, turnId)!;
      return new ExecutionLeaseStore(owner.database).resolve({threadId,executionId:String(row.execution_id)});
    } };
}
for (const threadId of ["codex-thread", "pi_thread"]) {
  test(`${threadId}: explicit Goal receipt creates fresh leases after restart`, t => {
    const f = fixture(t); let tracker = f.tracker;
    const prepared = tracker.prepare({ id: 1, method: "thread/goal/set", params: { threadId, objective: "finish", status: "active", __opencraftGoalAuthorization: "forged" } }, context("A"));
    const authorizationId = prepared.params.__opencraftGoalAuthorization;
    assert.ok(authorizationId); assert.notEqual(authorizationId, "forged");
    assert.equal(f.store.goalContinuation(threadId,"premature",{authorizationId:"wrong-native-receipt",round:1},native.incarnation),false);
    tracker.observe({id:1,result:{goal:{status:"active"},__opencraftGoalAuthorization:authorizationId}});
    f.restart(); tracker = f.tracker;
    for (const round of [1, 2]) {
      const turnId = `round-${round}`;
      tracker.observe({method:"turn/started",params:{threadId,turn:{id:turnId},__opencraftGoalExecution:{authorizationId,round}}},native);
      const lease=f.resolution(threadId,turnId); assert.equal(lease.status,"active");
      if(lease.status==="active") { assert.equal(lease.lease.principal?.subject,"A"); assert.equal(lease.lease.engineIncarnation,native.incarnation); }
      assert.equal(f.store.goalContinuation(threadId,`replay-${round}`,{authorizationId,round},native.incarnation),false);
      tracker.observe({method:"turn/started",params:{threadId,turn:{id:`replay-${round}`},__opencraftGoalExecution:{authorizationId,round}}},native);
      tracker.observe({method:"item/started",params:{threadId,turnId:`replay-${round}`,item:{type:"userMessage",clientId:`goal:${authorizationId}:${round}`}}});
      assert.equal(f.resolution(threadId,`replay-${round}`).status,"unknown");
      tracker.observe({method:"turn/completed",params:{threadId,turn:{id:turnId}}});
      assert.equal(f.resolution(threadId,turnId).status,"expired");
    }
    assert.equal(f.db.prepare("SELECT COUNT(DISTINCT execution_id) n FROM execution_goal_rounds").get()!.n,2);
  });
}
test("legacy responses and active Goal without proof never grant identity", t => {
  const f=fixture(t),tracker=f.tracker;
  tracker.prepare({id:1,method:"thread/goal/set",params:{threadId:"t",objective:"finish"}},context("A"));
  tracker.observe({id:1,result:{goal:{status:"active"}}});
  tracker.observe({method:"thread/goal/updated",params:{threadId:"t",goal:{status:"active"}}});
  tracker.observe({method:"turn/started",params:{threadId:"t",turn:{id:"anonymous"}}},native);
  assert.equal(f.resolution("t","anonymous").status,"unknown");
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM execution_goal_rounds").get()!.n,0);
});
test("pause withdraws a running lease; replayed authorizations cannot rearm", t => {
  const f=fixture(t),s=f.store;
  s.capture("t","input",{principal:{provider:"employee",subject:"A"},ownership:"human"});s.started("t","human","input",native.incarnation);
  s.authorizeGoalFromTurn("t","human","grant");
  assert.equal(s.goalContinuation("t","auto",{authorizationId:"grant",round:1},native.incarnation),true);
  f.tracker.observe({method:"thread/goal/updated",params:{threadId:"t",goal:{status:"paused"}}});
  assert.equal(f.resolution("t","auto").status,"expired");
  f.tracker.observe({method:"turn/started",params:{threadId:"t",turn:{id:"auto"},__opencraftGoalExecution:{authorizationId:"grant",round:1}}},native);
  assert.equal(f.resolution("t","auto").status,"expired");
  s.authorizeGoalFromTurn("t","human","grant");
  assert.equal(s.goalContinuation("t","next",{authorizationId:"grant",round:2},native.incarnation),false);
});
test("replacement isolates accounts, stale receipts, other threads and pending human starts", t => {
  const f=fixture(t),tracker=f.tracker;
  const a=tracker.prepare({id:1,method:"thread/goal/set",params:{threadId:"t",status:"active"}},context("A")).params.__opencraftGoalAuthorization;
  const b=tracker.prepare({id:2,method:"thread/goal/set",params:{threadId:"t",status:"active"}},context("B")).params.__opencraftGoalAuthorization;
  tracker.observe({id:1,result:{goal:{status:"active"},__opencraftGoalAuthorization:a}});
  assert.equal(f.store.goalContinuation("t","wrong",{authorizationId:a,round:1}),false);
  tracker.observe({id:2,result:{goal:{status:"active"},__opencraftGoalAuthorization:b}});
  assert.equal(f.store.goalContinuation("other","cross-thread",{authorizationId:b,round:1}),false);
  assert.equal(f.store.goalContinuation("t","auto",{authorizationId:b,round:1},native.incarnation),true);
  const lease=f.resolution("t","auto");if(lease.status==="active") assert.equal(lease.lease.principal?.subject,"B");else assert.fail();
  f.store.finished("t","auto");
  tracker.prepare({id:3,method:"turn/start",params:{threadId:"t",clientUserMessageId:"human",input:[]}},context("A"),native);
  assert.equal(f.store.goalContinuation("t","race",{authorizationId:b,round:2},native.incarnation),false);
});
test("anonymous mutation revokes; ended origins and fabricated grants cannot authorize", t => {
  const f=fixture(t),s=f.store;
  s.authorizeGoalFromTurn("t","nonexistent","forged");
  assert.equal(s.goalContinuation("t","auto",{authorizationId:"forged",round:1}),false);
  s.capture("t","human",{principal:{provider:"employee",subject:"A"},ownership:"human"});s.started("t","human-turn","human",native.incarnation);
  s.finished("t","human-turn");s.authorizeGoalFromTurn("t","human-turn","ended");
  assert.equal(s.goalContinuation("t","auto",{authorizationId:"ended",round:1}),false);
  const id=s.prepareGoal("t",{principal:{provider:"employee",subject:"A"},ownership:"human"})!;s.confirmGoal("t",id);
  f.tracker.prepare({id:1,method:"thread/goal/clear",params:{threadId:"t",__opencraftGoalAuthorization:id}},{sender:null});
  assert.equal(s.goalContinuation("t","auto",{authorizationId:id,round:1}),false);
});

test("explicit anonymous Goal creates an unowned lease without borrowing employee authority", t => {
  const f=fixture(t),tracker=f.tracker;
  const prepared=tracker.prepare({id:1,method:"thread/goal/set",params:{threadId:"t",status:"active",objective:"anonymous work"}},{sender:null});
  const authorizationId=prepared.params.__opencraftGoalAuthorization;
  assert.equal(typeof authorizationId,"string");
  assert.equal(f.store.goalContinuation("t","anonymous",{authorizationId,round:1},native.incarnation),true);
  assert.equal(f.resolution("t","anonymous").status,"unowned");
});

test("Goal observer negotiates capability before sending any private request to an older Host", async t => {
  const { WebSocketServer } = await import("ws");
  const { once } = await import("node:events");
  const { GoalExecutionObserver } = await import("../../apps/opencraft-daemon/src/goal-execution-observer.js");
  const f=fixture(t), server=new WebSocketServer({host:"127.0.0.1",port:0});await once(server,"listening");
  const methods:string[]=[];let ended!:()=>void;
  const rejected=new Promise<void>(resolve=>{ended=resolve;});
  server.on("connection",socket=>{socket.on("message",data=>{
    const p=JSON.parse(data.toString());methods.push(p.method);
    socket.send(JSON.stringify({id:p.id,result:{capabilities:{extensions:{"opencraft/execution-engines":{providers:[{id:"pi",extensions:{}}]}}}}}));
  });socket.once("close",ended);});
  const address=server.address();assert.ok(address&&typeof address!=="string");let ready=false;
  const observer=new GoalExecutionObserver({url:async()=>`ws://127.0.0.1:${address.port}`,store:f.store,native:async()=>{throw Error("Older Host must not inspect execution");},onReady:()=>{ready=true;}});
  t.after(async()=>{await observer.close();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  observer.start();await rejected;
  assert.deepEqual(methods,["initialize"]);assert.equal(ready,false);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM execution_leases").get()!.n,0);
});
