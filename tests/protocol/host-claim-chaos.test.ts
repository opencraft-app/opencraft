import assert from 'node:assert/strict';
import test from 'node:test';
import { generateClaimChaos, parseClaimTrace, simulateHostClaims, type ClaimEvent } from './fixtures/host-claim-chaos';
import { ChaosViolation, shrinkChaosFailure } from './fixtures/recovery-chaos';
test('claim traces are deterministic, validated, and saved recovery is explicit',()=>{
  assert.deepEqual(generateClaimChaos(42,80),generateClaimChaos(42,80));
  assert.deepEqual(parseClaimTrace(generateClaimChaos(1,8)),generateClaimChaos(1,8));
  for(const e of [[{type:'open',slot:3}],[{type:'setup',lifetime:'unknown',maxPending:1}],[{type:'settle',index:-1,failure:false}]])assert.throws(()=>parseClaimTrace(e));
});
test('empty claim trace admits no physical operation or hidden heal',async()=>{
  const x=await simulateHostClaims([]);assert.equal(x.connectIntents,0);assert.equal(x.heals,0);assert.equal(x.nativeAdmissions,0);
});
test('actual Server and Clients satisfy seeded claim handoff and physical lifetime oracles',async()=>{
  for(let seed=0;seed<20;seed++){
    const x=await simulateHostClaims(generateClaimChaos(seed,100));assert.equal(x.heals,1);assert.ok(x.rpcFrames>0);
  }
});
const setup:ClaimEvent={type:'setup',lifetime:'last-claim',maxPending:1};
for(const [mutant,rule,events] of [
  ['leak-old','CLAIM_REMOTE_RECLAMATION',[setup,{type:'open',slot:0},{type:'cycle'},{type:'open',slot:0},{type:'heal'}]],
  ['retarget-peer','CLAIM_PEER_OWNERSHIP',[setup,{type:'open',slot:0},{type:'open',slot:1},{type:'close',slot:0},{type:'heal'}]],
  ['wait-cleanup-ack','CLAIM_CONNECT_PROGRESS',[setup,{type:'open',slot:0},{type:'withhold-release'},{type:'cycle'},{type:'open',slot:0},{type:'heal'}]],
] as const)test(`claim ${mutant} tool control shrinks with the same rule and normally replays`,async()=>{
  const run=(trace:readonly ClaimEvent[])=>simulateHostClaims(trace,{mutant});
  await assert.rejects(run(events),e=>e instanceof ChaosViolation&&e.rule===rule);
  const minimal=await shrinkChaosFailure<ClaimEvent>(events,rule,run);
  await assert.rejects(run(minimal),e=>e instanceof ChaosViolation&&e.rule===rule);
  await simulateHostClaims(minimal);assert.ok(minimal.length<events.length);
});
