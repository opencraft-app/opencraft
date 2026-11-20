import assert from "node:assert/strict";
import { test } from "node:test";
import { AppServerClientError, AppServerRpcError } from "@opencraft/appserver-client";
import { GoalMutationError, ThreadGoalResource } from "../../packages/workbench-runtime/src/thread-goal-resource.ts";
import type { ThreadGoal } from "@opencraft/appserver-protocol/generated/v2";
const goal = (status: ThreadGoal["status"] = "blocked"): ThreadGoal => ({ threadId: "one", objective: "keep objective", status, tokenBudget: null, tokensUsed: 868909, timeUsedSeconds: 6096, createdAt: 1, updatedAt: 2 });
const capability = () => ({ version: 1 as const, read: true, write: true });
function deferred<T>() { let resolve!: (v:T)=>void; const promise=new Promise<T>(r=>resolve=r);return {promise,resolve}; }
for (const [cause, code, diagnosticCode] of [
  [new AppServerRpcError({code:-32601,message:"private server path",data:{secret:"do not display"}}), "requestRejected", "RPC -32601"],
  [new AppServerRpcError({code:-32602,message:"invalid request"}), "requestRejected", "RPC -32602"],
  [new AppServerRpcError({code:-32001,message:"server failure",data:{retryable:true}}), "serverError", "RPC -32001"],
  [new AppServerClientError("NOT_CONNECTED","private socket"), "requestRejected", "NOT_CONNECTED"],
  [new AppServerClientError("NOT_DISPATCHED","not admitted"), "requestRejected", "NOT_DISPATCHED"],
  [new AppServerClientError("QUEUE_FULL","full"), "requestRejected", "QUEUE_FULL"],
  [new AppServerClientError("CLOSED","closed"), "requestRejected", "CLOSED"],
  [new AppServerClientError("TIMEOUT","lost ACK"), "outcomeUnknown", "TIMEOUT"],
  [new AppServerClientError("ABORTED","could have dispatched"), "outcomeUnknown", "ABORTED"],
  [new AppServerClientError("TRANSPORT_ERROR","disconnect"), "outcomeUnknown", "TRANSPORT_ERROR"],
  [new Error("untyped error"), "outcomeUnknown", null],
] as const) test(`Goal failure ${diagnosticCode ?? "untyped"} preserves cause and only reconciles`, async()=>{
  let reads=0,writes=0;
  const resource=new ThreadGoalResource({capability,get:async()=>{reads++;return {goal:goal()}},set:async()=>{writes++;throw cause},clear:async()=>({cleared:true})});
  await assert.rejects(resource.set("one",{status:"active"}),error=>{
    assert.ok(error instanceof GoalMutationError);assert.equal(error.code,code);assert.equal(error.cause,cause);assert.equal(error.diagnosticCode,diagnosticCode);assert.ok(!error.message.includes("private"));return true;
  });
  assert.equal(reads,1);assert.equal(writes,1);assert.equal(resource.getSnapshot("one").goal?.status,"blocked");assert.equal(resource.getSnapshot("one").busy,false);
});
test("lost ACK followed by active state is not an execution receipt or a successful write",async()=>{
  let writes=0;const cause=new AppServerClientError("TIMEOUT","lost ACK");
  const resource=new ThreadGoalResource({capability,get:async()=>({goal:goal("active")}),set:async()=>{writes++;throw cause},clear:async()=>({cleared:true})});
  await assert.rejects(resource.set("one",{status:"active"}),{code:"outcomeUnknown"});
  assert.deepEqual(resource.getSnapshot("one").goal,goal("active"));assert.equal(writes,1);assert.equal(resource.getSnapshot("one").error?.cause,cause);
});
test("failed reconciliation retains original write diagnostic and cached data",async()=>{
  const cause=new AppServerRpcError({code:-32001,message:"write failed"});let reads=0;
  const resource=new ThreadGoalResource({capability,get:async()=>{if(++reads>1)throw Error("read failed");return {goal:goal()}},set:async()=>{throw cause},clear:async()=>({cleared:true})});
  await resource.refresh("one");await assert.rejects(resource.set("one",{status:"active"}),{code:"serverError"});
  assert.equal(reads,2);assert.equal(resource.getSnapshot("one").phase,"error");assert.equal(resource.getSnapshot("one").goal?.status,"blocked");assert.equal(resource.getSnapshot("one").error?.cause,cause);
});
test("read reconciliation stays single-flight and a newer notification wins",async()=>{
  const read=deferred<{goal:ThreadGoal}>();let reads=0,writes=0;
  const resource=new ThreadGoalResource({capability,get:()=>{reads++;return read.promise},set:async()=>{writes++;throw new AppServerClientError("TIMEOUT","lost")},clear:async()=>({cleared:true})});
  const pending=resource.set("one",{status:"active"});const rejected=assert.rejects(pending,{code:"outcomeUnknown"});await new Promise(r=>setImmediate(r));
  assert.equal(resource.getSnapshot("one").busy,true);await assert.rejects(resource.set("one",{status:"active"}),/already in progress/);
  resource.observe("one",goal("complete"));read.resolve({goal:goal("active")});await rejected;
  assert.equal(resource.getSnapshot("one").goal?.status,"complete");assert.equal(reads,1);assert.equal(writes,1);
});
test("connection reset fences a late failed write and its reconciliation",async()=>{
  const write=deferred<void>();let reads=0;
  const resource=new ThreadGoalResource({capability,get:async()=>{reads++;return {goal:goal("complete")}},set:async()=>{await write.promise;throw new AppServerRpcError({code:-32010,message:"version",data:{reason:"goal_version_required"}})},clear:async()=>({cleared:true})});
  const pending=resource.set("one",{status:"active"});const rejected=assert.rejects(pending,{code:"versionRequired"});resource.reset();await resource.refresh("one");write.resolve();await rejected;
  assert.equal(reads,1);assert.equal(resource.getSnapshot("one").goal?.status,"complete");assert.equal(resource.getSnapshot("one").error,null);
});
test("version conflict reconciles exactly once and never upgrades or repeats the write",async()=>{
  let reads=0,writes=0;const cause=new AppServerRpcError({code:-32009,message:"stale",data:{reason:"goal_version_conflict"}});
  const resource=new ThreadGoalResource({capability,get:async()=>({goal:goal(),version:String(++reads)}),set:async(_id,change)=>{writes++;assert.equal(change.expectedVersion,"1");throw cause},clear:async()=>({cleared:true})});
  await resource.refresh("one");await assert.rejects(resource.set("one",{status:"active"}),{code:"conflict"});await new Promise(r=>setImmediate(r));assert.equal(reads,2);assert.equal(writes,1);assert.equal(resource.getSnapshot("one").version,"2");assert.equal(resource.getSnapshot("one").error?.cause,cause);
});
test("clear and create use the same diagnostic path without replay",async()=>{
  for(const method of ["clear","create"] as const){let reads=0,writes=0;const cause=new AppServerClientError("TIMEOUT","lost");const resource=new ThreadGoalResource({capability,get:async()=>{reads++;return {goal:null}},set:async()=>{writes++;throw cause},clear:async()=>{writes++;throw cause}});await assert.rejects(method==="clear"?resource.clear("one"):resource.create("one","new goal"),{code:"outcomeUnknown"});assert.equal(writes,1);assert.equal(reads,method==="clear"?1:2);}
});
