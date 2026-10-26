import assert from "node:assert/strict";
import { mkdtemp,rm,readFile,writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { TokenUsageStateDatabase } from "../../apps/opencraft-daemon/src/token-usage-state-database.js";
import { OpenCraftTokenUsageLedger } from "../../apps/opencraft-daemon/src/token-usage-ledger.js";
import { TokenUsageQuery } from "../../apps/opencraft-daemon/src/token-usage-query.js";
import { retireLegacyTokenProjection,restoreLegacyTokenProjection,proveTokenUsageRebuild,LEGACY_PROJECTION_TABLES } from "../../apps/opencraft-daemon/src/token-usage-projection-retirement.js";
test("retirement preserves facts and missing history, backs up complete projections, and restores ledger allocations",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"oc-projection-retire-")),state=new TokenUsageStateDatabase(directory);
 const ledger=new OpenCraftTokenUsageLedger(state,"fixture",()=>1000),key={threadId:"missing-thread",turnId:"turn"};
 ledger.startTurn(key,1000,"human",true);ledger.recordInput(key,{inputId:"A",actorId:"A",actorKind:"human",mode:"start",admission:"confirmed"});
 ledger.recordSource({...key,lineage:"old",sourceId:"old-response",kind:"response",version:0,provider:"provider",model:"model",counts:{totalTokens:"7"}});
 const before=ledger.readAllocations(key),archivePath=join(directory,"projection.jsonl.gz"),options={directory,nativeHome:directory,serverId:"fixture",archivePath};
 try{
  const result=await retireLegacyTokenProjection(options);assert.equal(result.proof.identical,true);
  assert.equal((await retireLegacyTokenProjection(options)).sha256,result.sha256);
  assert.equal(state.database.prepare("SELECT count(*) AS n FROM token_usage_sources").get()!.n,1);
  assert.equal(state.database.prepare("SELECT count(*) AS n FROM token_usage_inputs").get()!.n,1);
  for(const table of LEGACY_PROJECTION_TABLES)assert.equal(state.database.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,0);
  assert.equal((await proveTokenUsageRebuild(options)).identical,true);
  const derivedSource=new OpenCraftTokenUsageLedger(state,"fixture",()=>1000);
  assert.throws(()=>derivedSource.query({},()=>({actorId:"A",administrator:true})),/restoration/);
  assert.throws(()=>new TokenUsageQuery(state,"fixture").read({from:"1970-01-01",through:"1970-01-01"},()=>({actorId:"A",administrator:true})),/restoration/);
  derivedSource.recordInput(key,{inputId:"B",actorId:"B",actorKind:"human",mode:"steer",admission:"confirmed"});
  derivedSource.setEnabled(false);
  assert.equal(state.database.prepare("SELECT count(*) AS n FROM token_usage_daily").get()!.n,0);
  assert.equal(state.database.prepare("SELECT count(*) AS n FROM token_usage_allocations").get()!.n,0);
  const archive=await readFile(archivePath);await writeFile(archivePath,archive.subarray(0,archive.length-8));
  await assert.rejects(restoreLegacyTokenProjection(options));assert.ok(derivedSource.checkpoint("legacy-projection-retired-v1"));
  await writeFile(archivePath,archive);assert.equal((await restoreLegacyTokenProjection(options)).restoredProjectionExact,true);
  assert.equal(state.database.prepare("SELECT count(*) AS n FROM token_usage_sources").get()!.n,1);
  assert.equal(state.database.prepare("SELECT count(*) AS n FROM token_usage_inputs").get()!.n,2);
  assert.equal(ledger.readAllocations(key).reduce((n,row)=>n+BigInt(row.tokens),0n),7n);
  assert.equal(ledger.readAllocations(key).length,2);assert.equal(before[0]!.tokens,"7");assert.deepEqual(await readFile(archivePath),archive);
  assert.equal(ledger.checkpoint("legacy-projection-retired-v1"),null);
 }finally{state.close();await rm(directory,{recursive:true,force:true});}
});

test("ledger rollback rebuilds stale shares even when old projection rows were never retired",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"oc-projection-stale-")),state=new TokenUsageStateDatabase(directory),key={threadId:"thread",turnId:"turn"};
 const original=new OpenCraftTokenUsageLedger(state,"fixture",()=>1000);
 try{
  original.startTurn(key,1000,"human",true);original.recordInput(key,{inputId:"A",actorId:"A",actorKind:"human",mode:"start",admission:"confirmed"});
  original.recordSource({...key,lineage:"native",sourceId:"response",kind:"response",version:0,provider:"p",model:"m",counts:{totalTokens:"8"}});
  assert.equal(original.readAllocations(key)[0]!.tokens,"8");
  const derived=new OpenCraftTokenUsageLedger(state,"fixture",()=>1000,undefined,{projectLegacy:false});
  derived.recordInput(key,{inputId:"B",actorId:"B",actorKind:"human",mode:"steer",admission:"confirmed"});
  const fallback=new OpenCraftTokenUsageLedger(state,"fixture",()=>1000);
  assert.equal(fallback.projectionReady(),false);
  assert.throws(()=>new TokenUsageQuery(state,"fixture").read({from:"1970-01-01",through:"1970-01-01"},()=>({actorId:"A",administrator:true})),/restoration/);
  while(!fallback.backfillProjectionBatch(1)){}
  assert.deepEqual(fallback.readAllocations(key).map(row=>[row.actorId,row.tokens]),[["A","4"],["B","4"]]);
  assert.equal(fallback.projectionReady(),true);assert.equal(fallback.checkpoint("legacy-projection-stale-v1"),null);
  assert.equal(fallback.query({from:"1970-01-01",through:"1970-01-01",scope:"team"},()=>({actorId:"A",administrator:true})).summary.tokens,"8");
 }finally{state.close();await rm(directory,{recursive:true,force:true});}
});

test("restoration preserves frozen observed buckets when a former native snapshot was lower",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"oc-projection-frozen-")),state=new TokenUsageStateDatabase(directory),key={threadId:"frozen-thread",turnId:"turn"};
 const ledger=new OpenCraftTokenUsageLedger(state,"fixture",()=>1000);
 try{
  ledger.startTurn(key,1000,"human",true);ledger.recordInput(key,{inputId:"A",actorId:"A",actorKind:"human",mode:"start",admission:"confirmed"});
  ledger.recordSource({...key,lineage:"native",sourceId:"response",kind:"response",version:0,provider:"p",model:"response-model",counts:{totalTokens:"5"}});
  ledger.recordSource({...key,lineage:"native",sourceId:"snapshot",kind:"turn-snapshot",version:0,provider:"p",model:"older-model",counts:{totalTokens:"3"}});
  ledger.reconcile(key,{executionState:"running",participantsComplete:true,usageComplete:true,responsesComplete:true});ledger.setEnabled(false);
  const before=ledger.readAllocations(key);assert.equal(before[0]!.tokens,"5");
  const options={directory,nativeHome:directory,serverId:"fixture",archivePath:join(directory,"projection.jsonl.gz")};
  await retireLegacyTokenProjection(options);await restoreLegacyTokenProjection(options);
  assert.deepEqual(ledger.readAllocations(key),before);assert.equal(ledger.readTurn(key)!.observedTokens,"5");assert.equal(ledger.readTurn(key)!.frozen,true);
 }finally{state.close();await rm(directory,{recursive:true,force:true});}
});
