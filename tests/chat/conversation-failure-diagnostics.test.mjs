import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationFailureDiagnostics, conversationFailure } from '../../packages/access-control/src/conversation-failure-diagnostics.mjs';
import { callConversationHost } from '../../apps/headless-server/src/conversation-execution.mjs';
const binding = {hostId:'local-codex',threadId:'recipient'};

test('delivery diagnostics redact arbitrary engine text and bound unchanged errors', () => {
 let now=0;const logs=[];const diagnostics=new ConversationFailureDiagnostics(()=>now,record=>logs.push(record));
 const error=Object.assign(Error('Bearer private-token /private/user/path'),{code:-32000,password:'secret'});
 for(let i=0;i<100;i++)diagnostics.report('request',binding,'receipt',error);
 assert.equal(logs.length,1);assert.equal(logs[0].rpcCode,-32000);assert.equal(logs[0].reason,'unclassified');
 assert.doesNotMatch(JSON.stringify(logs),/Bearer|private-token|password|secret|user.path/);
 now=30000;diagnostics.report('request',binding,'receipt',error);assert.equal(logs.length,2);assert.equal(logs[1].suppressed,99);
 diagnostics.report('request',binding,'add',error);assert.equal(logs.length,3);
 diagnostics.report('request',binding,'receipt',Object.assign(Error(),{code:403}));assert.equal(logs.length,4);
 assert.doesNotThrow(()=>new ConversationFailureDiagnostics(()=>0,()=>{throw Error('sink');}).report('r',binding,'receipt',error));
});

test('only allowlisted engine reasons and numeric codes survive diagnostic envelopes',()=>{
 assert.equal(conversationFailure({code:-32600},'request','Trusted Actor admission required').reason,'trusted_admission_required');
 assert.equal(conversationFailure({code:'credential-secret',status:'token'},'secret','credential-secret').rpcCode,null);
 assert.deepEqual(conversationFailure(Error('Host queue is unavailable'),'initialize'),{transportStage:'initialize',rpcCode:null,status:null,reason:'queue_unavailable'});
});

function fakeHost(failAt, failure = {code:-32600,message:'Trusted Actor admission required'}) {
 return {accept(port) {
   let receive;port.subscribe(message=>{receive=message;queueMicrotask(()=>{
     if(message.type==='hello')port.postMessage({type:'ready'});
     if(message.type==='host/connect')port.postMessage({type:'response',requestId:'connect',ok:failAt!=='connect',result:{generation:1}});
     if(message.type==='host/send'){
       const frame=JSON.parse(message.frame),failed=frame.id===failAt;
       port.postMessage({type:'host/frame',hostId:binding.hostId,generation:1,frame:JSON.stringify({id:frame.id,...(failed?{error:failure}:{result:{receipt:null}})})});
     }
   });});
   return {close(){receive=undefined;}};
 }};
}
test('Host receipt failures retain correlation stage and safe engine reason without changing rejection',async()=>{
 for(const [failure,stage] of [['connect','connect'],['init','initialize'],['operation','request']]){
  await assert.rejects(callConversationHost(fakeHost(failure),binding,'request','thread/queue/collaborationReceipt',{}),error=>{
    assert.equal(error.conversationDiagnostic.transportStage,stage);
    assert.equal(error.conversationDiagnostic.reason,failure==='connect'?'host_unavailable':'trusted_admission_required');return true;
  });
 }
 assert.deepEqual(await callConversationHost(fakeHost('none'),binding,'request','thread/queue/collaborationReceipt',{}),{receipt:null});
});


test('oversized history is a typed read failure without leaking provider error data',async()=>{
 const failure={code:-32072,message:'private content',data:{code:'HISTORY_RESPONSE_TOO_LARGE',retryable:false,secret:'private'}};
 for(const method of ['thread/read','thread/items/list','thread/turns/list']) {
  await assert.rejects(callConversationHost(fakeHost('operation',failure),binding,'read',method,{}),error=>{
   assert.equal(error.code,'HISTORY_RESPONSE_TOO_LARGE');assert.equal(error.status,413);assert.equal(error.retryable,false);
   assert.doesNotMatch(JSON.stringify(error),/private/);return true;
  });
 }
 await assert.rejects(callConversationHost(fakeHost('operation',failure),binding,'create','opencraft/orchestration/create',{}),error=>{
  assert.equal(error.status,undefined);assert.equal(error.code,-32072);return true;
 });
});
