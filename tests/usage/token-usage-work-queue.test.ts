import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TokenUsageStateDatabase } from "../../apps/opencraft-daemon/src/token-usage-state-database.js";
import { OpenCraftTokenUsageLedger, type UsageSource } from "../../apps/opencraft-daemon/src/token-usage-ledger.js";
import { TokenUsageWorkQueue } from "../../apps/opencraft-daemon/src/token-usage-work-queue.js";
const key={threadId:"thread",turnId:"turn"};
const source=(sourceId:string):UsageSource=>({...key,lineage:"native",sourceId,kind:"response",version:0,provider:null,model:null,counts:{totalTokens:"100"}});
async function fixture(body:(state:TokenUsageStateDatabase,ledger:OpenCraftTokenUsageLedger)=>Promise<void>){
  const directory=await mkdtemp(join(tmpdir(),"oc-usage-queue-"));const state=new TokenUsageStateDatabase(directory);
  const ledger=new OpenCraftTokenUsageLedger(state,"server",()=>1000);
  ledger.startTurn(key,1000,"human",true);
  ledger.recordInput(key,{inputId:"input",actorId:"A",actorKind:"human",mode:"start",admission:"confirmed"});
  try{await body(state,ledger);}finally{state.close();await rm(directory,{recursive:true,force:true});}
}
test("bounded asynchronous ingestion marks saturation without synchronous writes or throwing diagnostic errors",()=>fixture(async(_state,ledger)=>{
  const queue=new TokenUsageWorkQueue(ledger,{capacity:2,batchSize:1,missing:()=>{throw new Error("synthetic diagnostic failure");}});
  try {
    assert.equal(queue.enqueue({kind:"source",source:source("one")}),true);
    assert.equal(queue.enqueue({kind:"source",source:source("two")}),true);
    assert.equal(queue.enqueue({kind:"source",source:source("three")}),false);
    assert.equal(ledger.readTurn(key)?.observedTokens,null);
    assert.equal(queue.metrics().queued,2);assert.equal(queue.metrics().missing,1);
    await tick();await tick();await tick();
    assert.equal(ledger.readTurn(key)?.observedTokens,"200");
    assert.equal(queue.metrics().queued,0);assert.equal(queue.metrics().processed,2);
  } finally {queue.close();}
}));
test("write failure does not cancel later ingestion or advance failed facts; durable replay can repair the gap",()=>fixture(async(state,ledger)=>{
  const errors:string[]=[];
  const queue=new TokenUsageWorkQueue(ledger,{batchSize:1,missing:reason=>errors.push(reason)});
  try {
    state.database.exec("CREATE TEMP TRIGGER usage_queue_fault BEFORE INSERT ON token_usage_allocations BEGIN SELECT RAISE(ABORT,'synthetic fault'); END");
    queue.enqueue({kind:"source",source:{...source("one"),cursor:"1"}});await tick();await tick();
    assert.deepEqual(errors,["storage-write"]);assert.equal(ledger.checkpoint("native"),null);
    assert.equal(ledger.readTurn(key)?.observedTokens,null);
    state.database.exec("DROP TRIGGER usage_queue_fault");
    queue.enqueue({kind:"source",source:{...source("two"),cursor:"2"}});await tick();await tick();
    assert.equal(ledger.readTurn(key)?.observedTokens,"100");
    queue.enqueue({kind:"source",source:source("one")});await tick();await tick();
    assert.equal(ledger.readTurn(key)?.observedTokens,"200");assert.equal(queue.metrics().missing,1);
  } finally {queue.close();}
}));
