import assert from 'node:assert/strict';
import test from 'node:test';
import { reportRecoveryEvent } from '../../apps/workbench-web/src/runtime/recovery-diagnostics';
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('a rejected report cannot block subsequent correlated observations',async context=>{
 const seen:Record<string,unknown>[]=[],logs:unknown[][]=[];
 context.mock.method(console,'log',(...args:unknown[])=>logs.push(args));
 context.mock.method(globalThis,'fetch',async(_input:unknown,init:RequestInit)=>{
  const report=JSON.parse(String(init.body));seen.push(report);
  return new Response('{}',{status:report.stage==='history-started'?400:202});
 });
 reportRecoveryEvent({recoveryId:'recovery-test-1',stage:'history-started',elapsedMs:0,eventAtMs:123,attemptId:'11111111-1111-4111-8111-111111111111',hostId:'private-id',params:'private-body'});
 reportRecoveryEvent({recoveryId:'recovery-test-1',stage:'settled',elapsedMs:10,eventAtMs:133});
 await tick();await tick();
 assert.deepEqual(seen.map(x=>x.stage),['history-started','settled']);
 assert.equal(seen[0].attemptId,'11111111-1111-4111-8111-111111111111');assert.equal(seen[0].eventAtMs,123);
 assert.doesNotMatch(JSON.stringify(seen)+JSON.stringify(logs),/private-id|private-body/);
});
