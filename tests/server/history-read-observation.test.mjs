import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeEvent} from '../../packages/observability-contract/index.mjs';
test('history timings survive ingestion without accepting payload or invalid durations', () => {
  const event = {schemaVersion:1,eventId:'event',producerId:'producer',kind:'rpc',component:'web',at:100,
    pairId:'opaque-read',operationId:'opaque-open',webSentAt:1,clientQueueMs:2,historyCoreMs:3,
    historyReadSource:'attention',bytes:100,historyDecodeMs:1,historyMetadataMs:4,historyQueueMs:5,historySourceMs:6,historyReconcileMs:7,historyScanMs:8,
    historyPageMs:9,historyProjectionMs:10,historyNativeRpcMs:11,historyNativeRpcCount:2};
  const sanitized = sanitizeEvent({...event,threadId:'private-thread',params:{secret:'private'}},100);
  for (const [key,value] of Object.entries(event)) assert.equal(sanitized[key],value,key);
  assert(!JSON.stringify(sanitized).includes('private'));
  for (const value of [-1,NaN,Infinity,'100']) assert.equal(sanitizeEvent({...event,historyQueueMs:value},100),null);
});

test('causality fields survive sanitization while invalid trace IDs reject only their record',()=>{
 const base={schemaVersion:1,eventId:'event',producerId:'producer',kind:'rpc',component:'gateway',at:100,
 traceId:'1'.repeat(32),spanId:'2'.repeat(16),parentSpanId:'3'.repeat(16),caller:'sidebar-catalog',trigger:'auto-next-page',traceRole:'gateway-rpc',
 directoryCache:'miss',directoryMode:'recover',directoryStart:'head',directoryCheckpoint:'absent',directoryMissReason:'unsynchronized-tail',
 directoryPriorState:'observed',directoryState:'partial',directoryImportPage:'head',directoryPages:7,directoryStop:'cache-satisfied',pageIndex:3,attempt:1};
 assert.deepEqual(sanitizeEvent({...base,cursor:'private',queryKey:'private'},100),{...base,originClass:'unknown',actorKind:'unknown'});
 for(const bad of [{traceId:'0'.repeat(32)},{spanId:'bad'},{trigger:'private'},{directoryMissReason:'private'}]) assert.equal(sanitizeEvent({...base,...bad},100),null);
});
