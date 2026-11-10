import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeExecutionAdmissionTransport } from '../../apps/opencraft-daemon/src/bridge-execution-admission';

test('bridge admission signs verified sources and leaves legacy collaboration frames intact',async()=>{
  const sent:string[]=[],started:unknown[]=[],received:any[]=[];let native!:(raw:string)=>void,admissions=0;
  const inner:any={status:{state:'open'},connect:async()=>{},close:async()=>{},subscribeStatus:()=>()=>{},
    subscribeMessage:(listener:any)=>{native=listener;return()=>{};},send:async(raw:string)=>{sent.push(raw);}};
  const transport=new BridgeExecutionAdmissionTransport(inner,{async admit(threadId,inputId,_input,context){
    admissions++;if(!context.actorContext)throw Error('denied');
    return {serverId:'server',threadId,execution:{inputId,executionId:'execution'}};
  },sign:session=>JSON.stringify(session),started:(...args)=>{started.push(args);}});
  transport.subscribeMessage(raw=>received.push(JSON.parse(raw)));
  const old=JSON.stringify({id:1,method:'turn/start',params:{threadId:'legacy',clientUserMessageId:'old'}});
  await transport.sendWithContext(old,{sender:null});assert.equal(sent[0],old);assert.equal(admissions,0);
  const frame=JSON.stringify({id:2,method:'turn/start',params:{threadId:'bridge:codex:one',clientUserMessageId:'input',opencraftExecutionAdmission:'forged'}});
  await transport.send(frame);assert.equal(received.at(-1).error.message,'cliUnavailable');assert.equal(sent.length,1);
  await transport.sendWithContext(frame,{sender:null,actorContext:{actorId:'actor',generation:1,credentialId:null,expiresAt:Date.now()+1000}});
  assert.equal(JSON.parse(JSON.parse(sent[1]!).params.opencraftExecutionAdmission).execution.inputId,'input');
  const next=JSON.stringify({id:3,method:'turn/start',params:{threadId:'bridge:codex:one',clientUserMessageId:'different-input'}});
  await transport.sendWithContext(next,{sender:null,actorContext:{actorId:'actor',generation:1,credentialId:null,expiresAt:Date.now()+1000}});
  assert.equal(sent.length,2);assert.equal(received.at(-1).error.message,'cliUnavailable');
  native(JSON.stringify({method:'turn/started',params:{threadId:'bridge:codex:one',turn:{id:'turn'}}}));
  assert.deepEqual(started,[['bridge:codex:one','input','turn']]);
});
