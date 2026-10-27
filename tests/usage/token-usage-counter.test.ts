import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {TokenUsageStateDatabase} from "../../apps/opencraft-daemon/src/token-usage-state-database.js";
import {OpenCraftTokenUsageLedger} from "../../apps/opencraft-daemon/src/token-usage-ledger.js";
async function fixture(body:(ledger:OpenCraftTokenUsageLedger,state:TokenUsageStateDatabase)=>void){const path=await mkdtemp(join(tmpdir(),"oc-counter-")),state=new TokenUsageStateDatabase(path);try{body(new OpenCraftTokenUsageLedger(state,"server",()=>1000),state);}finally{state.close();await rm(path,{recursive:true,force:true});}}
const key={threadId:"ephemeral",turnId:"one"};
const counts=(n:number)=>({totalTokens:String(n),inputTokens:String(n*.8),cachedInputTokens:String(n*.3),cacheWriteInputTokens:"0",outputTokens:String(n*.2),reasoningOutputTokens:String(n*.1)});
function participant(ledger:OpenCraftTokenUsageLedger,target=key){ledger.recordInput(target,{inputId:target.turnId+"A",actorId:"A",actorKind:"human",mode:"start",admission:"confirmed"});}
test("proven empty ephemeral baseline separates cumulative totals into exact durable turn snapshots",()=>fixture(ledger=>{
 assert.equal(ledger.registerNativeCounter(key.threadId,"epoch"),true);
 assert.equal(ledger.registerNativeCounter(key.threadId,"other"),false);
 ledger.startNativeCounterTurn(key,1000,"epoch");participant(ledger);
 ledger.recordNativeCounter(key,"epoch",counts(1000));ledger.recordNativeCounter(key,"epoch",counts(1000));
 ledger.completeNativeCounterTurn(key,"epoch","completed");assert.equal(ledger.readTurn(key)?.allocationState,"settled");
 const second={...key,turnId:"two"};ledger.startNativeCounterTurn(second,1001,"epoch");participant(ledger,second);
 ledger.recordNativeCounter(second,"epoch",counts(2000));ledger.completeNativeCounterTurn(second,"epoch","completed");
 assert.equal(ledger.readTurn(second)?.observedTokens,"1000");assert.equal(ledger.readAllocations(second)[0]!.tokens,"1000");
 assert.equal(ledger.readTurn(key)?.observedTokens,"1000");
}));
test("counter reset, missing prior report and unproven lineage never silently establish a fresh baseline",()=>fixture((ledger,state)=>{
 assert.throws(()=>ledger.startNativeCounterTurn(key,1000,"unknown"),/Unverified/);
 ledger.registerNativeCounter(key.threadId,"epoch");ledger.startNativeCounterTurn(key,1000,"epoch");participant(ledger);
 ledger.completeNativeCounterTurn(key,"epoch","interrupted");
 assert.throws(()=>ledger.startNativeCounterTurn({...key,turnId:"two"},1001,"epoch"),/incomplete/);
 ledger.recordNativeCounter(key,"epoch",counts(1000));
 assert.throws(()=>ledger.recordNativeCounter(key,"epoch",counts(900)),/reset/);
 assert.equal(ledger.readTurn(key)?.observedTokens,"1000");
 ledger.breakNativeCounter(key.threadId);
 const restored=new OpenCraftTokenUsageLedger(state,"server",()=>1100);
 assert.throws(()=>restored.recordNativeCounter(key,"epoch",counts(2000)),/Unverified/);
 assert.equal(restored.readTurn(key)?.observedTokens,"1000");
}));
