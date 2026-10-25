import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChaosViolation, shrinkChaosFailure } from "./fixtures/recovery-chaos";
import { generateHistoryChaos, parseHistoryTrace, simulateHistoryRecovery, type HistoryChaosEvent } from "./fixtures/history-recovery-chaos";

const queuedDisposal:HistoryChaosEvent[]=[{type:"observe",resource:0,at:"queued",action:"dispose"},{type:"recover",resource:0}];
for(const at of ["resources","queued","history","history-started"] as const)test(`history chaos: disposal from ${at} settles callers without I/O`,async()=>{
 const result=await simulateHistoryRecovery([{type:"observe",resource:0,at,action:"dispose"},{type:"recover",resource:0}]);
 assert.equal(result.historyRuns,0);assert.equal(result.coverage[`observer-${at}-dispose`],1);
});
test("history chaos: remove before I/O, replace during commit and retry during backoff",async()=>{
 await simulateHistoryRecovery([{type:"observe",resource:0,at:"history",action:"remove"},{type:"recover",resource:0}]);
 const replaced=await simulateHistoryRecovery([
  {type:"observe",resource:0,at:"history-authoritative",action:"replace"},{type:"recover",resource:0},{type:"reply",resource:0,outcome:"success"},
 ]);
 assert.equal(replaced.historyRuns,2);
 const retry=await simulateHistoryRecovery([
  {type:"observe",resource:0,at:"backoff",action:"retry"},{type:"recover",resource:0},{type:"reply",resource:0,outcome:"retry"},
 ]);
 assert.equal(retry.historyRuns,2);assert.equal(retry.coverage["observer-backoff-retry"],1);
});
test("history chaos: invalidation cannot clear a reentrant successor reservation",async()=>{
 const result=await simulateHistoryRecovery([
  {type:"observe",resource:0,at:"invalidated",action:"replace"},{type:"invalidate"},{type:"recover",resource:0},
 ]);
 assert.equal(result.historyRuns,1);
});
test("history chaos: unrelated observations cannot masquerade as an invalidation boundary",async()=>{
 const result=await simulateHistoryRecovery([
  {type:"observe",resource:1,at:"invalidated",action:"dispose"},{type:"recover",resource:0},
  {type:"invalidate"},{type:"recover",resource:0},
 ]);
 assert.equal(result.historyRuns,1);assert.equal(result.coverage["observer-invalidated-dispose"],1);
});
test("history chaos: retry triggered by a peer's backoff still shares the target's live read",async()=>{
 await simulateHistoryRecovery([
  {type:"demand",resource:1,value:"visible"},{type:"retry",resource:0},
  {type:"observe",resource:1,at:"history-backoff",action:"retry"},{type:"recover",resource:1},
  {type:"reply",resource:0,outcome:"retry",oldest:false},
 ]);
});
for(const at of ["history-failed","failed","backoff","history-backoff"] as const)test(`history chaos: explicit retry from ${at} has no inherited delay`,async()=>{
 await simulateHistoryRecovery([
  {type:"observe",resource:0,at,action:"retry"},{type:"recover",resource:0},{type:"reply",resource:0,outcome:"retry"},
 ]);
});
test("history chaos: failed active read retains one coalesced explicit retry",async()=>{
 const result=await simulateHistoryRecovery([{type:"recover",resource:0},{type:"retry",resource:0},{type:"reply",resource:0,outcome:"terminal"}]);
 assert.equal(result.historyRuns,2);assert.equal(result.coverage["shared-read-retry-after-failure"],1);
});
test("history chaos: a removed physical read cannot hold a successor's logical admission",async()=>{
 await simulateHistoryRecovery([
  {type:"demand",resource:1,value:"visible"},{type:"observe",resource:1,at:"history-failed",action:"retry"},
  {type:"recover",resource:1},{type:"retry",resource:0},{type:"remove",resource:1},{type:"reply",resource:0,outcome:"terminal",oldest:false},
 ]);
});
test("history chaos: removal from a failure observer revokes the retained retry obligation",async()=>{
 const result=await simulateHistoryRecovery([
  {type:"observe",resource:0,at:"history-failed",action:"remove"},{type:"recover",resource:0},
  {type:"retry",resource:0},{type:"reply",resource:0,outcome:"terminal",oldest:true},
 ]);
 assert.equal(result.historyRuns,1);
});
for(const seed of [0,1,2,7,19,42,88,512,1024,20261026])test(`history chaos: deterministic seed ${seed}`,async()=>{
 await simulateHistoryRecovery(generateHistoryChaos(seed));
});
test("history chaos: schema validates observer points and concrete reply choices",()=>{
 assert.deepEqual(generateHistoryChaos(42),generateHistoryChaos(42));
 assert.deepEqual(parseHistoryTrace(JSON.parse(JSON.stringify(queuedDisposal))),queuedDisposal);
 for(const event of [{type:"recover",resource:2},{type:"observe",resource:0,at:"unknown",action:"remove"},{type:"reply",resource:0,outcome:"success",oldest:"yes"},{type:"tick",ms:-1}])
  assert.throws(()=>parseHistoryTrace([event]),/TRACE_SCHEMA/);
});
test("history chaos: lost admission is detected, shrunk and replayed without losing its primary rule",async()=>{
 const trace:HistoryChaosEvent[]=[{type:"tick",ms:1},...queuedDisposal,{type:"tick",ms:2}];
 const run=(events:readonly HistoryChaosEvent[])=>simulateHistoryRecovery(events,{mutant:"lost-admission"});
 await assert.rejects(run(trace),error=>error instanceof ChaosViolation && error.rule==="HISTORY_SETTLEMENT");
 const minimal=await shrinkChaosFailure(trace,"HISTORY_SETTLEMENT",run);
 assert.ok(minimal.length<trace.length);
 await assert.rejects(run(minimal),error=>error instanceof ChaosViolation && error.rule==="HISTORY_SETTLEMENT");
 await simulateHistoryRecovery(minimal);
});
test("history CLI: artifact selects its suite, preserves seed zero and rejects a conflicting override",async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),"history-chaos-"));
 const cwd=fileURLToPath(new URL("../../",import.meta.url));
 try {
  const trace=path.join(directory,"trace.json"),output=path.join(directory,"output");
  await writeFile(trace,JSON.stringify({suite:"history",seed:0,events:queuedDisposal}));
  const command=["--import","tsx","scripts/recovery-chaos.ts","--replay",trace,"--output",output];
  execFileSync(process.execPath,command,{cwd,stdio:"pipe",timeout:10_000});
  const result=JSON.parse(await readFile(path.join(output,"results.json"),"utf8"));
  assert.equal(result.suite,"history");assert.equal(result.seed,0);assert.equal(result.passed,true);
  assert.ok(result.sourceSha256["packages/workbench-runtime/src/recovery-policy.ts"]);
  assert.throws(()=>execFileSync(process.execPath,[...command,"--suite","host"],{cwd,stdio:"pipe",timeout:10_000}));
 }finally{await rm(directory,{recursive:true,force:true});}
});
