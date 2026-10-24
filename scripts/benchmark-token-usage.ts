import {build} from "esbuild";
import {mkdtemp,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir,cpus,totalmem} from "node:os";
import {performance} from "node:perf_hooks";
import {TokenUsageStateDatabase} from "../apps/opencraft-daemon/src/token-usage-state-database.js";
import {OpenCraftTokenUsageLedger} from "../apps/opencraft-daemon/src/token-usage-ledger.js";
import {TokenUsageQueryService} from "../apps/opencraft-daemon/src/token-usage-query-service.js";
const directory=process.env.OPENCRAFT_USAGE_BENCH_DIRECTORY??await mkdtemp(join(tmpdir(),"oc-usage-bench-"));
const at=Date.parse("2026-07-23T16:00:00Z"),now=Date.parse("2026-10-21T12:00:00Z");
const state=new TokenUsageStateDatabase(directory),db=state.database;
const ledger=new OpenCraftTokenUsageLedger(state,"benchmark",()=>at);
const existing=Number(db.prepare("SELECT count(*) AS n FROM token_usage_turns").get()!.n);
if(!existing){
 const turn=db.prepare("INSERT INTO token_usage_turns VALUES(?,?,?,?,'completed','human',1,1,1,0,'10000','settled',1,0)");
 const input=db.prepare("INSERT INTO token_usage_inputs VALUES(?,?,?,?,?,'human','start','confirmed')");
 const source=db.prepare("INSERT INTO token_usage_sources VALUES(?,?,?,?,?,'response',0,?,?,?,?)");
 const bucket=db.prepare("INSERT INTO token_usage_buckets VALUES(?,?,?,?,?,?,'5000')");
 const allocation=db.prepare("INSERT INTO token_usage_allocations VALUES(?,?,?,?,?,?,?,'2500')");
 const counts=JSON.stringify({totalTokens:"1000",inputTokens:"800",cachedInputTokens:"300",cacheWriteInputTokens:"0",outputTokens:"200",reasoningOutputTokens:"100"});
 const begin=performance.now();
 state.transaction(()=>{
  for(let n=0;n<100000;n++){
   const thread="thread"+Math.floor(n/10),id="turn"+n,started=at+Math.floor(n/100000*90*86400000),actors=["actor"+(n%500),"actor"+((n+137)%500)];
   turn.run("benchmark",thread,id,started);
   for(const actor of actors)input.run("benchmark",thread,id+actor,id,actor);
   for(let modelIndex=0;modelIndex<2;modelIndex++){
    const index=(n+modelIndex)%20,provider="provider"+(index%4),model="model"+Math.floor(index/4),modelKey=JSON.stringify([provider,model]);
    bucket.run("benchmark",thread,id,modelKey,provider,model);
    for(const actor of actors)allocation.run("benchmark",thread,id,modelKey,provider,model,actor);
    for(let response=0;response<5;response++)source.run("benchmark",thread,id,"fixed-seed-20261021","response"+(modelIndex*5+response),provider,model,counts,started);
   }
  }
  db.prepare("UPDATE token_usage_scopes SET revision=100000 WHERE server_id='benchmark'").run();
 });
 console.error(JSON.stringify({generated:true,directory,generationMs:performance.now()-begin}));
}
// Include real collection metadata in the storage fixture, rather than only
// the source/allocation tables used by the initial query diagnostic.
state.transaction(()=>{
 db.prepare("INSERT OR IGNORE INTO token_usage_submissions SELECT i.server_id,i.thread_id,i.input_id,i.actor_id,i.actor_kind,i.mode,'human',t.started_ms FROM token_usage_inputs i JOIN token_usage_turns t USING(server_id,thread_id,turn_id) WHERE i.server_id='benchmark'").run();
 db.prepare("INSERT OR IGNORE INTO token_usage_admissions SELECT i.server_id,i.thread_id,i.input_id,i.turn_id,t.started_ms FROM token_usage_inputs i JOIN token_usage_turns t USING(server_id,thread_id,turn_id) WHERE i.server_id='benchmark'").run();
 db.prepare("INSERT OR IGNORE INTO token_usage_attempts SELECT i.server_id,'fixture-attempt:'||i.input_id,i.thread_id,i.input_id,i.mode,i.actor_id,i.actor_kind,'human',t.started_ms,'accepted',i.turn_id FROM token_usage_inputs i JOIN token_usage_turns t USING(server_id,thread_id,turn_id) WHERE i.server_id='benchmark'").run();
});
// Correct the initial diagnostic fixture's noon offset, preserving its rows.
const enabled=Number(db.prepare("SELECT enabled_at_ms FROM token_usage_scopes WHERE server_id='benchmark'").get()!.enabled_at_ms);
if(enabled!==at){
 if(enabled-at!==43200000)throw new Error("Unexpected benchmark fixture epoch");
 state.transaction(()=>{db.prepare("UPDATE token_usage_turns SET started_ms=started_ms-43200000 WHERE server_id='benchmark'").run();db.prepare("UPDATE token_usage_scopes SET enabled_at_ms=? WHERE server_id='benchmark'").run(at);db.prepare("UPDATE token_usage_coverage SET starts_ms=? WHERE server_id='benchmark'").run(at);});
}
// Generated fixtures bypass the production writer; rebuild the same derived
// projection through the bounded owner API before measuring reads.
if(!existing)db.prepare("UPDATE token_usage_projection_state SET ready=0 WHERE server_id='benchmark'").run();
while(!ledger.backfillProjectionBatch(100))await new Promise<void>(resolve=>setImmediate(resolve));
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const workerEntry=join(directory,"query-worker.mjs");
await build({entryPoints:[new URL("../apps/opencraft-daemon/src/token-usage-query-worker.ts",import.meta.url).pathname],outfile:workerEntry,bundle:true,platform:"node",format:"esm",target:"node26",logLevel:"silent"});
const service=new TokenUsageQueryService({entry:workerEntry,databasePath:join(directory,"token-usage.sqlite"),serverId:"benchmark"});
const administrator=()=>({actorId:"administrator",administrator:true});
const samples=[];
try{
 for(const request of [{from:"2026-09-22",through:"2026-10-21",scope:"team",view:"turns"},{from:"2025-10-21",through:"2026-10-21",scope:"team",view:"turns"},{from:"2026-09-22",through:"2026-10-21",scope:"self",view:"threads"}]){
  const started=performance.now();
  try{const result=await service.read(request,request.scope==="self"?()=>({actorId:"actor0",administrator:false}):administrator);samples.push({request,ms:performance.now()-started,total:result.summary.tokens,turns:result.summary.turns});}
  catch(error){samples.push({request,ms:performance.now()-started,error:error instanceof Error?error.message:"unknown"});}
 }
 const result={stage:"cold diagnostic only; not complete NF acceptance",seed:20261021,directory,workerMode:"bundled-release-equivalent",turns:100000,responses:1000000,people:500,models:20,days:90,host:{cpu:cpus()[0]?.model,logicalCPUs:cpus().length,memory:totalmem()},now,samples};
 await writeFile(join(directory,"cold-results.json"),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{service.close();state.close();}
