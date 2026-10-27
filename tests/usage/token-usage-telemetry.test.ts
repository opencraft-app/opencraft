import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {build} from "esbuild";
import {TokenUsageTelemetry} from "../../apps/opencraft-daemon/src/token-usage-telemetry.js";
import {TokenUsageStateDatabase} from "../../apps/opencraft-daemon/src/token-usage-state-database.js";
import {OpenCraftTokenUsageLedger} from "../../apps/opencraft-daemon/src/token-usage-ledger.js";
import {TokenUsageQueryService} from "../../apps/opencraft-daemon/src/token-usage-query-service.js";

test("diagnostics retain a bounded latency window and return detached, identifier-free snapshots",()=>{
 const telemetry=new TokenUsageTelemetry();
 for(let n=0;n<10000;n++)telemetry.latency("query",n,true);
 const snapshot=telemetry.snapshot();
 assert.equal(snapshot.queryLatency.count,10000);assert.equal(snapshot.queryLatency.samples,256);
 assert.equal(snapshot.queryLatency.maxMs,9999);assert.ok(snapshot.queryLatency.p95Ms!>=9900);
 snapshot.counts.collected=999;assert.equal(telemetry.snapshot().counts.collected,0);
 assert.equal(JSON.stringify(snapshot).includes("actorId"),false);
});

test("only committed sources, deduplication and reconciliation update collection diagnostics; queries authorize diagnostics again",async()=>{
 const root=await mkdtemp(join(tmpdir(),"oc-usage-telemetry-")),state=new TokenUsageStateDatabase(root),telemetry=new TokenUsageTelemetry();
 const at=Date.parse("2026-10-21T00:00:00Z"),ledger=new OpenCraftTokenUsageLedger(state,"server",()=>at,telemetry),key={threadId:"thread",turnId:"turn"};
 let service:TokenUsageQueryService|undefined;
 try{
  ledger.startTurn(key,at,"human",true);ledger.recordInput(key,{inputId:"input",actorId:"A",actorKind:"human",mode:"start",admission:"confirmed"});
  const source={...key,lineage:"native",sourceId:"response",kind:"response" as const,version:0,provider:"p",model:"m",counts:{totalTokens:"17"}};
  ledger.recordSource(source);ledger.recordSource(source);ledger.recordSource({...source,version:1,counts:{totalTokens:"19"}});
  const before=telemetry.snapshot();assert.equal(before.counts.collected,1);assert.equal(before.counts.deduplicated,1);assert.equal(before.counts.corrected,1);
  assert.throws(()=>ledger.commitReplayBatch(()=>{ledger.recordSource({...source,sourceId:"rolled-back"});throw new Error("crash before commit");}),/crash before commit/);
  assert.equal(telemetry.snapshot().counts.collected,1);assert.equal(telemetry.snapshot().counts.writeFailures,before.counts.writeFailures+1);
  ledger.noteGap({id:"gap",reason:"source-offline",threadId:"thread"});ledger.noteGap({id:"gap",reason:"source-offline",threadId:"thread"});
  assert.equal(telemetry.snapshot().counts.missing,1);
  ledger.reconcile(key,{executionState:"completed",participantsComplete:true,usageComplete:true,responsesComplete:true});
  assert.equal(telemetry.snapshot().counts.reconciled,1);assert.ok(telemetry.snapshot().lastSourceSuccessAt);assert.ok(telemetry.snapshot().lastReconcileAt);
  const entry=join(root,"worker.mjs");await build({entryPoints:[new URL("../../apps/opencraft-daemon/src/token-usage-query-worker.ts",import.meta.url).pathname],outfile:entry,bundle:true,platform:"node",format:"esm",target:"node26",logLevel:"silent"});
  service=new TokenUsageQueryService({entry,databasePath:join(root,"token-usage.sqlite"),serverId:"server",telemetry});
  const params={from:"2026-10-21",through:"2026-10-21"};
  const personal=await service.read(params,()=>({actorId:"A",administrator:false}));assert.equal(personal.diagnostics,undefined);
  const admin=await service.read({...params,scope:"team"},()=>({actorId:"admin",administrator:true}));
  assert.equal(admin.diagnostics?.counts.collected,1);assert.equal(admin.diagnostics?.queryLatency.count,2);
  let administrator=true;const pending=service.read({...params,scope:"team"},()=>({actorId:"admin",administrator}));administrator=false;
  await assert.rejects(pending);assert.equal(telemetry.snapshot().counts.queryFailures,1);
  assert.equal((await service.read(params,()=>({actorId:"A",administrator:false}))).diagnostics,undefined);
 }finally{service?.close();state.close();await rm(root,{recursive:true,force:true});}
});
