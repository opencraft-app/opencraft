import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {TokenUsageStateDatabase} from "../../apps/opencraft-daemon/src/token-usage-state-database.js";
import {OpenCraftTokenUsageLedger} from "../../apps/opencraft-daemon/src/token-usage-ledger.js";
import {replayRolloutUsage} from "../../apps/opencraft-daemon/src/token-usage-rollout.js";
const at=Date.parse("2026-10-21T00:00:00Z"),key={threadId:"thread",turnId:"turn"};
const stages=["admission-before-write","source-before-projection","projection-before-cursor","cursor-before-commit","after-commit"];
async function prepare(root:string){
 await mkdir(join(root,"native"));
 const admission=(id:string)=>({type:"event_msg",payload:{type:"item_completed",thread_id:"thread",turn_id:"turn",item:{type:"UserMessage",client_id:id}}});
 const rows:unknown[]=[admission("A-input"),admission("B-input")];
 let total=0;for(const [n,tokens] of [100,200,300].entries()){total+=tokens;rows.push({type:"token_usage_record",payload:{thread_id:"thread",turn_id:"turn",session_id:"session",response_id:"response"+n,usage:{total_tokens:tokens},turn_token_usage:{total_tokens:total}}});}
 rows.push({type:"event_msg",payload:{type:"task_complete",turn_id:"turn"}});
 await writeFile(join(root,"native","rollout.jsonl"),rows.map(row=>JSON.stringify(row)).join("\n")+"\n");
 const state=new TokenUsageStateDatabase(join(root,"host"));
 try{const ledger=new OpenCraftTokenUsageLedger(state,"server",()=>at);ledger.startTurn(key,at,"human",true);
  for(const actor of ["A","B"])ledger.recordSubmission({threadId:"thread",inputId:actor+"-input",actorId:actor,actorKind:"human",mode:actor==="A"?"start":"steer",sourceKind:"human",submittedAt:at});
  ledger.rememberRollout("thread",join(root,"native","rollout.jsonl"));
 }finally{state.close();}
}
async function recover(root:string){
 const state=new TokenUsageStateDatabase(join(root,"host"));
 try{
  const ledger=new OpenCraftTokenUsageLedger(state,"server",()=>at),path=join(root,"native","rollout.jsonl");
  for(let batches=0;;batches++){
   assert.ok(batches<100,"recovery must advance its bounded cursor");
   const result=await replayRolloutUsage({path,nativeHome:join(root,"native"),threadId:"thread",ledger,cursor:Number(ledger.rollout("thread")!.cursor),onAdmission:fact=>ledger.recordAdmission(fact,fact.inputId),onTerminal:turnId=>ledger.recordNativeTerminal({threadId:"thread",turnId}),onCommitCursor:cursor=>ledger.advanceRollout("thread",path,String(cursor))});
   if(!result.more)break;
  }
  ledger.reconcile(key,{executionState:"completed",participantsComplete:true,...ledger.nativeSettlement(key)});
  const snapshot=ledger.query({from:"2026-10-21",through:"2026-10-21",scope:"team"},()=>({actorId:"admin",administrator:true}));
  return {summary:snapshot.summary,daily:snapshot.daily,models:snapshot.models,coverage:snapshot.coverage,
   allocations:ledger.readAllocations(key),cursor:ledger.rollout("thread")!.cursor,
   sources:state.database.prepare("SELECT source_id,source_kind,counts_json FROM token_usage_sources ORDER BY source_kind,source_id").all(),
   admissions:state.database.prepare("SELECT input_id,turn_id FROM token_usage_admissions ORDER BY input_id").all()};
 }finally{state.close();}
}
test("NF-02: SIGKILL at each of five atomic boundaries, twenty times each, recovers the same usage and cursor",{timeout:600000},async()=>{
 const base=await mkdtemp(join(tmpdir(),"oc-usage-crash-matrix-"));
 try{
  const reference=join(base,"reference");await mkdir(reference);await prepare(reference);const expected=await recover(reference);
  assert.equal(expected.summary.tokens,"600");assert.deepEqual(expected.allocations.map(row=>row.tokens),["300","300"]);
  const moduleUrl=(name:string)=>new URL("../apps/opencraft-daemon/src/"+name,new URL("../", import.meta.url)).href;
  const child=join(base,"crash.mjs");
  await writeFile(child,`
import {TokenUsageStateDatabase} from ${JSON.stringify(moduleUrl("token-usage-state-database.ts"))};
import {OpenCraftTokenUsageLedger} from ${JSON.stringify(moduleUrl("token-usage-ledger.ts"))};
import {replayRolloutUsage} from ${JSON.stringify(moduleUrl("token-usage-rollout.ts"))};
const [root,stage]=process.argv.slice(2),state=new TokenUsageStateDatabase(root+'/host'),ledger=new OpenCraftTokenUsageLedger(state,'server',()=>${at}),db=state.database;
const crash=()=>{process.kill(process.pid,'SIGKILL');return 0;};db.function('crash_owner',crash);
const triggers={
 'admission-before-write':"BEFORE INSERT ON token_usage_admissions",
 'source-before-projection':"AFTER INSERT ON token_usage_sources",
 'projection-before-cursor':"AFTER INSERT ON token_usage_daily",
 'cursor-before-commit':"AFTER INSERT ON token_usage_checkpoints"
};
if(triggers[stage])db.exec('CREATE TEMP TRIGGER crash_metering '+triggers[stage]+' BEGIN SELECT crash_owner(); END');
const path=root+'/native/rollout.jsonl';
let cursor=0;for(let batch=0;batch<100;batch++){const result=await replayRolloutUsage({path,nativeHome:root+'/native',threadId:'thread',ledger,cursor,onAdmission:fact=>ledger.recordAdmission(fact,fact.inputId),onTerminal:turnId=>ledger.recordNativeTerminal({threadId:'thread',turnId}),onCommitCursor:cursor=>ledger.advanceRollout('thread',path,String(cursor))});cursor=result.cursor;if(!result.more)break;}

if(stage==='after-commit')crash();
throw new Error('injection boundary was not reached');
`);
  let count=0;
  for(const stage of stages)for(let n=0;n<20;n++){
   const root=join(base,stage+'-'+n);await mkdir(root);await prepare(root);
   const result=spawnSync(process.execPath,["--import","tsx",child,root,stage],{cwd:process.cwd(),encoding:"utf8",timeout:30000});
   assert.equal(result.signal,"SIGKILL",JSON.stringify({stage,n,status:result.status,stderr:result.stderr,error:result.error?.message}));
   assert.deepEqual(await recover(root),expected,stage+" attempt "+n);
   await rm(root,{recursive:true,force:true});count++;
  }
  assert.equal(count,100);
 }finally{await rm(base,{recursive:true,force:true});}
});
