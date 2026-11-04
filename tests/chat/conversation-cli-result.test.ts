import assert from 'node:assert/strict';
import test from 'node:test';
import { resultTarget, resultTimeout, waitForResult } from '../../apps/opencraft-cli/src/result';
import { CollaborationClient } from '../../packages/appserver-client/src/collaboration';
import { MemoryTransport } from '@opencraft/appserver-transport-memory';
const ref={serverId:'s',threadId:'t'};
test('exact CLI selectors are exclusive and waits never consult metadata, pump or send',async()=>{
 for(const values of [[],[''],['r','k'],[undefined,undefined,'  ']] as (string|undefined)[][])assert.throws(()=>resultTarget(...values));
 assert.deepEqual(resultTarget(undefined,'k'),{operationKey:'k'});assert.equal(resultTimeout('200ms'),200);assert.throws(()=>resultTimeout('2h'));
 const states=[{matched:false,turnId:null},{matched:false,turnId:'A',turnState:'inProgress'},{matched:true,turnId:'A',turnState:'failed'}];let reads=0;
 const client={async exactResult(r:unknown,t:unknown,output:unknown){assert.deepEqual(r,ref);assert.deepEqual(t,{requestId:'request-A'});assert.equal(output,false);return states[reads++];}};
 const result=await waitForResult(client as any,ref,{requestId:'request-A'},1500);assert.equal(result.turnId,'A');assert.equal(result.turnState,'failed');assert.equal(reads,3);
 await assert.rejects(waitForResult({exactResult:async()=>({matched:false,turnId:null})} as any,ref,{operationKey:'unknown'},10),{exitCode:7});
});
test('old Host capability rejects exact result before any read',async()=>{
 const methods:string[]=[];
 const transport=new MemoryTransport({server:{receive(frame,peer){const m=JSON.parse(frame);if(m.id===undefined)return;methods.push(m.method);if(m.method==='initialize')peer.send(JSON.stringify({id:m.id,result:{capabilities:{extensions:{'opencraft/collaboration':{version:1,read:true}}}}}));}}});
 const client=new CollaborationClient(transport);try{await client.connect();await assert.rejects(client.exactResult(ref,{turnId:'A'},true),{code:'UNSUPPORTED_CAPABILITY'});assert.deepEqual(methods,['initialize']);}finally{await client.close();}
});

test('read unavailability retains its category and wait polls only the read until terminal or timeout',async()=>{
 const fault={data:{code:'history_read_unavailable',status:503}};
 const {classify}=await import('../../apps/opencraft-cli/src/errors');
 assert.equal(classify(fault).code,'HISTORY_READ_UNAVAILABLE');
 let calls=0;const client={async exactResult(){calls++;if(calls===1)throw fault;return {matched:true,turnId:'original',turnState:'completed'};}};
 assert.equal((await waitForResult(client as any,ref,{requestId:'original-request'},1000)).turnId,'original');assert.equal(calls,2);
 await assert.rejects(waitForResult({exactResult:async()=>{throw fault;}} as any,ref,{requestId:'original-request'},20),{code:'TIMEOUT',exitCode:7});
});

test('the internal exact read port preserves unavailable and genuine missing-method categories',async()=>{
 const {callConversationHost}=await import('../../scripts/conversation-execution.mjs');
 for(const [failure,expected] of [[{code:-32073,data:{code:'HISTORY_READ_UNAVAILABLE'}},{status:503,code:'history_read_unavailable'}],[{code:-32601},{status:409,code:'unsupported_capability'}]] as const){
  const host={accept(port:any){port.subscribe((packet:any)=>{
   if(packet.type==='hello')port.postMessage({type:'ready'});
   if(packet.type==='host/connect')port.postMessage({type:'response',requestId:'connect',ok:true,result:{generation:1}});
   if(packet.type==='host/send'){
    const frame=JSON.parse(packet.frame);
    port.postMessage({type:'host/frame',hostId:'h',generation:1,frame:JSON.stringify({id:frame.id,...(frame.method==='initialize'?{result:{capabilities:{extensions:{'opencraft/read-history':{exactResult:true}}}}}:{error:failure})})});
   }
  });return {close(){}};}};
  await assert.rejects(callConversationHost(host,{hostId:'h',threadId:'t'},'read','opencraft/turn-result/read',{turnId:'A',output:true,cursor:null}),expected);
 }
});

test('outer exact-read deadline is read-unavailable rather than an uncertain write',async()=>{
 const {callConversationHost}=await import('../../scripts/conversation-execution.mjs');
 const host={accept(port:any){port.subscribe((packet:any)=>{if(packet.type==='hello')port.postMessage({type:'ready'});if(packet.type==='host/connect')port.postMessage({type:'response',requestId:'connect',ok:true,result:{generation:1}});if(packet.type==='host/send'){const m=JSON.parse(packet.frame);if(m.method==='initialize')port.postMessage({type:'host/frame',hostId:'h',generation:1,frame:JSON.stringify({id:m.id,result:{capabilities:{extensions:{'opencraft/read-history':{exactResult:true}}}}})});}});return{close(){}};}};
 const alive=setTimeout(()=>{},1000);
 try{await assert.rejects(callConversationHost(host,{hostId:'h',threadId:'t'},'read','opencraft/turn-result/read',{turnId:'A',output:true,cursor:null},undefined,15),{status:503,code:'history_read_unavailable'});}finally{clearTimeout(alive);}
});
