import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { TokenUsageStateDatabase } from "../../apps/opencraft-daemon/src/token-usage-state-database.js";
import { OpenCraftTokenUsageLedger } from "../../apps/opencraft-daemon/src/token-usage-ledger.js";
import { TokenUsageQueryService } from "../../apps/opencraft-daemon/src/token-usage-query-service.js";
import { TokenUsageQueryError } from "../../apps/opencraft-daemon/src/token-usage-query.js";
const entry=fileURLToPath(new URL("../../apps/opencraft-daemon/src/token-usage-query-worker.ts",import.meta.url));
const parameters={from:"2026-10-21",through:"2026-10-21"};
const A=()=>({actorId:"A",administrator:false});

test("query worker discovers registered HOMEs, survives a default switch and rejects an unavailable directory",async()=>{
 const root=await mkdtemp(join(tmpdir(),"oc-query-homes-")),state=new TokenUsageStateDatabase(root);
 const at=Date.parse("2026-10-24T00:00:00Z"),ledger=new OpenCraftTokenUsageLedger(state,"server",()=>at);
 const entries=[{id:"019a0000-0000-7000-8000-000000000001",turn:"019a0000-0001-7000-8000-000000000001",tokens:"5",home:join(root,"old")},
  {id:"019a0000-0000-7000-8000-000000000002",turn:"019a0000-0001-7000-8000-000000000002",tokens:"9",home:join(root,"new")}];
 for(const row of entries){
  await mkdir(join(row.home,"sessions"),{recursive:true});const key={threadId:row.id,turnId:row.turn};
  ledger.startTurn(key,at,"human",true);ledger.recordInput(key,{inputId:row.id,actorId:"A",actorKind:"human",mode:"start",admission:"confirmed"});
  const line=(type:string,payload:unknown)=>JSON.stringify({type,payload,timestamp:new Date(at).toISOString()})+"\n";
  const usage={total_tokens:row.tokens,input_tokens:row.tokens,cached_input_tokens:"0",cache_write_input_tokens:"0",output_tokens:"0",reasoning_output_tokens:"0"};
  await writeFile(join(row.home,"sessions",`rollout-2026-10-24-${row.id}.jsonl`),line("session_meta",{id:row.id,model_provider:"provider"})
   +line("event_msg",{type:"task_started",turn_id:row.turn})+line("turn_context",{turn_id:row.turn,model:"model"})
   +line("event_msg",{type:"token_count",info:{total_token_usage:usage,last_token_usage:usage}})+line("event_msg",{type:"task_complete",turn_id:row.turn}));
 }
 let available=true,epoch=1;const paths=new Set<string>();const endpoint=join(root,"control.sock");
 const core=createServer((req,res)=>{
  const url=new URL(req.url!,"http://local");paths.add(url.pathname);
  if(req.headers.authorization!=="Bearer synthetic-core"){res.writeHead(401).end();return;}
  if(!available){res.writeHead(503).end();return;}
  res.setHeader("content-type","application/json");
  if(url.pathname==="/health")res.end(JSON.stringify({protocolVersion:1,pid:process.pid,codexPid:process.pid,nativeSocket:"/no-native-connection.sock",routingEpoch:"owner"}));
  else if(url.pathname==="/generation-directory"){
   const id=url.searchParams.get("threadId");
   res.end(JSON.stringify({protocolVersion:1,routingEpoch:"owner",admissionEpoch:epoch,
    homes:entries.map(row=>({generationId:row.id,codexHome:row.home,incarnation:1})),route:id?{threadId:id,generationId:id}:null}));
  }else res.writeHead(404).end();
 });
 await new Promise<void>(resolve=>core.listen(endpoint,resolve));
 const service=new TokenUsageQueryService({entry,databasePath:join(root,"token-usage.sqlite"),serverId:"server",rollout:{nativeHome:entries[0]!.home,coreEndpoint:endpoint,coreAuthToken:"synthetic-core"}});
 try{
  const params={from:"2026-10-24",through:"2026-10-24"};let total="";const until=Date.now()+10000;
  while(Date.now()<until){try{total=(await service.read(params,A)).summary.tokens;}catch{}if(total==="14")break;await new Promise(resolve=>setTimeout(resolve,25));}
  assert.equal(total,"14");epoch++;assert.equal((await service.read(params,A)).summary.tokens,"14");
  available=false;await assert.rejects(service.read(params,A),/unavailable/);
  available=true;assert.equal((await service.read(params,A)).summary.tokens,"14");
  assert.deepEqual([...paths].sort(),["/generation-directory","/health"]);
 }finally{service.close();await new Promise<void>((resolve,reject)=>core.close(e=>e?reject(e):resolve()));state.close();await rm(root,{recursive:true,force:true});}
});
async function fixture(body:(service:TokenUsageQueryService,state:TokenUsageStateDatabase)=>Promise<void>,bundled=false,initializationMs=0){
 const directory=await mkdtemp(join(tmpdir(),"oc-query-worker-")),state=new TokenUsageStateDatabase(directory);
 const ledger=new OpenCraftTokenUsageLedger(state,"server",()=>Date.parse("2026-10-20T16:00:00Z"));
 const key={threadId:"thread",turnId:"turn"};ledger.startTurn(key,Date.parse("2026-10-20T16:00:00Z"),"human",true);
 ledger.recordInput(key,{inputId:"A",actorId:"A",actorKind:"human",mode:"start",admission:"confirmed"});
 ledger.recordSource({...key,lineage:"epoch",sourceId:"r",version:0,kind:"response",provider:null,model:null,counts:{totalTokens:"9007199254740993123456789"}});
 let workerEntry=entry;
 if(bundled){workerEntry=join(directory,"query.mjs");await build({entryPoints:[entry],outfile:workerEntry,bundle:true,platform:"node",format:"esm",target:"node26",logLevel:"silent"});}
 if(initializationMs){const slow=join(directory,"initializing.mjs");await writeFile(slow,`await new Promise(resolve=>setTimeout(resolve,${initializationMs}));await import(${JSON.stringify(pathToFileURL(workerEntry).href)});`);workerEntry=slow;}
 const service=new TokenUsageQueryService({entry:workerEntry,databasePath:join(directory,"token-usage.sqlite"),serverId:"server"});
 try{await body(service,state);}finally{service.close();state.close();await rm(directory,{recursive:true,force:true});}
}
test("source worker opens the existing ledger read-only and keeps arbitrary precision",()=>fixture(async service=>{
 const response=await service.read(parameters,A);assert.equal(response.summary.tokens,"9007199254740993123456789");
}));
test("a read timeout during slow initialization leaves the owner able to finish and serve later queries",()=>fixture(async service=>{
 const started=performance.now();await assert.rejects(service.read(parameters,A),/unavailable/);
 assert.ok(performance.now()-started<2000,'initialization must not make requests wait indefinitely');
 await new Promise(resolve=>setTimeout(resolve,750));
 assert.equal((await service.read(parameters,A)).summary.tokens,"9007199254740993123456789");
},true,1900));
test("initialization captures each read's parameters before callers can mutate them",()=>fixture(async service=>{
 const request={...parameters,scope:'self'};const pending=service.read(request,A);request.scope='team';
 const response=await pending;assert.equal(response.scope,'self');assert.equal(response.summary.tokens,"9007199254740993123456789");
},true,200));
test("packaged worker uses its compiled module and rejects authority revoked during I/O",()=>fixture(async service=>{
 let valid=true;const request=service.read(parameters,()=>valid?A():null);valid=false;
 await assert.rejects(request,error=>error instanceof TokenUsageQueryError&&error.code==="unauthorized");
 valid=true;assert.equal((await service.read(parameters,A)).summary.tokens,"9007199254740993123456789");
},true));
test("read queue is bounded and closing rejects outstanding requests",()=>fixture(async service=>{
 const pending=Array.from({length:16},(_,n)=>service.read({...parameters,limit:n+1},A));
 const results=Promise.allSettled(pending);
 await assert.rejects(service.read({...parameters,limit:17},A),/busy/);
 service.close();assert.ok((await results).every(result=>result.status==="rejected"));
 await assert.rejects(service.read(parameters,A),/busy/);
}));


test("concurrent identical reads share a snapshot but independently recheck identity and never share mutable results",()=>fixture(async service=>{
 let valid=true;
 const first=service.read(parameters,A),revoked=service.read(parameters,()=>valid?A():null),third=service.read(parameters,A);
 valid=false;
 const outcomes=await Promise.allSettled([first,revoked,third]);
 assert.equal(outcomes[0]!.status,"fulfilled");assert.equal(outcomes[1]!.status,"rejected");assert.equal(outcomes[2]!.status,"fulfilled");
 if(outcomes[0]!.status==="fulfilled"&&outcomes[2]!.status==="fulfilled"){
  outcomes[0]!.value.summary.tokens="corrupted";
  assert.equal(outcomes[2]!.value.summary.tokens,"9007199254740993123456789");
 }
}));

test("coalesced team administrators keep distinct signed cursor ownership and reject a copied cursor",()=>fixture(async(service,state)=>{
 const ledger=new OpenCraftTokenUsageLedger(state,"server");
 const key={threadId:"thread",turnId:"second"};
 ledger.startTurn(key,Date.parse("2026-10-20T16:00:01Z"),"human",true);ledger.recordInput(key,{inputId:"secondA",actorId:"A",actorKind:"human",mode:"start",admission:"confirmed"});
 ledger.recordSource({...key,lineage:"epoch",sourceId:"r",kind:"response",version:0,provider:null,model:null,counts:{totalTokens:"10"}});
 const one=()=>({actorId:"admin-one",administrator:true}),two=()=>({actorId:"admin-two",administrator:true});
 const request={...parameters,scope:"team",limit:1};
 const [a,b]=await Promise.all([service.read(request,one),service.read(request,two)]);
 assert.ok(a.nextCursor);assert.ok(b.nextCursor);assert.notEqual(a.nextCursor,b.nextCursor);
 assert.deepEqual(a.rows,b.rows);
 const second=await service.read({...request,cursor:b.nextCursor},two);assert.equal(second.rows.length,1);
 await assert.rejects(service.read({...request,cursor:a.nextCursor},two),error=>error instanceof TokenUsageQueryError&&error.code==="forbidden");
}));
