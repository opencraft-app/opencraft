import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket,{WebSocketServer} from 'ws';
import {CodexNativeCoreTransport} from '../../apps/opencraft-daemon/src/codex-native-core-transport';
import { startOrchestrationCallbackRelay } from '../../apps/codex-core/src/orchestration-callback-lane';
async function until(condition:()=>boolean) {const deadline=Date.now()+3000;while(!condition()){if(Date.now()>deadline)throw Error('Timed out');await delay(5);}}
async function fixture(t:any,windowMs=1000) {
 const root=await mkdtemp(join(tmpdir(),'oc-callback-')),nativePath=join(root,'native.sock'),proxy=join(root,'gateway.sock');
 const http=createServer(),wss=new WebSocketServer({server:http});
 await new Promise<void>(resolve=>http.listen(nativePath,resolve));
 const nativeSockets:WebSocket[]=[],requests:any[]=[];
 wss.on('connection',socket=>{nativeSockets.push(socket);socket.on('message',frame=>{const message=JSON.parse(String(frame));requests.push(message);if(message.method==='initialize')socket.send(JSON.stringify({id:message.id,result:{userAgent:'fixture'}}));});});
 const relay=await startOrchestrationCallbackRelay(proxy,nativePath,{disconnectWindowMs:windowMs});
 const gateways:WebSocket[]=[];
 t.after(async()=>{for(const socket of gateways)socket.terminate();await relay.close();for(const socket of nativeSockets)socket.terminate();wss.close();await new Promise<void>(resolve=>http.close(()=>resolve()));await rm(root,{recursive:true,force:true});});
 async function connect(lane='gateway') {
  const socket=new WebSocket(`ws+unix://${proxy}:/?opencraftLane=${lane}`),messages:any[]=[];
  gateways.push(socket);socket.on('message',frame=>messages.push(JSON.parse(String(frame))));
  await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
  socket.send(JSON.stringify({id:'init',method:'initialize',params:{clientInfo:{name:'gateway'},capabilities:{experimentalApi:true}}}));
  await until(()=>messages.some(m=>m.id==='init'));socket.send(JSON.stringify({method:'initialized'}));
  return {socket,messages,send(value:unknown){socket.send(JSON.stringify(value));}};
 }
 return {relay,nativeSockets,requests,connect,proxy};
}
const callback={id:'native-call',method:'item/tool/call',params:{threadId:'child',turnId:'turn',callId:'call',tool:'thread_tell',arguments:{threadId:'parent',message:'Done'}}};
test('gateway disconnect retains the real native connection and replays a tool once with its stable identity',async t=>{
 const f=await fixture(t),first=await f.connect();await until(()=>f.requests.some(m=>m.method==='initialized'));
 f.nativeSockets[0]!.send(JSON.stringify(callback));await until(()=>first.messages.some(m=>m.id===callback.id));
 assert.equal(f.relay.pendingCallbacks,1);first.socket.terminate();await until(()=>first.socket.readyState===WebSocket.CLOSED);
 const next=await f.connect();await until(()=>next.messages.some(m=>m.id===callback.id));const replay=next.messages.find(m=>m.id===callback.id);
 assert.equal(replay.__opencraftToolCallKey,`${replay.__opencraftCallbackIncarnation}:child:turn:call`);assert.equal(replay.__opencraftToolCallKey,first.messages.find(m=>m.id===callback.id).__opencraftToolCallKey);assert.equal(f.nativeSockets.length,1);assert.equal(f.requests.filter(m=>m.method==='initialize').length,1);
 const answer={id:replay.id,__opencraftCallbackIncarnation:replay.__opencraftCallbackIncarnation,__opencraftToolCallKey:replay.__opencraftToolCallKey,result:{success:true,contentItems:[]}};
 next.send({...answer,__opencraftCallbackIncarnation:'old-incarnation'});await delay(15);assert.equal(f.requests.filter(m=>m.id===callback.id).length,0);
 next.send(answer);next.send(answer);await until(()=>f.requests.some(m=>m.id===callback.id));assert.equal(f.requests.filter(m=>m.id===callback.id).length,1);assert.equal(f.relay.pendingCallbacks,0);
 f.nativeSockets[0]!.send(JSON.stringify({method:'serverRequest/resolved',params:{requestId:callback.id}}));
 f.nativeSockets[0]!.send(JSON.stringify({method:'turn/completed',params:{threadId:'child',turn:{id:'turn',status:'completed'}}}));
 await until(()=>next.messages.some(m=>m.method==='turn/completed'));assert.equal(next.messages.filter(m=>m.method==='item/tool/call').length,1);
});
test('lost spawn acknowledgement replays only its confirmed native result and rejects argument reuse',async t=>{
 const f=await fixture(t),first=await f.connect(),spawn={method:'thread/start',params:{cwd:'/workspace',__opencraftOrchestrationOperation:'operation'}};
 first.send({id:'start-before',...spawn});await until(()=>f.requests.some(m=>m.method==='thread/start'));const native=f.requests.find(m=>m.method==='thread/start');assert.equal(native.params.__opencraftOrchestrationOperation,undefined);
 first.socket.terminate();await until(()=>first.socket.readyState===WebSocket.CLOSED);f.nativeSockets[0]!.send(JSON.stringify({id:native.id,result:{thread:{id:'only-child'}}}));
 const next=await f.connect();next.send({id:'start-replay',...spawn});await until(()=>next.messages.some(m=>m.id==='start-replay'));
 assert.equal(next.messages.find(m=>m.id==='start-replay').result.thread.id,'only-child');assert.equal(f.requests.filter(m=>m.method==='thread/start').length,1);
 next.send({id:'conflict',method:'thread/start',params:{...spawn.params,cwd:'/another'}});await until(()=>next.messages.some(m=>m.id==='conflict'));assert.ok(next.messages.find(m=>m.id==='conflict').error);
 next.send({id:'ack',method:'opencraft/orchestration/ack',params:{operationId:'operation'}});await until(()=>next.messages.some(m=>m.id==='ack'));assert.equal(next.messages.find(m=>m.id==='ack').result.acknowledged,true);
});
test('a callback arriving while detached waits for reconnect, then exhausts one bounded window',async t=>{
 const f=await fixture(t,40),first=await f.connect();await until(()=>f.requests.some(m=>m.method==='initialized'));first.socket.terminate();await until(()=>first.socket.readyState===WebSocket.CLOSED);await delay(10);
 f.nativeSockets[0]!.send(JSON.stringify(callback));await until(()=>f.requests.some(m=>m.id===callback.id));const answers=f.requests.filter(m=>m.id===callback.id);
 assert.equal(answers.length,1);assert.equal(answers[0].result.success,false);assert.equal(f.nativeSockets.length,1);
});


test('native callbacks retain their admitted delegation through gateway replay and a later human steer',async t=>{
 const f=await fixture(t),first=await f.connect();
 first.send({id:'turn-start',method:'turn/start',params:{threadId:'child',input:[],__opencraftDelegationId:'delegation-A'}});
 await until(()=>f.requests.some(m=>m.method==='turn/start'));
 assert.equal(f.requests.find(m=>m.method==='turn/start').params.__opencraftDelegationId,undefined);
 f.nativeSockets[0]!.send(JSON.stringify({method:'turn/started',params:{threadId:'child',turn:{id:'turn'}}}));
 f.nativeSockets[0]!.send(JSON.stringify(callback));await until(()=>first.messages.some(m=>m.id===callback.id));
 assert.equal(first.messages.find(m=>m.id===callback.id).__opencraftDelegationId,'delegation-A');
 first.socket.terminate();await until(()=>first.socket.readyState===WebSocket.CLOSED);const next=await f.connect();
 await until(()=>next.messages.some(m=>m.id===callback.id));assert.equal(next.messages.find(m=>m.id===callback.id).__opencraftDelegationId,'delegation-A');
 next.send({id:'steer',method:'turn/steer',params:{threadId:'child',expectedTurnId:'turn',input:[],__opencraftDelegationId:'delegation-B'}});
 await until(()=>f.requests.some(m=>m.method==='turn/steer'));const steer=f.requests.find(m=>m.method==='turn/steer');
 f.nativeSockets[0]!.send(JSON.stringify({id:steer.id,result:{turnId:'turn'}}));await until(()=>next.messages.some(m=>m.id==='steer'));
 f.nativeSockets[0]!.send(JSON.stringify({...callback,id:'next-call',params:{...callback.params,callId:'next'}}));await until(()=>next.messages.some(m=>m.id==='next-call'));
 assert.equal(next.messages.find(m=>m.id==='next-call').__opencraftDelegationId,'delegation-B');
 f.nativeSockets[0]!.send(JSON.stringify({method:'turn/completed',params:{threadId:'child',turn:{id:'turn',status:'completed'}}}));
 await until(()=>f.relay.pendingCallbacks===0);
});

test('a replacement Engine Host refuses an old prepared creation identity before Native admission',async t=>{
 const f=await fixture(t),gateway=await f.connect();gateway.send({id:'old',method:'thread/start',params:{cwd:'/workspace',__opencraftOrchestrationOperation:'old-operation',__opencraftOrchestrationIncarnation:'replaced-host'}});
 await until(()=>gateway.messages.some(m=>m.id==='old'));assert.match(gateway.messages.find(m=>m.id==='old').error.message,/unconfirmed/);assert.equal(f.requests.filter(m=>m.method==='thread/start').length,0);
 gateway.send({id:'current',method:'thread/start',params:{cwd:'/workspace',__opencraftOrchestrationOperation:'current-operation',__opencraftOrchestrationIncarnation:f.relay.incarnation}});
 await until(()=>f.requests.some(m=>m.method==='thread/start'));assert.equal(f.requests.find(m=>m.method==='thread/start').params.__opencraftOrchestrationIncarnation,undefined);
});


test('a routing epoch alone cannot advertise orchestration, while the new facade can attach under a legacy default',async t=>{
 const f=await fixture(t);
 for(const scenario of [{version:undefined,callback:1},{version:1,callback:undefined}]){
  const transport=new CodexNativeCoreTransport('/unused/core.sock','synthetic-token',`capability-${scenario.version??0}`);
  transport.control.health=async()=>({protocolVersion:1,pid:1,codexPid:2,nativeSocket:f.proxy,routingEpoch:'routing',...(scenario.callback?{callbackProtocolVersion:1 as const,pendingCallbacks:0,pendingOrchestrationMutations:0}:{}),...(scenario.version?{orchestrationRoutingVersion:1 as const}:{})});
  await transport.connect();assert.equal(transport.supportsOrchestration,false);assert.equal(transport.supportsOrchestrationRouting,scenario.version===1);await transport.close();
 }
});

test('all human waits arriving detached replay, retain submitted state and retire only on native confirmation',async t=>{
 const f=await fixture(t,30),first=await f.connect();await until(()=>f.requests.some(m=>m.method==='initialized'));
 first.socket.terminate();await until(()=>first.socket.readyState===WebSocket.CLOSED);await delay(10);
 const methods=['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','item/tool/requestUserInput','mcpServer/elicitation/request'];
 for(const [id,method] of methods.entries())f.nativeSockets[0]!.send(JSON.stringify({id,method,params:{threadId:'thread',turnId:'turn',itemId:`item-${id}`}}));
 await delay(60);assert.equal(f.requests.filter(m=>!m.method&&typeof m.id==='number').length,0,'human waits cannot time out into an automatic answer');
 const next=await f.connect();await until(()=>next.messages.filter(m=>methods.includes(m.method)).length===5);
 const requests=next.messages.filter(m=>methods.includes(m.method));
 assert.equal(new Set(requests.map(m=>m.__opencraftInteractionKey)).size,5);assert.ok(requests.every(m=>m.__opencraftInteractionState==='pending'));
 next.send({id:0,result:{decision:'accept'}});next.send({id:0,result:{decision:'decline'}});await until(()=>f.requests.some(m=>m.id===0));
 next.socket.terminate();await until(()=>next.socket.readyState===WebSocket.CLOSED);await delay(10);
 const last=await f.connect();await until(()=>last.messages.filter(m=>methods.includes(m.method)).length===5);
 const submitted=last.messages.find(m=>m.method===methods[0]);assert.equal(submitted.__opencraftInteractionKey,requests[0].__opencraftInteractionKey);assert.equal(submitted.__opencraftInteractionState,'responding');
 assert.equal(f.requests.filter(m=>m.id===0).length,1);assert.equal(f.nativeSockets.length,1);
 f.nativeSockets[0]!.send(JSON.stringify({method:'serverRequest/resolved',params:{threadId:'thread',requestId:0}}));
 f.nativeSockets[0]!.send(JSON.stringify({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}}));
 await until(()=>last.messages.some(m=>m.method==='turn/completed'));last.socket.terminate();await until(()=>last.socket.readyState===WebSocket.CLOSED);await delay(10);
 const settled=await f.connect();settled.send({id:'barrier',method:'fixture/barrier',params:{}});await until(()=>f.requests.some(m=>m.method==='fixture/barrier'));
 assert.equal(settled.messages.filter(m=>methods.includes(m.method)).length,0);
});
