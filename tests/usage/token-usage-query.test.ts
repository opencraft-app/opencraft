import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenUsageStateDatabase } from "../../apps/opencraft-daemon/src/token-usage-state-database.js";
import { OpenCraftTokenUsageLedger } from "../../apps/opencraft-daemon/src/token-usage-ledger.js";
import { TokenUsageQueryError } from "../../apps/opencraft-daemon/src/token-usage-query.js";
const at=Date.parse("2026-10-20T16:00:00Z");
const params={from:"2026-10-21",through:"2026-10-21"};
const A=()=>({actorId:"A",administrator:false}), B=()=>({actorId:"B",administrator:false}), admin=()=>({actorId:"admin",administrator:true});
async function fixture(body:(ledger:OpenCraftTokenUsageLedger,state:TokenUsageStateDatabase)=>void) {
  const path=await mkdtemp(join(tmpdir(),"oc-query-"));const state=new TokenUsageStateDatabase(path);
  const ledger=new OpenCraftTokenUsageLedger(state,"server",()=>at);
  try{body(ledger,state);}finally{state.close();await rm(path,{recursive:true,force:true});}
}
function turn(ledger:OpenCraftTokenUsageLedger,id:string,actors:string[],counts=["5","5"],startedAt=at) {
  const key={threadId:"thread",turnId:id};
  ledger.startTurn(key,startedAt,"human",true);
  for(const actorId of actors) ledger.recordInput(key,{inputId:id+actorId,actorId,actorKind:"human",mode:"start",admission:"confirmed"});
  for(const [i,count] of counts.entries()) ledger.recordSource({...key,lineage:"epoch",sourceId:String(i),kind:"response",version:0,provider:"p"+i,model:"same-name",counts:{totalTokens:count}});
  ledger.reconcile(key,{executionState:"completed",participantsComplete:true,usageComplete:true,responsesComplete:true});
}
const code=(kind:string)=>(error:unknown)=>error instanceof TokenUsageQueryError&&error.code===kind;
test("self/team snapshots conserve exact model intersections and do not expose fellow participants",()=>fixture(ledger=>{
  turn(ledger,"shared",["A","B","C"]);
  const personal=ledger.query(params,A), team=ledger.query({...params,scope:"team"},admin);
  assert.equal(personal.summary.tokens,"4");assert.equal(team.summary.tokens,"10");
  assert.deepEqual(personal.models.map(m=>m.tokens),["2","2"]);
  assert.equal(personal.rows[0]!.participantCount,3);
  assert.equal(personal.rows[0]!.rawTokens,"10");
  assert.equal(JSON.stringify(personal).includes('"B"'),false);assert.equal(JSON.stringify(personal).includes('"C"'),false);
  const selected=ledger.query({...params,modelKey:personal.models[0]!.key},A);
  assert.equal(selected.summary.tokens,"2");assert.equal(selected.rows[0]!.rawTokens,"5");
  assert.equal(ledger.query(params,B).summary.tokens,"3");
  assert.throws(()=>ledger.query({...params,actorId:"B"},A),code("forbidden"));
  assert.throws(()=>ledger.query({...params,scope:"team"},A),code("forbidden"));
  assert.throws(()=>ledger.query({...params,serverId:"other"},admin),code("forbidden"));
  assert.throws(()=>ledger.query({...params,view:"actors"},A),code("forbidden"));
}));
test("signed pagination binds scope, date, limit and revision, and does not repeat rows",()=>fixture(ledger=>{
  for(let i=0;i<4;i++)turn(ledger,"turn"+i,["A"],["100"],at+i);
  const first=ledger.query({...params,limit:2},A);assert.ok(first.nextCursor);
  const second=ledger.query({...params,limit:2,cursor:first.nextCursor},A);
  assert.equal(second.nextCursor,null);assert.equal(new Set([...first.rows,...second.rows].map(r=>r.turnId)).size,4);
  assert.throws(()=>ledger.query({...params,limit:2,cursor:first.nextCursor},B),code("forbidden"));
  assert.throws(()=>ledger.query({...params,limit:3,cursor:first.nextCursor},A),code("forbidden"));
  assert.throws(()=>ledger.query({...params,limit:2,cursor:first.nextCursor!.slice(0,-1)+"!"},A));
  turn(ledger,"late",["A"]);
  assert.throws(()=>ledger.query({...params,limit:2,cursor:first.nextCursor},A),code("stale-snapshot"));
}));
test("current identity is checked again before returning, and unsafe/date/authority inputs fail closed",()=>fixture(ledger=>{
  turn(ledger,"turn",["A"]);
  assert.throws(()=>ledger.query(params,()=>null),code("unauthorized"));
  let calls=0;assert.throws(()=>ledger.query(params,()=>++calls===1?A():null),code("unauthorized"));
  calls=0;assert.throws(()=>ledger.query({...params,scope:"team"},()=>++calls===1?admin():A()),code("forbidden"));
  for(const bad of [{...params,limit:101},{...params,actorContext:{actorId:"admin"}},{...params,from:"2026-02-30"},{...params,through:"2026-10-20"}])assert.throws(()=>ledger.query(bad,A));
  assert.equal(ledger.query(params,A).summary.tokens,"10","failed reads did not mutate or retain a transaction");
}));
test("Shanghai start-day boundaries and arbitrary precision survive without SQL SUM or Number conversion",()=>fixture(ledger=>{
  turn(ledger,"inside",["A"],["9007199254740993123456789"],at);
  turn(ledger,"next-day",["A"],["9"],at+86400000);
  const result=ledger.query(params,A);
  assert.equal(result.summary.tokens,"9007199254740993123456789");assert.equal(result.summary.turns,1);
  assert.equal(result.daily[0]!.key,"2026-10-21");
}));
test("pending participant remains visible to self without assigning its known raw amount",()=>fixture(ledger=>{
  turn(ledger,"pending",["A"]);
  ledger.recordInput({threadId:"thread",turnId:"pending"},{inputId:"unknown",actorId:null,actorKind:"unknown",mode:"steer",admission:"pending"});
  const result=ledger.query(params,A);
  assert.equal(result.summary.tokens,"0");assert.equal(result.rows[0]!.rawTokens,"10");assert.equal(result.rows[0]!.allocationState,"pending");
  assert.equal(ledger.query(params,B).rows.length,0);
}));

test("bulk team reductions match the generic exact projection for mixed states, models, missing usage and grouped pages",async()=>{
 const path=await mkdtemp(join(tmpdir(),"oc-team-differential-")),state=new TokenUsageStateDatabase(path),ledger=new OpenCraftTokenUsageLedger(state,"server",()=>at);
 try{
  for(let n=0;n<20;n++){
   const key={threadId:"thread"+(n%4),turnId:"turn"+n};
   ledger.startTurn(key,at+n,"human",true);
   if(n%5===0)ledger.startTurn({...key,turnId:"system"+n},at+n,"system",true);
   for(const actor of ["A","B"])ledger.recordInput(key,{inputId:key.turnId+actor,actorId:actor,actorKind:"human",mode:"start",admission:"confirmed"});
   if(n%7!==0)for(const model of [0,1])ledger.recordSource({...key,lineage:"epoch",sourceId:String(model),kind:"response",version:0,provider:model===0?"p":null,model:model===0?"same-name":null,counts:{totalTokens:model===0?(9007199254740993123456789n+BigInt(n)).toString():"5"}});
   if(n%3===0)ledger.recordInput(key,{inputId:key.turnId+"unknown",actorId:null,actorKind:"unknown",mode:"steer",admission:"pending"});
   ledger.reconcile(key,{executionState:n%4===0?"running":"completed",participantsComplete:true,usageComplete:true,responsesComplete:true});
  }
  const {TokenUsageQuery}=await import("../../apps/opencraft-daemon/src/token-usage-query.js");
  const fast=new TokenUsageQuery(state,"server","Asia/Shanghai",()=>at),reference=new TokenUsageQuery(state,"server","Asia/Chongqing",()=>at);
  for(const view of ["turns","threads","actors"])for(const modelKey of [undefined,JSON.stringify(["p","same-name"]),JSON.stringify([null,null])]){
   const request={...params,scope:"team",view,limit:100,...(modelKey?{modelKey}:{})};
   const actual=fast.read(request,admin),expected=reference.read(request,admin);
   assert.deepEqual(actual.summary,expected.summary,JSON.stringify({view,modelKey}));assert.deepEqual(actual.daily,expected.daily);
   assert.deepEqual(actual.models,expected.models);assert.deepEqual(actual.coverage,expected.coverage);assert.deepEqual(actual.rows,expected.rows);
  }
 }finally{state.close();await rm(path,{recursive:true,force:true});}
});

test("personal turn selection deduplicates admissions and isolates matching IDs in another deployment",async()=>{
 const path=await mkdtemp(join(tmpdir(),"oc-personal-scope-")),state=new TokenUsageStateDatabase(path);
 try{
  const ledger=new OpenCraftTokenUsageLedger(state,"server",()=>at),other=new OpenCraftTokenUsageLedger(state,"other",()=>at);
  turn(ledger,"same",["A","B"]);turn(other,"same",["A"],["9999"]);
  ledger.recordInput({threadId:"thread",turnId:"same"},{inputId:"A-second-device",actorId:"A",actorKind:"human",mode:"steer",admission:"confirmed"});
  turn(ledger,"private-to-B",["B"],["1000"]);
  turn(ledger,"yesterday",["A"],["2000"],at-1);
  const response=ledger.query(params,A);
  assert.equal(response.summary.turns,1);assert.equal(response.summary.tokens,"5");
  assert.equal(response.rows.length,1);assert.equal(response.rows[0]!.turnId,"same");
  assert.equal(response.rows[0]!.participantCount,2);
  assert.equal(response.rows[0]!.rawTokens,"10");
  assert.equal(response.rows[0]!.allocatedTokens,"5");
  assert.equal(ledger.query({...params,threadId:"thread",turnId:"private-to-B"},A).summary.turns,0);
 }finally{state.close();await rm(path,{recursive:true,force:true});}
});

test("team actor pages skip out-of-range identities and count multi-model turns once",()=>fixture(ledger=>{
 turn(ledger,"old",["A"],["500"],at-1);
 turn(ledger,"B-today",["B"]);turn(ledger,"C-today",["C"]);
 const request={...params,scope:"team",view:"actors",limit:1};
 const first=ledger.query(request,admin);
 assert.deepEqual(first.rows,[{key:"B",tokens:"10",turns:1}]);assert.ok(first.nextCursor);
 const second=ledger.query({...request,cursor:first.nextCursor},admin);
 assert.deepEqual(second.rows,[{key:"C",tokens:"10",turns:1}]);assert.equal(second.nextCursor,null);
 assert.deepEqual(ledger.query({...request,modelKey:JSON.stringify(["p0","same-name"])},admin).rows,[{key:"B",tokens:"5",turns:1}]);
 assert.deepEqual(ledger.query({...request,threadId:"thread",turnId:"C-today"},admin).rows,[{key:"C",tokens:"10",turns:1}]);
}));

test("paused collection retains acquired turn amounts and exposes missing coverage across every projection",()=>fixture(ledger=>{
 const key={threadId:"thread",turnId:"paused"};
 ledger.startTurn(key,at,"human",true);
 ledger.recordInput(key,{inputId:"start-A",actorId:"A",actorKind:"human",mode:"start",admission:"confirmed"});
 ledger.recordSource({...key,lineage:"native",sourceId:"first",kind:"response",version:0,provider:"p",model:"m",counts:{totalTokens:"123"}});
 ledger.setEnabled(false);
 for(const scope of ["self","team"])for(const view of ["turns","threads",...(scope==="team"?["actors"]:[])]){
  const result=ledger.query({...params,scope,view},scope==="team"?admin:A);
  assert.equal(result.summary.tokens,"123");assert.equal(result.summary.turns,1);
  assert.equal(result.coverage.enabled,false);assert.equal(result.coverage.partial,true);assert.equal(result.coverage.missingUsage,1);
  assert.equal(result.daily[0]?.tokens,"123");assert.equal(result.models[0]?.tokens,"123");
 }
 const filtered=ledger.query({...params,scope:"team",modelKey:JSON.stringify(["p","m"])},admin);
 assert.equal(filtered.summary.tokens,"123");assert.equal(filtered.coverage.partial,true);
 assert.equal(ledger.recordSource({...key,lineage:"native",sourceId:"late",kind:"response",version:0,provider:"p",model:"m",counts:{totalTokens:"999"}}),"excluded");
 ledger.setEnabled(true);
 assert.equal(ledger.query(params,A).summary.tokens,"123");assert.equal(ledger.query(params,A).coverage.partial,true);
}));


test("conversation count spans every matching turn rather than only the current page",()=>fixture(ledger=>{
 for(const [threadId,turnId,model] of [["shared","one","m1"],["shared","two","m2"],["other","three","m1"]]){
  const key={threadId,turnId};ledger.startTurn(key,at,"human",true);
  ledger.recordInput(key,{inputId:turnId,actorId:"A",actorKind:"human",mode:"start",admission:"confirmed"});
  ledger.recordSource({...key,lineage:"native",sourceId:turnId,kind:"response",version:0,provider:"p",model,counts:{totalTokens:"10"}});
 }
 for(const authorize of [A,admin])for(const scope of authorize===A?["self"]:["self","team"]){
  const result=ledger.query({...params,scope,limit:1},authorize);
  if(authorize===admin&&scope==="self"){assert.equal(result.summary.threads,0);continue;}
  assert.equal(result.rows.length,1);assert.equal(result.summary.turns,3);assert.equal(result.summary.threads,2);
  assert.equal(ledger.query({...params,scope,threadId:"shared",limit:1},authorize).summary.threads,1);
  assert.equal(ledger.query({...params,scope,modelKey:JSON.stringify(["p","m2"]),limit:1},authorize).summary.threads,1);
 }
}));


test("query SQL statement allocation is bounded across repeated authorized reads",()=>fixture((ledger,state)=>{
  turn(ledger,"first",["A","B"]);
  turn(ledger,"second",["A"]);
  let preparations=0;
  const prepare=state.database.prepare.bind(state.database);
  state.database.prepare=((sql:string)=>{preparations++;return prepare(sql);}) as typeof state.database.prepare;
  const first=ledger.query(params,A);
  const warmed=preparations;
  for(let n=0;n<200;n++)assert.equal(ledger.query(params,A).summary.tokens,first.summary.tokens);
  assert.equal(preparations,warmed,"steady-state reads must not repeatedly allocate native statements");
  // A failed reduction must release its manual bulk iterator and snapshot so
  // the same physical query owner can serve a later repaired committed state.
  state.database.prepare("UPDATE token_usage_buckets SET tokens='malformed' WHERE turn_id='first'").run();
  assert.throws(()=>ledger.query(params,A));
  state.database.prepare("UPDATE token_usage_buckets SET tokens='5' WHERE turn_id='first'").run();
  assert.equal(ledger.query(params,A).summary.tokens,first.summary.tokens);
}));

test("coverage and summary expose settledTurns, lastSourceSuccessAt and openGapIncidents",()=>fixture((ledger,state)=>{
  turn(ledger,"settled-1",["A"],["100"],at);
  turn(ledger,"settled-2",["A"],["200"],at+1000);
  // An uncompleted turn
  const uncompletedKey = {threadId:"thread",turnId:"running-turn"};
  ledger.startTurn(uncompletedKey,at+2000,"human",true);
  ledger.recordInput(uncompletedKey,{inputId:"in-run",actorId:"A",actorKind:"human",mode:"start",admission:"confirmed"});
  ledger.recordSource({...uncompletedKey,lineage:"native",sourceId:"src",kind:"response",version:0,provider:"p",model:"m",counts:{totalTokens:"50"}});

  // Insert two gaps on same thread with same reason (should deduplicate to 1 incident)
  ledger.noteGap({ id: "g1", reason: "source-offline", threadId: "thread" });
  ledger.noteGap({ id: "g2", reason: "source-offline", threadId: "thread" });
  // And one gap with different reason (making 2 incidents total)
  ledger.noteGap({ id: "g3", reason: "oversized-line", threadId: "thread" });

  const selfResult = ledger.query(params,A);
  assert.equal(selfResult.summary.turns,3);
  assert.equal(selfResult.summary.settledTurns,2);
  assert.equal(selfResult.coverage.openGapIncidents,2);
  assert.equal(typeof selfResult.coverage.lastSourceSuccessAt,"number");
  assert.ok(selfResult.coverage.lastSourceSuccessAt! >= at);

  const teamResult = ledger.query({...params,scope:"team"},admin);
  assert.equal(teamResult.summary.turns,3);
  assert.equal(teamResult.summary.settledTurns,2);
  assert.equal(teamResult.coverage.openGapIncidents,2);
  assert.equal(typeof teamResult.coverage.lastSourceSuccessAt,"number");
  assert.ok(teamResult.coverage.lastSourceSuccessAt! >= at);
}));

test("coverage counts retain global and per-thread reasons while isolating actor admissions, dates and deployments",()=>fixture((ledger,state)=>{
 const add=(threadId:string,turnId:string,actorId:string,startedAt=at,kind:'human'|'session'='human',admission:'confirmed'|'pending'='confirmed')=>{
  const key={threadId,turnId};ledger.startTurn(key,startedAt,'human',true);ledger.recordInput(key,{inputId:turnId+actorId,actorId,actorKind:kind,mode:'start',admission});
 };
 add('visible','today','A');add('visible','again','A');add('foreign','old-A','A',at-1);add('foreign','today-B','B');
 add('session','today-session','A',at,'session');add('pending','pending-A','A',at,'human','pending');add('old','old','A',at-1);
 ledger.noteGap({id:'global',reason:'source-offline'});
 for(const [id,threadId,reason]of [['a1','visible','unreplayable'],['a2','visible','unreplayable'],['a3','visible','invalid-source'],['b','foreign','unreplayable'],['s','session','unreplayable'],['p','pending','unreplayable'],['old','old','unreplayable'],['gone','visible','source-offline']]as const)ledger.noteGap({id,threadId,reason});
 ledger.resolveGap('gone');new OpenCraftTokenUsageLedger(state,'other',()=>at).noteGap({id:'other-global',reason:'source-offline'});
 for(const view of ['turns','threads']){
  const a=ledger.query({...params,view},A).coverage,b=ledger.query({...params,view},B).coverage;
  assert.equal(a.openGaps,5);assert.equal(a.openGapIncidents,4);
  assert.equal(b.openGaps,2);assert.equal(b.openGapIncidents,2);
 }
 const team=ledger.query({...params,scope:'team'},admin).coverage;assert.equal(team.openGaps,7);assert.equal(team.openGapIncidents,6);
 assert.equal(ledger.query({...params,threadId:'no-turn',modelKey:'no-model'},A).coverage.openGaps,5,'coverage remains period-scoped, including when details are filtered away');
}));
