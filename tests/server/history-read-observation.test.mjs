import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeEvent} from '../../packages/observability-contract/index.mjs';
test('history timings survive ingestion without accepting payload or invalid durations', () => {
  const event = {schemaVersion:1,eventId:'event',producerId:'producer',kind:'rpc',component:'web',at:100,
    pairId:'opaque-read',operationId:'opaque-open',webSentAt:1,clientQueueMs:2,historyCoreMs:3,
    historyMetadataMs:4,historyQueueMs:5,historySourceMs:6,historyReconcileMs:7,historyScanMs:8,
    historyPageMs:9,historyProjectionMs:10,historyNativeRpcMs:11,historyNativeRpcCount:2};
  const sanitized = sanitizeEvent({...event,threadId:'private-thread',params:{secret:'private'}},100);
  for (const [key,value] of Object.entries(event)) assert.equal(sanitized[key],value,key);
  assert(!JSON.stringify(sanitized).includes('private'));
  for (const value of [-1,NaN,Infinity,'100']) assert.equal(sanitizeEvent({...event,historyQueueMs:value},100),null);
});
