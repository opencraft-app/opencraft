import {build} from "esbuild";
import {writeFile,stat,readFile} from "node:fs/promises";
import {join} from "node:path";
import {performance} from "node:perf_hooks";
import {cpus,totalmem} from "node:os";
import {TokenUsageStateDatabase} from "../apps/opencraft-daemon/src/token-usage-state-database.js";
import {OpenCraftTokenUsageLedger} from "../apps/opencraft-daemon/src/token-usage-ledger.js";
import {TokenUsageQueryService} from "../apps/opencraft-daemon/src/token-usage-query-service.js";
const directory=process.env.OPENCRAFT_USAGE_BENCH_DIRECTORY;
if(!directory)throw new Error("An explicit generated benchmark directory is required");
const samples=Number(process.env.OPENCRAFT_USAGE_BENCH_SAMPLES??1000);
if(!Number.isSafeInteger(samples)||samples<1000||samples%10!==0)throw new Error("Use at least 1000 samples, in batches of ten");
const state=new TokenUsageStateDatabase(directory),db=state.database;
if(db.prepare("SELECT count(*) AS n FROM token_usage_turns WHERE server_id='benchmark'").get()!.n!==100000)throw new Error("Wrong benchmark dataset");
const ledger=new OpenCraftTokenUsageLedger(state,"benchmark");
const workerEntry=join(directory,"query-worker.mjs");
await build({entryPoints:[new URL("../apps/opencraft-daemon/src/token-usage-query-worker.ts",import.meta.url).pathname],outfile:workerEntry,bundle:true,platform:"node",format:"esm",target:"node26",logLevel:"silent"});
const service=new TokenUsageQueryService({entry:workerEntry,databasePath:join(directory,"token-usage.sqlite"),serverId:"benchmark"});
const baselineRevision=ledger.coverage().revision;
const failures:unknown[]=[],groups:unknown[]=[];
const eventVersions=new Map<number,number>();
for(let n=99900;n<100000;n++){
 eventVersions.set(n,Number(db.prepare("SELECT source_version AS version FROM token_usage_sources WHERE server_id='benchmark' AND thread_id=? AND turn_id=? AND source_id='response0'").get("thread"+Math.floor(n/10),"turn"+n)!.version));
 // Construct the synthetic load's initial active state before measurement.
 // Production ledger transitions correctly reject resurrecting completed turns.
 db.prepare("UPDATE token_usage_turns SET execution_state='running',allocation_state='provisional' WHERE server_id='benchmark' AND thread_id=? AND turn_id=?").run("thread"+Math.floor(n/10),"turn"+n);
}
for(let n=99900;n<100000;n++)ledger.reconcile({threadId:"thread"+Math.floor(n/10),turnId:"turn"+n},{executionState:"running",participantsComplete:true,usageComplete:true,responsesComplete:true});
const cgroup=(await readFile("/proc/self/cgroup","utf8")).trim().split("\n").find(line=>line.startsWith("0::"))?.slice(3);
const constraints={cgroup,cpuMax:cgroup?await readFile("/sys/fs/cgroup"+cgroup+"/cpu.max","utf8"):null,memoryMax:cgroup?await readFile("/sys/fs/cgroup"+cgroup+"/memory.max","utf8"):null,affinity:(await readFile("/proc/self/status","utf8")).split("\n").find(line=>line.startsWith("Cpus_allowed_list:"))};
console.error(JSON.stringify({stage:"constraints",constraints}));
let event=0,writes=0;
const writeLatency:number[]=[],loopLag:number[]=[];
let lastTick=performance.now();
const loadStarted=performance.now();
const timer=setInterval(()=>{
 const tick=performance.now();loopLag.push(Math.max(0,tick-lastTick-10));lastTick=tick;
 const due=Math.floor((tick-loadStarted)/20)-event;
 if(due>10000){failures.push({kind:"source-backlog",pending:due});return;}
 const sliceStarted=performance.now();
 for(let batch=0;batch<Math.min(32,due)&&(batch===0||performance.now()-sliceStarted<8);batch++)try{
  const n=99900+(event++%100),version=eventVersions.get(n)!+1;eventVersions.set(n,version);
  const index=n%20;
  const writeStarted=performance.now();
  ledger.recordSource({threadId:"thread"+Math.floor(n/10),turnId:"turn"+n,lineage:"fixed-seed-20261021",sourceId:"response0",kind:"response",version,provider:"provider"+(index%4),model:"model"+Math.floor(index/4),counts:{totalTokens:String(1000+version),inputTokens:String(800+version),cachedInputTokens:"300",cacheWriteInputTokens:"0",outputTokens:"200",reasoningOutputTokens:"100"}});writes++;writeLatency.push(performance.now()-writeStarted);
 }catch(error){failures.push({kind:"write",message:error instanceof Error?error.message:"unknown"});}
},10);
const percentile=(values:number[],p:number)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1]!;
function verify(result:Awaited<ReturnType<TokenUsageQueryService["read"]>>){
 const total=BigInt(result.summary.tokens),categories=Object.values(result.summary.categories).reduce((sum,n)=>sum+BigInt(n),0n),models=result.models.reduce((sum,m)=>sum+BigInt(m.tokens),0n);
 if(total!==categories||total!==models)throw new Error("Snapshot conservation failed");
}
try{
 for(const profile of ["team30-turns","team366-turns","team30-threads","people30-turns","people366-turns","team30-actors","team30-model","people30-model"]){
  console.error(JSON.stringify({stage:"profile-start",profile}));
  const request={from:profile.includes("366")?"2025-10-21":"2026-09-22",through:"2026-10-21",scope:profile.startsWith("team")?"team":"self",view:profile.endsWith("threads")?"threads":profile.endsWith("actors")?"actors":"turns",limit:100,...(profile.endsWith("model")?{modelKey:JSON.stringify(["provider0","model0"])}:{})};
  const authority=(n:number)=>({actorId:profile.startsWith("team")?"admin"+n:"actor"+n,administrator:profile.startsWith("team")});
  let warmFailed=false;
  for(let n=0;n<20;n++)try{verify(await service.read(request,()=>authority(n%10)));}
  catch(error){failures.push({profile,stage:"warmup",message:error instanceof Error?error.message:"unknown"});warmFailed=true;break;}
  if(warmFailed){groups.push({profile,samples:0,passed:false,reason:"warmup failed"});await writeFile(join(directory,"load-progress.json"),JSON.stringify({constraints,groups,failures},null,2));continue;}
  const latency:number[]=[];let errors=0;
  const started=performance.now(),writesBefore=writes;
  for(let base=0;base<samples;base+=10)await Promise.all(Array.from({length:10},async(_,n)=>{
   const start=performance.now();
   try{verify(await service.read(request,()=>authority(n)));}catch(error){errors++;failures.push({profile,message:error instanceof Error?error.message:"unknown"});}
   latency.push(performance.now()-start);
  }));
  const p95=percentile(latency,.95),p99=percentile(latency,.99),threshold=profile.includes("366")?800:300;
  groups.push({profile,samples,concurrentClients:10,activeTurns:100,sourceEventsPerSecond:50,p95,p99,max:Math.max(...latency),errors,threshold,passed:p95<=threshold&&errors/samples<.001,actualWrites:writes-writesBefore,elapsedMs:performance.now()-started});
  console.error(JSON.stringify({stage:"profile-complete",result:groups.at(-1)}));
  await writeFile(join(directory,"load-progress.json"),JSON.stringify({constraints,groups,failures},null,2));
 }
 clearInterval(timer);
 // A single fixed snapshot is concurrently read 1000 times after writes stop.
 const before=ledger.coverage().revision;
 const consistent=await Promise.all(Array.from({length:1000},(_,n)=>service.read({from:"2026-09-22",through:"2026-10-21",scope:"team",limit:1},()=>({actorId:"consistency-admin"+n,administrator:true}))));
 for(const response of consistent){verify(response);if(response.snapshotRevision!==before)throw new Error("Concurrent reads split snapshot revision");}
 db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
 const result={stage:"controlled load measurement; all acceptance still requires source/constraint audit",seed:20261021,directory,workerMode:"bundled-release-equivalent",host:{cpu:cpus()[0]?.model,logicalCPUs:cpus().length,memory:totalmem()},constraints,groups,writes,baselineRevision,finalRevision:before,loadElapsedMs:performance.now()-loadStarted,writeLatencyMs:{p95:percentile(writeLatency,.95),p99:percentile(writeLatency,.99),max:Math.max(...writeLatency)},eventLoopLagMs:{p95:percentile(loopLag,.95),p99:percentile(loopLag,.99),max:Math.max(...loopLag)},concurrentConsistencyReads:1000,conservationFailures:0,sqliteBytes:(await stat(join(directory,"token-usage.sqlite"))).size,failures};
 await writeFile(join(directory,"load-results.json"),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{clearInterval(timer);service.close();state.close();}
