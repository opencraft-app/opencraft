import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { TokenUsageStateDatabase } from "../../apps/opencraft-daemon/src/token-usage-state-database.js";
import { OpenCraftTokenUsageLedger } from "../../apps/opencraft-daemon/src/token-usage-ledger.js";
import { TokenUsageQueryService } from "../../apps/opencraft-daemon/src/token-usage-query-service.js";
import { TokenUsageQueryError } from "../../apps/opencraft-daemon/src/token-usage-query.js";
const entry=fileURLToPath(new URL("../../apps/opencraft-daemon/src/token-usage-query-worker.ts",import.meta.url));
const parameters={from:"2026-10-21",through:"2026-10-21"};
const A=()=>({actorId:"A",administrator:false});
async function fixture(body:(service:TokenUsageQueryService,state:TokenUsageStateDatabase)=>Promise<void>,bundled=false){
 const directory=await mkdtemp(join(tmpdir(),"oc-query-worker-")),state=new TokenUsageStateDatabase(directory);
 const ledger=new OpenCraftTokenUsageLedger(state,"server",()=>Date.parse("2026-10-20T16:00:00Z"));
 const key={threadId:"thread",turnId:"turn"};ledger.startTurn(key,Date.parse("2026-10-20T16:00:00Z"),"human",true);
 ledger.recordInput(key,{inputId:"A",actorId:"A",actorKind:"human",mode:"start",admission:"confirmed"});
 ledger.recordSource({...key,lineage:"epoch",sourceId:"r",version:0,kind:"response",provider:null,model:null,counts:{totalTokens:"9007199254740993123456789"}});
 let workerEntry=entry;
 if(bundled){workerEntry=join(directory,"query.mjs");await build({entryPoints:[entry],outfile:workerEntry,bundle:true,platform:"node",format:"esm",target:"node26",logLevel:"silent"});}
 const service=new TokenUsageQueryService({entry:workerEntry,databasePath:join(directory,"token-usage.sqlite"),serverId:"server"});
 try{await body(service,state);}finally{service.close();state.close();await rm(directory,{recursive:true,force:true});}
}
test("source worker opens the existing ledger read-only and keeps arbitrary precision",()=>fixture(async service=>{
 const response=await service.read(parameters,A);assert.equal(response.summary.tokens,"9007199254740993123456789");
}));
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
