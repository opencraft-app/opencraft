import test from "node:test";
import assert from "node:assert/strict";
import { createRoutedConversationExecution } from "../../apps/headless-server/src/conversation-execution.mjs";

test("routed Codex receipt forwards completion opt-in on its existing trusted Actor lane",async()=>{
  const methods:any[]=[];
  const appHost={accept(port:any,_client:string,context:any,trusted:boolean){
    assert.equal(context.collaborationRequestId,"request");assert.equal(trusted,true);
    port.subscribe((message:any)=>{
      if(message.type==="hello") port.postMessage({type:"ready"});
      if(message.type==="host/connect") port.postMessage({type:"response",requestId:"connect",ok:true,result:{generation:1}});
      if(message.type==="host/send"){
        const frame=JSON.parse(message.frame);
        if(frame.method!=="initialize") methods.push(frame);
        port.postMessage({type:"host/frame",hostId:message.hostId,generation:1,frame:JSON.stringify({id:frame.id,result:frame.method==="initialize"?{}:{receipt:{id:"queue",state:"delivered",targetTurnId:"turn"}}})});
      }
    });return {close(){}};
  }};
  const execution=createRoutedConversationExecution(()=>appHost,{machineId:"fixture",engines:[],getInputs:async()=>null});
  const binding={actorId:"owner",hostId:"local-codex",threadId:"thread",serverId:"server:fixture:codex",epoch:1};
  await execution.receipt(binding,"request");await execution.receipt(binding,"request",{includeCompletion:true});
  assert.equal(methods[0].method,"thread/queue/collaborationReceipt");
  assert.deepEqual(methods[0].params,{threadId:"thread"});
  assert.deepEqual(methods[1].params,{includeCompletion:true,threadId:"thread"});
});
