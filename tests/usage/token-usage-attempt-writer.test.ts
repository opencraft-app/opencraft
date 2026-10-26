import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { TokenUsageAttemptWriter } from "../../apps/opencraft-daemon/src/token-usage-attempt-writer.js";
import { TokenUsageStateDatabase } from "../../apps/opencraft-daemon/src/token-usage-state-database.js";
import { OpenCraftTokenUsageLedger, type UsageSubmission } from "../../apps/opencraft-daemon/src/token-usage-ledger.js";
const entry=new URL("../../apps/opencraft-daemon/src/token-usage-query-worker.ts",import.meta.url).pathname;
const input=(inputId:string):UsageSubmission=>({threadId:"thread",inputId,actorId:"human",actorKind:"human",sourceKind:"human",mode:"start",submittedAt:1000});
test("attempt worker acknowledges durable immutable metadata, preserves pending attempts and drains on close",async()=>{
 const root=await mkdtemp(join(tmpdir(),"oc-attempt-writer-")),state=new TokenUsageStateDatabase(root),ledger=new OpenCraftTokenUsageLedger(state,"fixture");
 ledger.recordAttempt("already-pending",input("earlier"));
 const writer=new TokenUsageAttemptWriter({entry,directory:root,serverId:"fixture"});
 try{
  const metadata=input("captured"),writing=writer.record("captured",metadata);metadata.actorId="mutated";await writing;
  assert.equal(state.database.prepare("SELECT actor_id FROM token_usage_attempts WHERE attempt_id='captured'").get()!.actor_id,"human");
  assert.equal(state.database.prepare("SELECT outcome FROM token_usage_attempts WHERE attempt_id='already-pending'").get()!.outcome,"pending");
  await assert.rejects(writer.record("captured",input("changed-identity")));
  const jobs=Array.from({length:40},(_,i)=>writer.record("drain-"+i,input("drain-"+i)));
  await writer.close();await Promise.all(jobs);
  assert.equal(state.database.prepare("SELECT count(*) AS n FROM token_usage_attempts").get()!.n,42);
  await assert.rejects(writer.record("closed",input("closed")));
 }finally{await writer.close();state.close();await rm(root,{recursive:true,force:true});}
});
test("attempt writer retries source contention without blocking the Host event loop",async()=>{
 const root=await mkdtemp(join(tmpdir(),"oc-attempt-busy-")),state=new TokenUsageStateDatabase(root);new OpenCraftTokenUsageLedger(state,"fixture");
 const writer=new TokenUsageAttemptWriter({entry,directory:root,serverId:"fixture"});
 try{
  await writer.record("warm",input("warm"));state.database.exec("BEGIN IMMEDIATE");
  let ticked=false;const timer=setTimeout(()=>{ticked=true;state.database.exec("COMMIT");},100);
  await writer.record("after-lock",input("after-lock"));clearTimeout(timer);
  assert.equal(ticked,true);assert.equal(state.database.prepare("SELECT outcome FROM token_usage_attempts WHERE attempt_id='after-lock'").get()!.outcome,"pending");
 }finally{await writer.close();state.close();await rm(root,{recursive:true,force:true});}
});

test("concurrent attempts and confirmed admissions commit in order on the same writer",async()=>{
 const root=await mkdtemp(join(tmpdir(),"oc-attempt-admissions-")),state=new TokenUsageStateDatabase(root),ledger=new OpenCraftTokenUsageLedger(state,"fixture",()=>1000);
 const key={threadId:"thread",turnId:"turn"};ledger.startTurn(key,1000,"human",true);
 const writer=new TokenUsageAttemptWriter({entry,directory:root,serverId:"fixture"});
 try{
  await Promise.all(Array.from({length:100},async(_,i)=>{
   const id="concurrent-"+i,identity=input(id);
   await writer.record(id,identity);await writer.outcome(id,"accepted",key.turnId);await writer.admit(key,id,null,identity);
  }));
  assert.equal(state.database.prepare("SELECT count(*) AS n FROM token_usage_attempts WHERE outcome='accepted'").get()!.n,100);
  assert.equal(state.database.prepare("SELECT count(*) AS n FROM token_usage_inputs WHERE admission='confirmed' AND actor_id='human'").get()!.n,100);
  assert.equal(state.database.prepare("SELECT count(*) AS n FROM token_usage_gaps").get()!.n,0);
 }finally{await writer.close();state.close();await rm(root,{recursive:true,force:true});}
});

test("queued attempts expire from ingress rather than waiting one retry budget per predecessor",async()=>{
 const root=await mkdtemp(join(tmpdir(),"oc-attempt-deadline-")),state=new TokenUsageStateDatabase(root);new OpenCraftTokenUsageLedger(state,"fixture");
 const writer=new TokenUsageAttemptWriter({entry,directory:root,serverId:"fixture"});
 try{
  await writer.record("warm",input("warm"));state.database.exec("BEGIN IMMEDIATE");
  const results=await Promise.allSettled(Array.from({length:20},(_,i)=>writer.record("blocked-"+i,input("blocked-"+i))));
  assert.equal(results.filter(result=>result.status==="rejected").length,20);
  state.database.exec("COMMIT");
  await writer.record("recovered",input("recovered"));
  assert.equal(state.database.prepare("SELECT count(*) AS n FROM token_usage_attempts").get()!.n,2);
 }finally{try{state.database.exec("ROLLBACK");}catch{}await writer.close();state.close();await rm(root,{recursive:true,force:true});}
});
