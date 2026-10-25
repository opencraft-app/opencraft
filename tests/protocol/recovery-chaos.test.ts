import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChaosViolation, generateRecoveryChaos, parseRecoveryTrace, shrinkRecoveryFailure, simulateRecovery, type ChaosEvent } from "./fixtures/recovery-chaos";

const cancellation: ChaosEvent[] = [
  {type:"hold",host:"a",boundary:"dial",value:true},
  {type:"network",up:false},
  {type:"freeze",ms:61},
  {type:"connect",host:"a"},
  {type:"network",up:true},
  {type:"late",host:"a"},
  {type:"heal"},
];
test("chaos: reduced cancelled-initialization regression does not wait for held close",async()=>{
  await simulateRecovery([
    {type:"network",up:false},
    {type:"hold",host:"a",boundary:"close",value:true},
    {type:"connect",host:"a"},
  ]);
});
test("chaos: repeated route loss, freeze and queued old events recover through real owners and clients", async () => {
  const events:ChaosEvent[]=[];
  for (let i=0;i<8;i++) events.push(...cancellation);
  const result=await simulateRecovery(events);
  assert.ok(result.ready>=8);
  assert.equal(result.coverage.freeze,8);
});
test("chaos: cancellation remains local while physical close is held", async () => {
  await simulateRecovery([
    {type:"hold",host:"a",boundary:"close",value:true},
    {type:"network",up:false},
    {type:"freeze",ms:61},
    {type:"connect",host:"a"},
    {type:"late",host:"a"},
    {type:"stale-timer"},
    {type:"heal"},
  ]);
});
test("chaos: an open socket waiting for provider handshake cannot overlap its successor during held close", async () => {
  await simulateRecovery([
    {type:"hold",host:"a",boundary:"dial",value:true},
    {type:"network",up:false},{type:"network",up:true},{type:"tick",ms:10},
    {type:"hold",host:"a",boundary:"close",value:true},
    {type:"freeze",ms:61},{type:"connect",host:"a"},
    {type:"late",host:"a"},{type:"heal"},
  ]);
});
test("chaos: manual rejection is sticky and disposal remains terminal under all queued delivery kinds", async () => {
  await simulateRecovery([
    {type:"manual",host:"a"},{type:"hint",host:"a"},{type:"heal"},
    {type:"connect",host:"a"},{type:"heal"},
    {type:"dispose",host:"a"},{type:"network",up:false},{type:"freeze",ms:5_001},
    {type:"late",host:"a"},{type:"stale-timer"},{type:"connect",host:"a"},{type:"heal"},
  ]);
});
for(const seed of [0,1,2,7,19,42,88,512,1024,20261025]) test(`chaos: deterministic seed ${seed}`,async()=>{
  await simulateRecovery(generateRecoveryChaos(seed));
});
test("chaos: generator and replay schema are deterministic and reject invalid time or host inputs",()=>{
  assert.deepEqual(generateRecoveryChaos(42),generateRecoveryChaos(42));
  assert.deepEqual(parseRecoveryTrace(JSON.parse(JSON.stringify(cancellation))),cancellation);
  assert.throws(()=>parseRecoveryTrace([{type:"tick",ms:-1}]),/TRACE_SCHEMA/);
  assert.throws(()=>parseRecoveryTrace([{type:"connect",host:"unknown"}]),/TRACE_SCHEMA/);
  assert.throws(()=>parseRecoveryTrace([{type:"hold",host:"a",boundary:"arbitrary",value:true}]),/TRACE_SCHEMA/);
});
test("chaos CLI: replay reports the artifact seed, including zero, rather than its generator default",async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),"recovery-replay-"));
  try {
    const trace=path.join(directory,"trace.json"),output=path.join(directory,"output");
    await writeFile(trace,JSON.stringify({seed:0,events:[]}));
    execFileSync(process.execPath,["--import","tsx","scripts/recovery-chaos.ts","--replay",trace,"--output",output],{
      cwd:fileURLToPath(new URL("../../",import.meta.url)),stdio:"pipe",timeout:10_000,
    });
    const result=JSON.parse(await readFile(path.join(output,"results.json"),"utf8"));
    assert.equal(result.seed,0);assert.equal(result.cases,1);assert.equal(result.passed,true);
  } finally {await rm(directory,{recursive:true,force:true});}
});
test("chaos: a sticky initialization mutant is detected, shrunk and replayed with the same rule",async()=>{
  const trace=[{type:"hint",host:"b"} as const,...cancellation,{type:"tick",ms:1} as const];
  let rule="";
  try {await simulateRecovery(trace,{mutant:"sticky-initialize"});} catch(error) {
    assert.ok(error instanceof ChaosViolation);rule=error.rule;
  }
  assert.ok(rule,"negative control must not silently pass");
  const minimal=await shrinkRecoveryFailure(trace,rule,{mutant:"sticky-initialize"});
  assert.ok(minimal.length<trace.length);
  await assert.rejects(simulateRecovery(minimal,{mutant:"sticky-initialize"}),error=>error instanceof ChaosViolation && error.rule===rule);
  await simulateRecovery(minimal);
});
