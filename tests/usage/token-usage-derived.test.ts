import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { TokenUsageStateDatabase } from "../../apps/opencraft-daemon/src/token-usage-state-database.js";
import { OpenCraftTokenUsageLedger } from "../../apps/opencraft-daemon/src/token-usage-ledger.js";
import { RolloutDerivedTokenUsage, DERIVED_CACHE_VERSION } from "../../apps/opencraft-daemon/src/token-usage-derived.js";
import { TokenUsageQuery } from "../../apps/opencraft-daemon/src/token-usage-query.js";
import { emptyUsageParserState, parseUsageEvent, retainUsageEvent } from "../../apps/opencraft-daemon/src/token-usage-derived-source.js";

const thread="019a0000-0000-7000-8000-000000000001",turn="019a0000-0001-7000-8000-000000000001";
const at=Date.parse("2026-10-24T00:00:00Z"),params={from:"2026-10-24",through:"2026-10-24",scope:"team"};
const admin=()=>({actorId:"admin",administrator:true});
const native=(total:string)=>({total_tokens:total,input_tokens:total,cached_input_tokens:"0",cache_write_input_tokens:"0",output_tokens:"0",reasoning_output_tokens:"0"});
function line(type:string,payload:object,offset=0){return JSON.stringify({type,timestamp:new Date(at+offset).toISOString(),payload})+"\n";}
const count=(total:string,last:string,offset=1)=>line("event_msg",{type:"token_count",info:{total_token_usage:native(total),last_token_usage:native(last)}},offset);
const start=()=>line("session_meta",{id:thread,model_provider:"provider"})+line("event_msg",{type:"task_started",turn_id:turn})+line("turn_context",{turn_id:turn,model:"model-a"});
async function drain(derived:RolloutDerivedTokenUsage){for(let i=0;i<1000;i++){if(!await derived.step())return;}throw new Error("Derived source failed to drain");}
async function fixture(body:(f:{directory:string;home:string;path:string;source:TokenUsageStateDatabase;ledger:OpenCraftTokenUsageLedger;open:()=>RolloutDerivedTokenUsage})=>Promise<void>){
 const directory=await mkdtemp(join(tmpdir(),"oc-derived-")),home=join(directory,"runtime");await mkdir(join(home,"sessions"),{recursive:true});
 const path=join(home,"sessions",`rollout-2026-10-24-${thread}.jsonl`),source=new TokenUsageStateDatabase(directory),ledger=new OpenCraftTokenUsageLedger(source,"server",()=>at);
 ledger.startTurn({threadId:thread,turnId:turn},at,"human",true);
 ledger.recordInput({threadId:thread,turnId:turn},{inputId:"A",actorId:"A",actorKind:"human",mode:"start",admission:"confirmed"});
 ledger.rememberRollout(thread,path);
 const owners:RolloutDerivedTokenUsage[]=[];
 const open=()=>{const d=new RolloutDerivedTokenUsage({databasePath:join(directory,"token-usage.sqlite"),nativeHome:home,serverId:"server"});owners.push(d);return d;};
 try{await body({directory,home,path,source,ledger,open});}finally{for(const owner of owners){try{owner.close();}catch{}}source.close();await rm(directory,{recursive:true,force:true});}
}
function snapshot(d:RolloutDerivedTokenUsage,scope:object={}){return new TokenUsageQuery({database:d.database},"server").read({...params,...scope},admin);}
function values(d:RolloutDerivedTokenUsage){const s=snapshot(d);return {summary:s.summary,daily:s.daily,models:s.models,rows:s.rows.map(r=>"revision"in r?{...r,revision:0}:r)};}

test("rollout totals/models, duplicate counters, live provisional use the same equal-turn-v1 allocation",()=>fixture(async f=>{
 await writeFile(f.path,start()+count("5","5")+count("5","5",2));
 const d=f.open();await drain(d);
 let s=snapshot(d);assert.equal(s.summary.tokens,"5");assert.equal(s.summary.categories.provisional,"5");assert.equal(s.models[0]!.key,JSON.stringify(["provider","model-a"]));
 f.ledger.recordInput({threadId:thread,turnId:turn},{inputId:"B",actorId:"B",actorKind:"human",mode:"steer",admission:"confirmed"});d.invalidate(thread);
 await appendFile(f.path,line("turn_context",{turn_id:turn,model:"model-b"},3)+count("10","5",4)+line("event_msg",{type:"task_complete",turn_id:turn},5));
 await drain(d);s=snapshot(d);assert.equal(s.summary.tokens,"10");assert.equal(s.summary.categories.settled,"10");
 assert.deepEqual(d.ledger.readAllocations({threadId:thread,turnId:turn}).map(x=>[x.model,x.actorId,x.tokens]),[["model-a","A","3"],["model-a","B","2"],["model-b","A","2"],["model-b","B","3"]]);
 assert.equal(snapshot(d,{actorId:"A"}).summary.tokens,"5");
 assert.equal(f.source.database.prepare("SELECT count(*) AS n FROM token_usage_sources").get()!.n,0);
}));

test("cache deletion and cache semantic/schema mismatch rebuild exactly from retained rollout and trusted receipts",()=>fixture(async f=>{
 await writeFile(f.path,start()+count("900719925474099312345","900719925474099312345")+line("event_msg",{type:"task_complete",turn_id:turn},2));
 let d=f.open();await drain(d);const expected=values(d);d.close();
 const cache=join(f.directory,"token-usage-derived.sqlite");await rm(cache);
 d=f.open();await drain(d);assert.deepEqual(values(d),expected);
 d.database.prepare("UPDATE usage_cache_version SET version='future-version'").run();d.close();
 d=f.open();await drain(d);assert.equal(d.database.prepare("SELECT version FROM usage_cache_version").get()!.version,DERIVED_CACHE_VERSION);assert.deepEqual(values(d),expected);d.close();
 const corrupt=new DatabaseSync(cache);corrupt.prepare("UPDATE schema_migrations SET checksum='changed' WHERE version=3").run();corrupt.close();
 d=f.open();await drain(d);assert.deepEqual(values(d),expected);
}));

test("deleted or missing rollout retains historical counts across a complete cache rebuild and declares partial coverage",()=>fixture(async f=>{
 await writeFile(f.path,start()+count("123","123")+line("event_msg",{type:"task_complete",turn_id:turn},2));
 let d=f.open();await drain(d);d.close();await rm(f.path);await rm(join(f.directory,"token-usage-derived.sqlite"));
 d=f.open();await drain(d);const s=snapshot(d);assert.equal(s.summary.tokens,"123");assert.equal(s.summary.categories.settled,"123");assert.equal(s.coverage.partial,true);assert.ok(s.coverage.openGaps>0);
}));

test("legacy-only unavailable history survives migration/rebuild without fabricating a rollout or identity",()=>fixture(async f=>{
 f.ledger.recordSource({threadId:thread,turnId:turn,lineage:"old",sourceId:"response",kind:"response",version:0,provider:null,model:null,counts:{totalTokens:"77"}});
 const d=f.open();await drain(d);const s=snapshot(d);assert.equal(s.summary.tokens,"77");assert.equal(s.coverage.partial,true);assert.equal(s.coverage.unknownModelTurns,1);
}));

test("incomplete lines are retried, inode replacement keeps counted history, and body markers never enter retained evidence",()=>fixture(async f=>{
 await writeFile(f.path,start()+line("response_item",{type:"message",content:"PRIVATE_BODY_MARKER"})+count("7","7").slice(0,-1));
 const d=f.open();await drain(d);assert.equal(snapshot(d).summary.tokens,"0");
 await appendFile(f.path,"\n");await drain(d);assert.equal(snapshot(d).summary.tokens,"7");
 await rm(f.path);await writeFile(f.path,start()+count("999","999"));await drain(d);
 assert.equal(snapshot(d).summary.tokens,"7");assert.equal(snapshot(d).coverage.partial,true);
 const retained=new DatabaseSync(join(f.directory,"token-usage-retained.sqlite"),{readOnly:true});assert.equal(JSON.stringify(retained.prepare("SELECT data_json FROM usage_events").all()).includes("PRIVATE_BODY_MARKER"),false);retained.close();
}));

test("parser rejects inherited fork counts, deduplicates notifications and flags counter resets",()=>{
 const s=emptyUsageParserState();
 for(const e of [{kind:"session",data:[thread,"provider"]},{kind:"start",data:[turn]},{kind:"context",data:[turn,"model",null]}] as const)parseUsageEvent(s,e,thread);
 parseUsageEvent(s,{kind:"response",data:["parent-thread",turn,"inherited",["100"]]},thread);
 assert.deepEqual(parseUsageEvent(s,{kind:"count",data:[["100"],["100"]]},thread),{});
 const delta=parseUsageEvent(s,{kind:"count",data:[["110"],["10"]]},thread);assert.equal(delta.delta?.counts.totalTokens,"10");
 assert.deepEqual(parseUsageEvent(s,{kind:"count",data:[["110"],["10"]]},thread),{});
 assert.equal(parseUsageEvent(s,{kind:"count",data:[["2"],["2"]]},thread).missing,true);
 assert.equal(retainUsageEvent({type:"response_item",payload:{content:"PRIVATE"}}),null);
});

test("late confirmed participation redivides existing counts without a new token event",()=>fixture(async f=>{
 await writeFile(f.path,start()+count("11","11"));const d=f.open();await drain(d);
 f.ledger.recordInput({threadId:thread,turnId:turn},{inputId:"B",actorId:"B",actorKind:"human",mode:"steer",admission:"confirmed"});d.invalidate(thread);await drain(d);
 assert.equal(snapshot(d,{actorId:"A"}).summary.tokens,"6");assert.equal(snapshot(d,{actorId:"B"}).summary.tokens,"5");assert.equal(snapshot(d).summary.tokens,"11");
}));

test("disable keeps known counts, excludes subsequent responses and preserves a missing-usage state on rebuild",()=>fixture(async f=>{
 await writeFile(f.path,start()+count("11","11",1));const d=f.open();await drain(d);
 // Persist a real disabled interval rather than manipulating the source counts.
 f.source.database.prepare("UPDATE token_usage_coverage SET ends_ms=?").run(at+5);f.source.database.prepare("UPDATE token_usage_scopes SET enabled=0").run();f.source.database.prepare("UPDATE token_usage_turns SET frozen=1").run();
 d.invalidate("*");await appendFile(f.path,count("33","22",6));await drain(d);
 const s=snapshot(d);assert.equal(s.summary.tokens,"11");assert.equal(s.coverage.enabled,false);assert.equal(s.coverage.partial,true);assert.equal(s.coverage.missingUsage,1);
}));

test("exact response records survive compaction counters that never advance and replayed response IDs never double count",()=>fixture(async f=>{
 const response=(id:string,n:string,offset:number)=>line("token_usage_record",{thread_id:thread,turn_id:turn,response_id:id,usage:native(n)},offset);
 await writeFile(f.path,start()+response("r1","100",1)+count("100","100",2)+response("compact","220731",3)+line("turn_context",{turn_id:turn,model:"model-a"},4)+count("100","35969",5)+response("r2","17",6)+count("117","17",7)+response("r2","17",8)+line("event_msg",{type:"task_complete",turn_id:turn},9));
 const d=f.open();await drain(d);const s=snapshot(d);assert.equal(s.summary.tokens,"220848");assert.equal(s.summary.categories.settled,"220848");
}));

test("receipt-only runtime retains confirmed admissions while suppressing durable and ephemeral token writes",()=>fixture(async f=>{
 const {CodexTokenUsageRuntime}=await import('../../apps/opencraft-daemon/src/token-usage-runtime.js');
 f.ledger.recordSource({threadId:thread,turnId:turn,lineage:"legacy",sourceId:"old",kind:"response",version:0,provider:"old",model:"old",counts:{totalTokens:"77"}});
 await writeFile(f.path,start()+line("token_usage_record",{thread_id:thread,turn_id:turn,session_id:thread,response_id:"new-response",usage:native("123"),turn_token_usage:native("123")},1)+line("event_msg",{type:"item_completed",thread_id:thread,turn_id:turn,item:{type:"UserMessage",client_id:"B"}},2));
 const invalidations:string[]=[];
 const runtime=new CodexTokenUsageRuntime(f.ledger,{
   request:async method=>method==="thread/read"?{thread:{path:f.path}}:{data:[{id:turn,status:"inProgress"}],nextCursor:null},
   submission:(_thread,input)=>input==="B"?{threadId:thread,inputId:"B",actorId:"B",actorKind:"human",mode:"steer",sourceKind:"human",submittedAt:at}:null,
   diagnostic:()=>{},derived:{invalidate:(id,path)=>{if(path)invalidations.push(id);}},
 });
 try{
  runtime.initialize({codexHome:f.home});
  const until=Date.now()+2500;while(!invalidations.length&&Date.now()<until)await new Promise(r=>setTimeout(r,10));
  assert.ok(invalidations.length);assert.equal(f.source.database.prepare("SELECT actor_id FROM token_usage_inputs WHERE input_id='B'").get()!.actor_id,"B");
  assert.equal(f.source.database.prepare("SELECT count(*) AS n FROM token_usage_sources").get()!.n,1);assert.equal(f.ledger.readTurn({threadId:thread,turnId:turn})!.observedTokens,"77");
  runtime.threadStarted({thread:{id:"ephemeral",ephemeral:true,path:null,turns:[]}});
  runtime.notification("thread/tokenUsage/updated",{threadId:"ephemeral",turnId:turn,tokenUsage:{total:{totalTokens:"999"}}});
  assert.equal(f.source.database.prepare("SELECT count(*) AS n FROM token_usage_native_counters").get()!.n,0);
 }finally{runtime.close();}
}));

test("source error coverage and settlement survive repeated cache-version rebuilds",()=>fixture(async f=>{
 await writeFile(f.path,start()+count("11","11")+count("-1","-1",2)+line("event_msg",{type:"task_complete",turn_id:turn},3));
 let d=f.open();await drain(d);const expected=values(d);assert.equal(snapshot(d).coverage.partial,true);assert.equal(snapshot(d).summary.categories.provisional,"11");
 for(let i=0;i<3;i++){
  d.database.prepare("UPDATE usage_cache_version SET version='rebuild'").run();d.close();d=f.open();await drain(d);
  assert.deepEqual(values(d),expected);assert.equal(snapshot(d).coverage.partial,true);
 }
}));

test("closed-turn enable changes and empty disabled history update query coverage without a changed receipt fingerprint",()=>fixture(async f=>{
 f.ledger.reconcile({threadId:thread,turnId:turn},{executionState:"completed",participantsComplete:true,usageComplete:false,responsesComplete:false});
 await writeFile(f.path,start()+count("11","11")+line("event_msg",{type:"task_complete",turn_id:turn},2));
 let d=f.open();await drain(d);const revision=snapshot(d).snapshotRevision;
 f.ledger.setEnabled(false);d.invalidate("*");await drain(d);assert.equal(snapshot(d).coverage.enabled,false);assert.ok(snapshot(d).snapshotRevision>revision);assert.equal(snapshot(d).summary.tokens,"11");
 f.ledger.setEnabled(true);d.invalidate("*");await drain(d);assert.equal(snapshot(d).coverage.enabled,true);
 d.close();f.source.database.exec("DELETE FROM token_usage_turns; DELETE FROM token_usage_inputs");f.ledger.setEnabled(false);await rm(join(f.directory,"token-usage-derived.sqlite"));
 d=f.open();await drain(d);assert.equal(snapshot(d).coverage.enabled,false);assert.equal(snapshot(d).summary.turns,0);
}));

test("a late standalone counter reset revises settled usage and rebuilds to the same state",()=>fixture(async f=>{
 await writeFile(f.path,start()+count("11","11")+line("event_msg",{type:"task_complete",turn_id:turn},2));
 let d=f.open();await drain(d);assert.equal(snapshot(d).summary.categories.settled,"11");
 await appendFile(f.path,count("3","3",3));await drain(d);assert.equal(snapshot(d).summary.categories.provisional,"11");const expected=values(d);d.close();await rm(join(f.directory,"token-usage-derived.sqlite"));
 d=f.open();await drain(d);assert.deepEqual(values(d),expected);assert.equal(snapshot(d).coverage.partial,true);
}));

test("switching receipt-only collection back to ledger replays every skipped native token from its original cursor",()=>fixture(async f=>{
 const {CodexTokenUsageRuntime}=await import('../../apps/opencraft-daemon/src/token-usage-runtime.js');
 const response=(id:string,n:string,total:string,offset:number)=>line("token_usage_record",{thread_id:thread,turn_id:turn,session_id:thread,response_id:id,usage:native(n),turn_token_usage:native(total)},offset);
 const before=start()+response("r1","77","77",1)+count("77","77",2);
 await writeFile(f.path,before);f.ledger.recordSource({threadId:thread,turnId:turn,lineage:'native-session:'+thread,sourceId:'r1',kind:'response',version:0,provider:'provider',model:'model-a',counts:{totalTokens:'77',inputTokens:'77',cachedInputTokens:'0',cacheWriteInputTokens:'0',outputTokens:'0',reasoningOutputTokens:'0'}});
 f.ledger.advanceRollout(thread,f.path,String(Buffer.byteLength(before)));
 await appendFile(f.path,response('r2','123','200',3)+count('200','123',4)+line('event_msg',{type:'task_complete',turn_id:turn},5));
 const port={request:async(method:string)=>method==='thread/read'?{thread:{path:f.path}}:{data:[{id:turn,status:'completed'}],nextCursor:null},diagnostic:()=>{}};
 let complete=false;let runtime=new CodexTokenUsageRuntime(f.ledger,{...port,derived:{invalidate:(_id,path)=>{if(path)complete=true;}}});
 try{
  runtime.initialize({codexHome:f.home});let until=Date.now()+2500;while(!complete&&Date.now()<until)await new Promise(r=>setTimeout(r,10));assert.ok(complete);
  assert.equal(f.ledger.rollout(thread)!.cursor,String(Buffer.byteLength(before)));assert.ok(f.ledger.participationCursor(thread,f.path)!>Buffer.byteLength(before));assert.equal(f.ledger.readTurn({threadId:thread,turnId:turn})!.observedTokens,'77');runtime.close();
  runtime=new CodexTokenUsageRuntime(f.ledger,port);runtime.initialize({codexHome:f.home});until=Date.now()+2500;
  while(f.ledger.readTurn({threadId:thread,turnId:turn})!.observedTokens!=='200'&&Date.now()<until)await new Promise(r=>setTimeout(r,10));
  assert.equal(f.ledger.readTurn({threadId:thread,turnId:turn})!.observedTokens,'200');
 }finally{runtime.close();}
}));

test("a late error revises more than one batch of settled history across restart and cache rebuild",()=>fixture(async f=>{
 let text=line('session_meta',{id:thread,model_provider:'provider'});
 for(let n=0;n<40;n++){
  const id=n===0?turn:'turn-'+String(n).padStart(2,'0'),key={threadId:thread,turnId:id};
  if(n>0){f.ledger.startTurn(key,at,'human',true);f.ledger.recordInput(key,{inputId:'A-'+n,actorId:'A',actorKind:'human',mode:'start',admission:'confirmed'});}
  text+=line('event_msg',{type:'task_started',turn_id:id},n*4)+line('turn_context',{turn_id:id,model:'model-a'},n*4+1)+count(String(n+1),'1',n*4+2)+line('event_msg',{type:'task_complete',turn_id:id},n*4+3);
 }
 await writeFile(f.path,text);let d=f.open();await drain(d);assert.equal(snapshot(d).summary.categories.settled,'40');
 await appendFile(f.path,count('0','0',200));let partialHistoricalPass=false;
 for(let i=0;i<100;i++){
  await d.step();const settled=BigInt(snapshot(d).summary.categories.settled??'0');
  if(settled>0n&&settled<39n){partialHistoricalPass=true;break;}
 }
 assert.ok(partialHistoricalPass,'older settled turns must change before the bounded historical refresh finishes');
 d.close();d=f.open();await drain(d);const expected=values(d);assert.equal(snapshot(d).summary.categories.provisional,'40');assert.equal(snapshot(d).summary.settledTurns,0);
 assert.ok(snapshot(d).rows.every(row=>'executionState'in row&&row.executionState==='completed'));
 d.close();await rm(join(f.directory,'token-usage-derived.sqlite'));d=f.open();await drain(d);assert.deepEqual(values(d),expected);
}));

test("the preceding cache schema upgrades without changing derived usage or retained source evidence",()=>fixture(async f=>{
 await writeFile(f.path,start()+count('11','11')+line('event_msg',{type:'task_complete',turn_id:turn},2));let d=f.open();await drain(d);const expected=values(d);d.close();
 const cache=new DatabaseSync(join(f.directory,'token-usage-derived.sqlite'));cache.exec('DROP INDEX token_usage_sources_observed_query; DROP INDEX derived_usage_gaps_thread; DELETE FROM schema_migrations WHERE version>=4');cache.close();
 d=f.open();await drain(d);assert.deepEqual(values(d),expected);
}));

test("retained history reports one source incident per thread and upgrades prior per-turn gap registrations",()=>fixture(async f=>{
 const second={threadId:thread,turnId:'second'};f.ledger.startTurn(second,at,'human',true);f.ledger.recordInput(second,{inputId:'A-second',actorId:'A',actorKind:'human',mode:'start',admission:'confirmed'});
 for(const [key,tokens]of [[{threadId:thread,turnId:turn},'77'],[second,'23']]as const)f.ledger.recordSource({...key,lineage:'old',sourceId:key.turnId,kind:'response',version:0,provider:'provider',model:'model-a',counts:{totalTokens:tokens}});
 let d=f.open();await drain(d);const expected=values(d);assert.equal(snapshot(d).summary.tokens,'100');assert.equal(snapshot(d).coverage.openGapIncidents,2);d.close();
 const cache=new DatabaseSync(join(f.directory,'token-usage-derived.sqlite'));cache.prepare("DELETE FROM token_usage_gaps WHERE gap_key=?").run('retained:'+thread);
 for(const id of [turn,'second'])cache.prepare('INSERT INTO token_usage_gaps VALUES(?,?,?,?,?,?,NULL)').run('server','retained:'+thread+':'+id,thread,null,'unreplayable',at);
 cache.exec('DROP INDEX token_usage_sources_observed_query; DELETE FROM schema_migrations WHERE version>=5');cache.close();
 d=f.open();await drain(d);assert.deepEqual(values(d),expected);assert.equal(snapshot(d).coverage.openGaps,2);assert.equal(snapshot(d).coverage.openGapIncidents,2);
}));

test("retained pre-cutover settled history stays settled when its original rollout is unavailable",()=>fixture(async f=>{
 const key={threadId:thread,turnId:turn};f.ledger.recordSource({...key,lineage:'old',sourceId:'old',kind:'response',version:0,provider:'provider',model:'model-a',counts:{totalTokens:'77'}});f.ledger.reconcile(key,{executionState:'completed',participantsComplete:true,usageComplete:true,responsesComplete:true});
 let d=f.open();await drain(d);const expected=values(d);assert.equal(snapshot(d).summary.categories.settled,'77');assert.equal(snapshot(d).coverage.partial,true);d.close();await rm(join(f.directory,'token-usage-derived.sqlite'));
 d=f.open();await drain(d);assert.deepEqual(values(d),expected);assert.equal(snapshot(d).summary.categories.settled,'77');
}));

test("a temporarily unavailable rollout clears its availability gap after verified catch-up",()=>fixture(async f=>{
 const d=f.open();await drain(d);assert.equal(snapshot(d).coverage.partial,true);
 await writeFile(f.path,start()+count('11','11')+line('event_msg',{type:'task_complete',turn_id:turn},2));await drain(d);
 const s=snapshot(d);assert.equal(s.summary.categories.settled,'11');assert.equal(s.coverage.partial,false);assert.equal(s.coverage.openGaps,0);
}));

test("a deployment without a usage source can start collection later and answer its first ready query",async()=>{
 const {TokenUsageQueryService}=await import('../../apps/opencraft-daemon/src/token-usage-query-service.js');const directory=await mkdtemp(join(tmpdir(),'oc-derived-late-source-'));
 const service=new TokenUsageQueryService({entry:new URL('../../apps/opencraft-daemon/src/token-usage-query-worker.ts',import.meta.url).pathname,databasePath:join(directory,'token-usage.sqlite'),serverId:'server',rollout:{nativeHome:join(directory,'runtime')}});
 let source:TokenUsageStateDatabase|undefined;
 try{
  await new Promise(r=>setTimeout(r,30));source=new TokenUsageStateDatabase(directory);const ledger=new OpenCraftTokenUsageLedger(source,'server',()=>at),key={threadId:thread,turnId:turn};ledger.startTurn(key,at,'human',true);ledger.recordInput(key,{inputId:'A',actorId:'A',actorKind:'human',mode:'start',admission:'confirmed'});ledger.recordSource({...key,lineage:'old',sourceId:'old',kind:'response',version:0,provider:'provider',model:'model-a',counts:{totalTokens:'77'}});
  assert.equal((await service.read(params,admin)).summary.tokens,'77');
 }finally{service.close();source?.close();await rm(directory,{recursive:true,force:true});}
});

test("v6 cache upgrades its recency index without discarding ready projections or renumbering migrations",()=>fixture(async f=>{
 await writeFile(f.path,start()+count('11','11')+line('event_msg',{type:'task_complete',turn_id:turn},2));let d=f.open();await drain(d);
 const expected=values(d),position=d.database.prepare('SELECT seq FROM usage_position').get()!.seq;
 const history=d.database.prepare('SELECT * FROM schema_migrations WHERE version<=6 ORDER BY version').all();d.close();
 const cache=new DatabaseSync(join(f.directory,'token-usage-derived.sqlite'));cache.exec('DROP INDEX token_usage_sources_observed_query; DELETE FROM schema_migrations WHERE version=7');cache.close();
 d=f.open();
 assert.equal(d.database.prepare('SELECT seq FROM usage_position').get()!.seq,position,'ready cache was not reset');
 assert.deepEqual(d.database.prepare('SELECT * FROM schema_migrations WHERE version<=6 ORDER BY version').all(),history);
 assert.equal(d.database.prepare('SELECT max(version) AS version FROM schema_migrations').get()!.version,7);
 assert.deepEqual(values(d),expected);await drain(d);assert.deepEqual(values(d),expected);
}));
