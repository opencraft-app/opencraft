import assert from 'node:assert/strict';
import test from 'node:test';
import {generateCleanupChaos,parseCleanupTrace,simulateHostCleanup,type CleanupEvent} from './fixtures/host-cleanup-chaos';
import {ChaosViolation,shrinkChaosFailure} from './fixtures/recovery-chaos';
test('cleanup traces are deterministic and reject malformed physical outcomes',()=>{
  assert.deepEqual(generateCleanupChaos(8,50),generateCleanupChaos(8,50));assert.deepEqual(parseCleanupTrace(generateCleanupChaos(1,3)),generateCleanupChaos(1,3));
  assert.throws(()=>parseCleanupTrace([{type:'mode',mode:'silent-success'}]));assert.throws(()=>parseCleanupTrace([{type:'setup',path:'unknown',lifetime:'server',mode:'success',detachFailure:false,subscriptionFailure:false}]));
});
test('empty cleanup trace has no resource allocation, RPC or implicit heal',async()=>{const x=await simulateHostCleanup([]);assert.equal(x.cleanupCalls,0);assert.equal(x.connectIntents,0);assert.equal(x.heals,0);});
test('actual Server and Clients satisfy physical cleanup ownership across all three paths',async()=>{
  for(let seed=0;seed<20;seed++){const x=await simulateHostCleanup(generateCleanupChaos(seed,80));assert.ok(x.heals>=1);}
});
for(const [mutant,rule,path,mode] of [
 ['orphan-handle','CLEANUP_HANDLE_CONSERVATION','normal','reject'],
 ['false-shutdown','CLEANUP_OUTCOME','shutdown','reject'],
 ['bypass-barrier','CLEANUP_PHYSICAL_EXCLUSIVITY','normal','hold'],
] as const)test(`cleanup ${mutant} tool control shrinks and normally replays the same rule`,async()=>{
 const events:CleanupEvent[]=[{type:'setup',path,lifetime:'last-claim',mode,detachFailure:false,subscriptionFailure:false},{type:'open'},{type:'retire'},{type:'observe'},{type:'heal'}];
 const run=(trace:readonly CleanupEvent[])=>simulateHostCleanup(trace,{mutant});
 await assert.rejects(run(events),e=>e instanceof ChaosViolation&&e.rule===rule);
 const minimal=await shrinkChaosFailure(events,rule,run);await assert.rejects(run(minimal),e=>e instanceof ChaosViolation&&e.rule===rule);await simulateHostCleanup(minimal);assert.ok(minimal.length<events.length);
});
