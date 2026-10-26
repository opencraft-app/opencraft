import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, appendFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenUsageStateDatabase } from "../../apps/opencraft-daemon/src/token-usage-state-database.js";
import { OpenCraftTokenUsageLedger } from "../../apps/opencraft-daemon/src/token-usage-ledger.js";
import { replayRolloutUsage } from "../../apps/opencraft-daemon/src/token-usage-rollout.js";

const key = {threadId:"thread",turnId:"turn"};
const record = (id: string, count: number) => JSON.stringify({type:"token_usage_record",payload:{
  thread_id:"thread",turn_id:"turn",session_id:"session",response_id:id,usage:{total_tokens:count},
  thread_token_usage:{total_tokens:900000},
}})+"\n";
async function fixture(body: (value: {root: string; nativeHome: string; path: string; threadId: string; ledger: OpenCraftTokenUsageLedger; state: TokenUsageStateDatabase})=>Promise<void>) {
  const root=await mkdtemp(join(tmpdir(),"oc-usage-rollout-"));
  const nativeHome=join(root,"native"); await mkdir(nativeHome);
  const state=new TokenUsageStateDatabase(join(root,"host"));
  const ledger=new OpenCraftTokenUsageLedger(state,"server",()=>1000);
  ledger.startTurn(key,1000,"human",true);
  ledger.recordInput(key,{inputId:"input",actorId:"A",actorKind:"human",mode:"start",admission:"confirmed"});
  try {await body({root,nativeHome,path:join(nativeHome,"rollout.jsonl"),threadId:"thread",ledger,state});}
  finally {state.close(); await rm(root,{recursive:true,force:true});}
}
test("replaying durable facts after a cursor or from zero is idempotent and ignores prompt history",()=>fixture(async options=>{
  await writeFile(options.path,JSON.stringify({type:"response_item",payload:{body:"SENSITIVE_BODY"}})+"\n"+record("one",100)+record("two",200));
  const first=await replayRolloutUsage(options);
  assert.equal(first.observed,2); assert.equal(first.changed,2); assert.equal(first.more,false);
  assert.equal(options.ledger.readTurn(key)?.observedTokens,"300");
  assert.equal(options.ledger.checkpoint("native-session:session"),String(first.cursor));
  const replay=await replayRolloutUsage(options); assert.equal(replay.changed,0);
  await appendFile(options.path,record("three",300));
  assert.equal((await replayRolloutUsage({...options,cursor:first.cursor})).changed,1);
  assert.equal(options.ledger.readTurn(key)?.observedTokens,"600");
  assert.doesNotMatch(JSON.stringify(options.ledger.readTurn(key)),/SENSITIVE_BODY/);
}));
test("an incomplete count line does not advance the cursor or guess zero; completing it recovers the fact",()=>fixture(async options=>{
  const line=record("one",100), half=Math.floor(line.length/2);
  await writeFile(options.path,line.slice(0,half));
  const before=await replayRolloutUsage(options);
  assert.equal(before.cursor,0); assert.equal(before.changed,0); assert.equal(before.more,true);
  assert.equal(options.ledger.readTurn(key)?.observedTokens,null);
  await appendFile(options.path,line.slice(half));
  assert.equal((await replayRolloutUsage({...options,cursor:before.cursor})).changed,1);
}));

test("generation source chooses its own HOME and validates before committing counts or cursor",()=>fixture(async options=>{
  const home=join(options.root,"new-home");await mkdir(home);
  const path=join(home,"rollout.jsonl");await writeFile(path,record("new",123));
  const source={nativeHome:home,key:"new:1",validate:async()=>{throw new Error("owner changed");}};
  let committed=false;
  await assert.rejects(replayRolloutUsage({...options,path,source,onCommitCursor:()=>{committed=true;}}),/owner changed/);
  assert.equal(committed,false);assert.equal(options.ledger.readTurn(key)?.observedTokens,null);
  const accepted=await replayRolloutUsage({...options,path,source:{...source,validate:async()=>{}}});
  assert.equal(accepted.changed,1);assert.equal(options.ledger.readTurn(key)?.observedTokens,"123");
  assert.equal((await replayRolloutUsage({...options,path,source:{...source,validate:async()=>{}}})).changed,0);
}));
test("native storage boundary rejects escapes and truncated cursors, and oversized lines stay bounded",()=>fixture(async options=>{
  const outside=join(options.root,"outside");await writeFile(outside,record("one",100));
  await symlink(outside,options.path);
  await assert.rejects(replayRolloutUsage(options),/outside native storage/);
  await rm(options.path); await writeFile(options.path,"x".repeat(100));
  await assert.rejects(replayRolloutUsage({...options,cursor:101}),/requires reconciliation/);
  await assert.rejects(replayRolloutUsage({...options,maxBytes:50}),/exceeds replay batch/);

  // Oversized non-fact line is skipped without gap
  const notifications: Array<[boolean, number]> = [];
  const onOversizedLine = (mayContainFact: boolean, bytes: number) => { notifications.push([mayContainFact, bytes]); };
  const oversizedToolOutput = JSON.stringify({type:"response_item",payload:{output:"x".repeat(500)}})+"\n";
  await writeFile(options.path, oversizedToolOutput + record("one", 100));
  const skipResult = await replayRolloutUsage({...options, maxBytes: 300, onOversizedLine});
  assert.equal(skipResult.skipped, 1);
  assert.equal(skipResult.oversizedFact, false);
  assert.equal(skipResult.cursor, oversizedToolOutput.length);
  assert.deepEqual(notifications, [[false, oversizedToolOutput.length]], "one non-fact line emits one typed observation");
  const nextReplay = await replayRolloutUsage({...options, maxBytes: 300, cursor: skipResult.cursor});
  assert.equal(nextReplay.observed, 1);
  assert.equal(nextReplay.changed, 1);

  // Oversized fact line is skipped with gap (missing++)
  const oversizedFactOutput = JSON.stringify({type:"event_msg",payload:{type:"item_completed",content:"y".repeat(500)}})+"\n";
  await writeFile(options.path, oversizedFactOutput + record("two", 200));
  notifications.length = 0;
  const factSkipResult = await replayRolloutUsage({...options, maxBytes: 300, onOversizedLine});
  assert.equal(factSkipResult.skipped, 1);
  assert.equal(factSkipResult.oversizedFact, true);
  assert.equal(factSkipResult.missing, 1);
  assert.equal(factSkipResult.cursor, oversizedFactOutput.length);
  assert.deepEqual(notifications, [[true, oversizedFactOutput.length]], "one possible fact emits one typed observation");
}));

test("rollout replay parses session_meta and turn_context into source provider and model",()=>fixture(async options=>{
  const meta = JSON.stringify({type:"session_meta",payload:{model_provider:"test-provider"}})+"\n";
  const context = JSON.stringify({type:"turn_context",payload:{turn_id:"turn",model:"test-model"}})+"\n";
  await writeFile(options.path, meta + context + record("one", 100));
  const result = await replayRolloutUsage(options);
  assert.equal(result.observed, 1);
  const turn = options.ledger.readTurn(key);
  assert.equal(turn?.observedTokens, "100");
  const allocations = options.ledger.readAllocations(key);
  assert.equal(allocations[0]?.provider, "test-provider");
  assert.equal(allocations[0]?.model, "test-model");
}));

test("bounded replay joins actual admission IDs and settles only after a durable terminal plus per-turn report",()=>fixture(async options=>{
  const {ledger}=options;
  ledger.recordSubmission({threadId:"thread",inputId:"start-A",actorId:"A",actorKind:"human",mode:"start",sourceKind:"human",submittedAt:1000});
  ledger.recordSubmission({threadId:"thread",inputId:"steer-B",actorId:"B",actorKind:"human",mode:"steer",sourceKind:"human",submittedAt:1000});
  const admitted=(inputId:string)=>JSON.stringify({type:"event_msg",payload:{type:"item_completed",thread_id:"thread",turn_id:"turn",item:{type:"UserMessage",client_id:inputId}}})+"\n";
  const usage=(id:string,total:number)=>{
    const row=JSON.parse(record(id,100));row.payload.turn_token_usage={total_tokens:total};return JSON.stringify(row)+"\n";
  };
  await writeFile(options.path,admitted("start-A")+usage("one",100)+admitted("steer-B")+usage("two",200)+JSON.stringify({type:"event_msg",payload:{type:"task_complete",turn_id:"turn"}})+"\n");
  const replay={...options,maxFacts:2,onAdmission:(fact:{turnId:string;inputId:string})=>{ledger.recordAdmission({threadId:"thread",turnId:fact.turnId},fact.inputId);},onTerminal:(turnId:string)=>ledger.recordNativeTerminal({threadId:"thread",turnId})};
  let first=await replayRolloutUsage(replay);
  for(let batch=0;ledger.readTurn(key)?.observedTokens===null && first.more;batch++){
    assert.ok(batch<10,"bounded replay must reach the first usage fact");
    first=await replayRolloutUsage({...replay,cursor:first.cursor});
  }
  assert.equal(first.more,true);assert.equal(ledger.readTurn(key)?.observedTokens,"100");
  assert.equal(ledger.nativeSettlement(key).usageComplete,false);
  let second=await replayRolloutUsage({...replay,cursor:first.cursor});
  for(let batch=0;ledger.readTurn(key)?.observedTokens!=="200" && second.more;batch++){
    assert.ok(batch<10,"bounded replay must reach the second usage fact");
    second=await replayRolloutUsage({...replay,cursor:second.cursor});
  }
  assert.equal(second.more,true);
  assert.deepEqual(ledger.readAllocations(key).map(row=>row.tokens),["100","100"]);
  await replayRolloutUsage({...replay,cursor:second.cursor});
  assert.deepEqual(ledger.nativeSettlement(key),{usageComplete:true,responsesComplete:true});
  ledger.reconcile(key,{executionState:"completed",participantsComplete:true,...ledger.nativeSettlement(key)});
  assert.equal(ledger.readTurn(key)?.allocationState,"settled");
}));

test("a failed snapshot transaction cannot commit its preceding response or recovery cursor",()=>fixture(async options=>{
  const row=JSON.parse(record("one",100));row.payload.turn_token_usage={total_tokens:100};
  await writeFile(options.path,JSON.stringify(row)+"\n");
  options.state.database.exec("CREATE TEMP TRIGGER snapshot_fault BEFORE INSERT ON token_usage_sources WHEN NEW.source_kind='turn-snapshot' BEGIN SELECT RAISE(ABORT,'snapshot failure'); END");
  await assert.rejects(replayRolloutUsage(options),/snapshot failure/);
  assert.equal(options.ledger.readTurn(key)?.observedTokens,null);
  assert.equal(options.ledger.checkpoint("native-session:session"),null);
  assert.equal(options.state.database.prepare("SELECT COUNT(*) AS n FROM token_usage_sources").get()!.n,0);
  options.state.database.exec("DROP TRIGGER snapshot_fault");
  assert.equal((await replayRolloutUsage(options)).changed,1);
  assert.equal(options.ledger.readTurn(key)?.observedTokens,"100");
  assert.equal(options.ledger.nativeSettlement(key).usageComplete,false);
}));

test("cursor commit failure rolls back admitted inputs, sources and projections as one replay batch",()=>fixture(async options=>{
  const {ledger,state}=options;
  ledger.rememberRollout("thread",options.path);
  ledger.recordSubmission({threadId:"thread",inputId:"steer-B",actorId:"B",actorKind:"human",mode:"steer",sourceKind:"human",submittedAt:1000});
  const admitted=JSON.stringify({type:"event_msg",payload:{type:"item_completed",thread_id:"thread",turn_id:"turn",item:{type:"UserMessage",client_id:"steer-B"}}})+"\n";
  await writeFile(options.path,admitted+record("one",100));
  const replay={...options,onAdmission:(fact:{turnId:string;inputId:string})=>{ledger.recordAdmission({threadId:"thread",turnId:fact.turnId},fact.inputId);},onCommitCursor:(cursor:number)=>ledger.advanceRollout("thread",options.path,String(cursor))};
  state.database.exec("CREATE TEMP TRIGGER cursor_fault BEFORE UPDATE ON token_usage_rollouts BEGIN SELECT RAISE(ABORT,'cursor failure'); END");
  await assert.rejects(replayRolloutUsage(replay),/cursor failure/);
  assert.equal(ledger.rollout("thread")?.cursor,"0");
  assert.equal(ledger.readTurn(key)?.observedTokens,null);
  assert.equal(state.database.prepare("SELECT COUNT(*) AS n FROM token_usage_admissions").get()!.n,0);
  state.database.exec("DROP TRIGGER cursor_fault");
  assert.equal((await replayRolloutUsage(replay)).changed,1);
  assert.deepEqual(ledger.readAllocations(key).map(row=>row.tokens),["50","50"]);
}));
