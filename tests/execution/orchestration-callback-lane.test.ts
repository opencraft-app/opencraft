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
import { codexSandboxRequestPolicy } from '../../apps/codex-core/src/execution-sandbox';
async function until(condition:()=>boolean) {const deadline=Date.now()+3000;while(!condition()){if(Date.now()>deadline)throw Error('Timed out');await delay(5);}}
async function fixture(t:any,windowMs=1000,requestPolicy?: (method:unknown,params:Record<string,unknown>)=>Promise<Record<string,unknown>>,limits: {requestTimeoutMs?:number;maxPendingRequests?:number;idleLaneMs?:number}={}) {
 const root=await mkdtemp(join(tmpdir(),'oc-callback-')),nativePath=join(root,'native.sock'),proxy=join(root,'gateway.sock');
 const http=createServer(),wss=new WebSocketServer({server:http});
 await new Promise<void>((resolve) =>http.listen(nativePath,resolve));
 const nativeSockets:WebSocket[]=[],requests:any[]=[];
 wss.on('connection', (socket) =>{nativeSockets.push(socket);socket.on('message', (frame) =>{const message=JSON.parse(String(frame));requests.push(message);if(message.method==='initialize')socket.send(JSON.stringify({id:message.id,result:{userAgent:'fixture'}}));});});
 const relay=await startOrchestrationCallbackRelay(proxy,nativePath,{disconnectWindowMs:windowMs,requestPolicy,...limits});
 const gateways:WebSocket[]=[];
 t.after(async()=>{for(const socket of gateways)socket.terminate();await relay.close();for(const socket of nativeSockets)socket.terminate();wss.close();await new Promise<void>((resolve) =>http.close(()=>resolve()));await rm(root,{recursive:true,force:true});});
 async function connect(lane='gateway') {
  const socket=new WebSocket(`ws+unix://${proxy}:/?opencraftLane=${lane}`),messages:any[]=[];
  gateways.push(socket);socket.on('message', (frame) =>messages.push(JSON.parse(String(frame))));
  await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
  socket.send(JSON.stringify({id:'init',method:'initialize',params:{clientInfo:{name:'gateway'},capabilities:{experimentalApi:true}}}));
  await until(()=>messages.some((m) =>m.id==='init'));socket.send(JSON.stringify({method:'initialized'}));
  return {socket,messages,send(value:unknown){socket.send(JSON.stringify(value));}};
 }
 return {relay,nativeSockets,requests,connect,proxy};
}
const callback={id:'native-call',method:'item/tool/call',params:{threadId:'child',turnId:'turn',callId:'call',tool:'thread_tell',arguments:{threadId:'parent',message:'Done'}}};
test('model catalog restores absent configured defaults without inventing or hiding reasoning choices', async (t) => {
 const f=await fixture(t),gateway=await f.connect();
 const model={id:'configured/tokenhub/model',model:'configured/tokenhub/model',defaultReasoningEffort:'none',supportedReasoningEfforts:[{reasoningEffort:'high'}]};
 const data=[model,{...model,id:'builtin',model:'builtin'},
  {...model,id:'explicit-none',supportedReasoningEfforts:[{reasoningEffort:'none'}]},
  {...model,id:'invalid-default',defaultReasoningEffort:'medium'}];
 gateway.send({id:'catalog',method:'model/list',params:{cursor:null,limit:100}});
 await until(()=>f.requests.some((m) =>m.method==='model/list'));
 const request=f.requests.find((m) =>m.method==='model/list');
 f.nativeSockets[0]!.send(JSON.stringify({id:request.id,result:{data,nextCursor:'next'}}));
 await until(()=>gateway.messages.some((m) =>m.id==='catalog'));
 const page=gateway.messages.find((m) =>m.id==='catalog').result;
 assert.equal(page.nextCursor,'next');
 assert.deepEqual(page.data,[{...model,defaultReasoningEffort:null},...data.slice(1)]);
 gateway.send({id:'other',method:'thread/read',params:{threadId:'thread'}});
 await until(()=>f.requests.some((m) =>m.method==='thread/read'));
 const other=f.requests.find((m) =>m.method==='thread/read');
 f.nativeSockets[0]!.send(JSON.stringify({id:other.id,result:{data}}));
 await until(()=>gateway.messages.some((m) =>m.id==='other'));
 assert.deepEqual(gateway.messages.find((m) =>m.id==='other').result,{data});
});
test('sandbox preparation failures log their distinct causes without exposing input or changing the wire error', async (t) => {
 const warnings = t.mock.method(console, 'warn', () => {});
 const f = await fixture(t, 1000, codexSandboxRequestPolicy(async (id) => {
  if (id === 'unreadable') throw new Error('private native error /private/workspace');
  return {thread: {}};
 }));
 const gateway = await f.connect();
 const cases = [
  {threadId:'unreadable', reason:'thread-read-failed'},
  {threadId:'old', reason:'missing-workspace'},
  {threadId:'old', cwd:'relative/private-workspace', reason:'invalid-workspace'},
 ];
 for (const [index, {reason, ...params}] of cases.entries()) {
  const id = `start-${index}`, clientUserMessageId = `message-${index}`;
  gateway.send({id, method:'turn/start', params:{...params, clientUserMessageId, input:[{text:'private message'}]}});
  await until(() => gateway.messages.some((message) => message.id === id));
  assert.deepEqual(gateway.messages.find((message) => message.id === id).error,
    {code:-32084, message:'Execution environment unavailable', data:{notSubmitted:true}});
  const [label, payload] = warnings.mock.calls[index]!.arguments as unknown as [string, string];
  assert.equal(label, '[opencraft-execution-preparation]');
  const event = JSON.parse(payload);
  assert.equal(event.reason, reason);
  assert.equal(event.threadId, params.threadId);
  assert.equal(event.clientMessageId, clientUserMessageId);
  assert.equal(event.forwarded, false);
  assert.doesNotMatch(payload, /private/);
 }
 assert.equal(f.requests.some((message) => message.method === 'turn/start'), false);
});
test('gateway disconnect retains the real native connection and replays a tool once with its stable identity',async (t) =>{
 const f=await fixture(t),first=await f.connect();await until(()=>f.requests.some((m) =>m.method==='initialized'));
 f.nativeSockets[0]!.send(JSON.stringify(callback));await until(()=>first.messages.some((m) =>m.id===callback.id));
 assert.equal(f.relay.pendingCallbacks,1);first.socket.terminate();await until(()=>first.socket.readyState===WebSocket.CLOSED);
 const next=await f.connect();await until(()=>next.messages.some((m) =>m.id===callback.id));const replay=next.messages.find((m) =>m.id===callback.id);
 assert.equal(replay.__opencraftToolCallKey,`${replay.__opencraftCallbackIncarnation}:child:turn:call`);assert.equal(replay.__opencraftToolCallKey,first.messages.find((m) =>m.id===callback.id).__opencraftToolCallKey);assert.equal(f.nativeSockets.length,1);assert.equal(f.requests.filter((m) =>m.method==='initialize').length,1);
 const answer={id:replay.id,__opencraftCallbackIncarnation:replay.__opencraftCallbackIncarnation,__opencraftToolCallKey:replay.__opencraftToolCallKey,result:{success:true,contentItems:[]}};
 next.send({...answer,__opencraftCallbackIncarnation:'old-incarnation'});await delay(15);assert.equal(f.requests.filter((m) =>m.id===callback.id).length,0);
 next.send(answer);next.send(answer);await until(()=>f.requests.some((m) =>m.id===callback.id));assert.equal(f.requests.filter((m) =>m.id===callback.id).length,1);assert.equal(f.relay.pendingCallbacks,0);
 f.nativeSockets[0]!.send(JSON.stringify({method:'serverRequest/resolved',params:{requestId:callback.id}}));
 f.nativeSockets[0]!.send(JSON.stringify({method:'turn/completed',params:{threadId:'child',turn:{id:'turn',status:'completed'}}}));
 await until(()=>next.messages.some((m) =>m.method==='turn/completed'));assert.equal(next.messages.filter((m) =>m.method==='item/tool/call').length,1);
});
test('lost spawn acknowledgement replays only its confirmed native result and rejects argument reuse',async (t) =>{
 const f=await fixture(t),first=await f.connect(),spawn={method:'thread/start',params:{cwd:'/workspace',__opencraftOrchestrationOperation:'operation'}};
 first.send({id:'start-before',...spawn});await until(()=>f.requests.some((m) =>m.method==='thread/start'));const native=f.requests.find((m) =>m.method==='thread/start');assert.equal(native.params.__opencraftOrchestrationOperation,undefined);
 first.socket.terminate();await until(()=>first.socket.readyState===WebSocket.CLOSED);f.nativeSockets[0]!.send(JSON.stringify({id:native.id,result:{thread:{id:'only-child'}}}));
 const next=await f.connect();next.send({id:'start-replay',...spawn});await until(()=>next.messages.some((m) =>m.id==='start-replay'));
 assert.equal(next.messages.find((m) =>m.id==='start-replay').result.thread.id,'only-child');assert.equal(f.requests.filter((m) =>m.method==='thread/start').length,1);
 next.send({id:'conflict',method:'thread/start',params:{...spawn.params,cwd:'/another'}});await until(()=>next.messages.some((m) =>m.id==='conflict'));assert.ok(next.messages.find((m) =>m.id==='conflict').error);
 next.send({id:'ack',method:'opencraft/orchestration/ack',params:{operationId:'operation'}});await until(()=>next.messages.some((m) =>m.id==='ack'));assert.equal(next.messages.find((m) =>m.id==='ack').result.acknowledged,true);
});
test('a callback arriving while detached waits for reconnect, then exhausts one bounded window',async (t) =>{
 const f=await fixture(t,40),first=await f.connect();await until(()=>f.requests.some((m) =>m.method==='initialized'));first.socket.terminate();await until(()=>first.socket.readyState===WebSocket.CLOSED);await delay(10);
 f.nativeSockets[0]!.send(JSON.stringify(callback));await until(()=>f.requests.some((m) =>m.id===callback.id));const answers=f.requests.filter((m) =>m.id===callback.id);
 assert.equal(answers.length,1);assert.equal(answers[0].result.success,false);assert.equal(f.nativeSockets.length,1);
});


test('native callbacks retain their admitted delegation through gateway replay and a later human steer',async (t) =>{
 const f=await fixture(t),first=await f.connect();
 first.send({id:'turn-start',method:'turn/start',params:{threadId:'child',input:[],__opencraftDelegationId:'delegation-A'}});
 await until(()=>f.requests.some((m) =>m.method==='turn/start'));
 assert.equal(f.requests.find((m) =>m.method==='turn/start').params.__opencraftDelegationId,undefined);
 f.nativeSockets[0]!.send(JSON.stringify({method:'turn/started',params:{threadId:'child',turn:{id:'turn'}}}));
 f.nativeSockets[0]!.send(JSON.stringify(callback));await until(()=>first.messages.some((m) =>m.id===callback.id));
 assert.equal(first.messages.find((m) =>m.id===callback.id).__opencraftDelegationId,'delegation-A');
 first.socket.terminate();await until(()=>first.socket.readyState===WebSocket.CLOSED);const next=await f.connect();
 await until(()=>next.messages.some((m) =>m.id===callback.id));assert.equal(next.messages.find((m) =>m.id===callback.id).__opencraftDelegationId,'delegation-A');
 next.send({id:'steer',method:'turn/steer',params:{threadId:'child',expectedTurnId:'turn',input:[],__opencraftDelegationId:'delegation-B'}});
 await until(()=>f.requests.some((m) =>m.method==='turn/steer'));const steer=f.requests.find((m) =>m.method==='turn/steer');
 f.nativeSockets[0]!.send(JSON.stringify({id:steer.id,result:{turnId:'turn'}}));await until(()=>next.messages.some((m) =>m.id==='steer'));
 f.nativeSockets[0]!.send(JSON.stringify({...callback,id:'next-call',params:{...callback.params,callId:'next'}}));await until(()=>next.messages.some((m) =>m.id==='next-call'));
 assert.equal(next.messages.find((m) =>m.id==='next-call').__opencraftDelegationId,'delegation-B');
 f.nativeSockets[0]!.send(JSON.stringify({method:'turn/completed',params:{threadId:'child',turn:{id:'turn',status:'completed'}}}));
 await until(()=>f.relay.pendingCallbacks===0);
});

test('a replacement Engine Host refuses an old prepared creation identity before Native admission',async (t) =>{
 const f=await fixture(t),gateway=await f.connect();gateway.send({id:'old',method:'thread/start',params:{cwd:'/workspace',__opencraftOrchestrationOperation:'old-operation',__opencraftOrchestrationIncarnation:'replaced-host'}});
 await until(()=>gateway.messages.some((m) =>m.id==='old'));assert.match(gateway.messages.find((m) =>m.id==='old').error.message,/unconfirmed/);assert.equal(f.requests.filter((m) =>m.method==='thread/start').length,0);
 gateway.send({id:'current',method:'thread/start',params:{cwd:'/workspace',__opencraftOrchestrationOperation:'current-operation',__opencraftOrchestrationIncarnation:f.relay.incarnation}});
 await until(()=>f.requests.some((m) =>m.method==='thread/start'));assert.equal(f.requests.find((m) =>m.method==='thread/start').params.__opencraftOrchestrationIncarnation,undefined);
});


test('a routing epoch alone cannot advertise orchestration, while the new facade can attach under a legacy default',async (t) =>{
 const f=await fixture(t);
 for(const scenario of [{version:undefined,callback:1},{version:1,callback:undefined}]){
  const transport=new CodexNativeCoreTransport('/unused/core.sock','synthetic-token',`capability-${scenario.version??0}`);
  transport.control.health=async()=>({protocolVersion:1,pid:1,codexPid:2,nativeSocket:f.proxy,routingEpoch:'routing',...(scenario.callback?{callbackProtocolVersion:1 as const,pendingCallbacks:0,pendingOrchestrationMutations:0}:{}),...(scenario.version?{orchestrationRoutingVersion:1 as const}:{})});
  await transport.connect();assert.equal(transport.supportsOrchestration,false);assert.equal(transport.supportsOrchestrationRouting,scenario.version===1);await transport.close();
 }
});

test('all human waits arriving detached replay, retain submitted state and retire only on native confirmation',async (t) =>{
 const f=await fixture(t,30),first=await f.connect();await until(()=>f.requests.some((m) =>m.method==='initialized'));
 first.socket.terminate();await until(()=>first.socket.readyState===WebSocket.CLOSED);await delay(10);
 const methods=['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','item/tool/requestUserInput','mcpServer/elicitation/request'];
 for(const [id,method] of methods.entries())f.nativeSockets[0]!.send(JSON.stringify({id,method,params:{threadId:'thread',turnId:'turn',itemId:`item-${id}`}}));
 await delay(60);assert.equal(f.requests.filter((m) =>!m.method&&typeof m.id==='number').length,0,'human waits cannot time out into an automatic answer');
 const next=await f.connect();await until(()=>next.messages.filter((m) =>methods.includes(m.method)).length===5);
 const requests=next.messages.filter((m) =>methods.includes(m.method));
 assert.equal(new Set(requests.map((m) =>m.__opencraftInteractionKey)).size,5);assert.ok(requests.every((m) =>m.__opencraftInteractionState==='pending'));
 next.send({id:0,result:{decision:'accept'}});next.send({id:0,result:{decision:'decline'}});await until(()=>f.requests.some((m) =>m.id===0));
 next.socket.terminate();await until(()=>next.socket.readyState===WebSocket.CLOSED);await delay(10);
 const last=await f.connect();await until(()=>last.messages.filter((m) =>methods.includes(m.method)).length===5);
 const submitted=last.messages.find((m) =>m.method===methods[0]);assert.equal(submitted.__opencraftInteractionKey,requests[0].__opencraftInteractionKey);assert.equal(submitted.__opencraftInteractionState,'responding');
 assert.equal(f.requests.filter((m) =>m.id===0).length,1);assert.equal(f.nativeSockets.length,1);
 f.nativeSockets[0]!.send(JSON.stringify({method:'serverRequest/resolved',params:{threadId:'thread',requestId:0}}));
 f.nativeSockets[0]!.send(JSON.stringify({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}}));
 await until(()=>last.messages.some((m) =>m.method==='turn/completed'));last.socket.terminate();await until(()=>last.socket.readyState===WebSocket.CLOSED);await delay(10);
 const settled=await f.connect();settled.send({id:'barrier',method:'fixture/barrier',params:{}});await until(()=>f.requests.some((m) =>m.method==='fixture/barrier'));
 assert.equal(settled.messages.filter((m) =>methods.includes(m.method)).length,0);
});

test('interrupt during sandbox preparation prevents a late turn from starting across client lanes', async (t) => {
 let release!:()=>void,preparing=false;
 const held=new Promise<void>((resolve) =>{release=resolve;});
 const f=await fixture(t,1000,async(method,params)=>{if(method==='turn/start'){preparing=true;await held;}return params;});
 const input=await f.connect('input'),control=await f.connect('control');
 input.send({id:'starting',method:'turn/start',params:{threadId:'thread',input:[]}});
 await until(()=>preparing);
 control.send({id:'stop',method:'turn/interrupt',params:{threadId:'thread',turnId:'turn'}});
 await until(()=>f.requests.some((m) =>m.method==='turn/interrupt'));
 release();await until(()=>input.messages.some((m) =>m.id==='starting'));
 assert.equal(input.messages.find((m) =>m.id==='starting').error.code,-32800);
 assert.equal(f.requests.filter((m) =>m.method==='turn/start').length,0);
});

test('private allocation withholds cross-lane notifications, reads and loaded IDs until explicit ownership publication, including reconnect',async (t) =>{
 const f=await fixture(t),owner=await f.connect('private-owner'),viewer=await f.connect('viewer');
 viewer.send({id:'before',method:'thread/loaded/list',params:{}});await until(()=>f.requests.some((m) =>m.method==='thread/loaded/list'));
 let request=f.requests.find((m) =>m.method==='thread/loaded/list');
 f.nativeSockets[1]!.send(JSON.stringify({id:request.id,result:{data:['existing']}}));await until(()=>viewer.messages.some((m) =>m.id==='before'));
 owner.send({id:'private-start',method:'thread/start',params:{cwd:'/private',__opencraftOrchestrationOperation:'private-op',__opencraftDeferPublication:true}});
 await until(()=>f.requests.some((m) =>m.method==='thread/start'));const create=f.requests.find((m) =>m.method==='thread/start');
 assert.equal(create.params.__opencraftDeferPublication,undefined);
 for(const native of f.nativeSockets)native.send(JSON.stringify({method:'thread/started',params:{thread:{id:'private-thread',cwd:'/private'}}}));
 viewer.send({id:'during',method:'thread/loaded/list',params:{}});await until(()=>f.requests.filter((m) =>m.method==='thread/loaded/list').length===2);
 request=f.requests.filter((m) =>m.method==='thread/loaded/list')[1];
 f.nativeSockets[1]!.send(JSON.stringify({id:request.id,result:{data:['existing','private-thread'],total:2}}));await until(()=>viewer.messages.some((m) =>m.id==='during'));
 assert.deepEqual(viewer.messages.find((m) =>m.id==='during').result,{data:['existing']});
 viewer.send({id:'hidden-read',method:'thread/read',params:{threadId:'private-thread'}});await until(()=>viewer.messages.some((m) =>m.id==='hidden-read'));
 assert.equal(viewer.messages.find((m) =>m.id==='hidden-read').error.code,-32004);
 assert.equal(f.requests.some((m) =>m.method==='thread/read'),false);
 f.nativeSockets[0]!.send(JSON.stringify({id:create.id,result:{thread:{id:'private-thread'}}}));await until(()=>owner.messages.some((m) =>m.id==='private-start'));
 assert.equal(viewer.messages.some((m) =>m.method==='thread/started'),false);
 viewer.send({id:'foreign-publish',method:'opencraft/orchestration/publish',params:{operationId:'private-op'}});await until(()=>viewer.messages.some((m) =>m.id==='foreign-publish'));
 assert.equal(viewer.messages.find((m) =>m.id==='foreign-publish').result.published,false);
 owner.socket.terminate();await until(()=>owner.socket.readyState===WebSocket.CLOSED);const again=await f.connect('private-owner');
 again.send({id:'replay',method:'thread/start',params:{cwd:'/private',__opencraftOrchestrationOperation:'private-op',__opencraftDeferPublication:true}});await until(()=>again.messages.some((m) =>m.id==='replay'));
 assert.equal(f.requests.filter((m) =>m.method==='thread/start').length,1);
 again.send({id:'publish',method:'opencraft/orchestration/publish',params:{operationId:'private-op'}});await until(()=>again.messages.some((m) =>m.id==='publish'));
 assert.equal(again.messages.find((m) =>m.id==='publish').result.published,true);
 await until(()=>viewer.messages.some((m) =>m.method==='thread/started'));
});

test('an unconfirmed native creation error keeps the private publication barrier closed',async (t) =>{
 const f=await fixture(t),owner=await f.connect('private-unknown'),viewer=await f.connect('viewer-unknown');
 owner.send({id:'unknown-start',method:'thread/start',params:{cwd:'/private',__opencraftOrchestrationOperation:'unknown-op',__opencraftDeferPublication:true}});
 await until(()=>f.requests.some((m) =>m.method==='thread/start'));const request=f.requests.find((m) =>m.method==='thread/start');
 f.nativeSockets[0]!.send(JSON.stringify({id:request.id,error:{code:-32000,message:'Creation result unknown',data:{resultUnknown:true}}}));
 await until(()=>owner.messages.some((m) =>m.id==='unknown-start'));
 assert.equal(owner.messages.find((m) =>m.id==='unknown-start').error.data.orchestrationRejected,false);
 f.nativeSockets[1]!.send(JSON.stringify({method:'thread/started',params:{thread:{id:'unknown-private',cwd:'/private'}}}));
 viewer.send({id:'no-read',method:'thread/read',params:{threadId:'unknown-private'}});
 await until(()=>viewer.messages.some((m) =>m.id==='no-read'));assert.equal(viewer.messages.find((m) =>m.id==='no-read').error.code,-32004);
 assert.equal(viewer.messages.some((m) =>m.method==='thread/started'),false);
});

for (const fails of [false,true]) test(`operation owns preparation after reconnect: ${fails?'failure':'success'}`,async (t) =>{
 let release!:(value?:unknown)=>void,entered=false;
 const held=new Promise((resolve,reject)=>{release=fails?reject:resolve;});
 const f=await fixture(t,1000,async(method,params)=>{if(method==='thread/start'){entered=true;await held;}return params;});
 const first=await f.connect();const request={method:'thread/start',params:{__opencraftOrchestrationOperation:'owned'}};
 first.send({id:'first',...request});await until(()=>entered);
 first.socket.terminate();await until(()=>first.socket.readyState===WebSocket.CLOSED);
 const second=await f.connect();second.send({id:'retry',...request});
 // A protocol barrier ensures the retry has joined before preparation resolves.
 second.send({id:'barrier',method:'opencraft/orchestration/private-capability'});
 await until(()=>second.messages.some((m) =>m.id==='barrier'));release(fails?Error('synthetic failure'):undefined);
 if(!fails){await until(()=>f.requests.some((m) =>m.method==='thread/start'));const r=f.requests.find((m) =>m.method==='thread/start');f.nativeSockets[0]!.send(JSON.stringify({id:r.id,result:{thread:{id:'created'}}}));}
 await until(()=>second.messages.some((m) =>m.id==='retry'));
 assert.equal(f.requests.filter((m) =>m.method==='thread/start').length,fails?0:1);
 if(fails)assert.equal(second.messages.find((m) =>m.id==='retry').error.code,-32084);
 else assert.equal(second.messages.find((m) =>m.id==='retry').result.thread.id,'created');
 second.send({id:'again',...request});await until(()=>second.messages.some((m) =>m.id==='again'));
 assert.deepEqual(second.messages.find((m) =>m.id==='again').error,second.messages.find((m) =>m.id==='retry').error);
 assert.equal(f.relay.pendingMutations,1);
 second.send({id:'ack',method:'opencraft/orchestration/ack',params:{operationId:'owned'}});
 await until(()=>second.messages.some((m) =>m.id==='ack'));assert.equal(f.relay.pendingMutations,0);
});

test('expired preparation cannot forward late and does not release its resource budget early',async (t) =>{
 let release!:()=>void,entered=false;const held=new Promise<void>((resolve) =>{release=resolve;});
 const f=await fixture(t,1000,async(method,params)=>{if(method==='turn/start'){entered=true;await held;}return params;},{requestTimeoutMs:40,maxPendingRequests:1});
 const g=await f.connect();g.send({id:'held',method:'turn/start',params:{threadId:'t'}});await until(()=>entered);
 await until(()=>g.messages.some((m) =>m.id==='held'));
 assert.equal(g.messages.find((m) =>m.id==='held').error.data.forwarded,false);
 assert.equal(g.messages.find((m) =>m.id==='held').error.data.notSubmitted,true);
 g.send({id:'overflow',method:'thread/read',params:{threadId:'t'}});await until(()=>g.messages.some((m) =>m.id==='overflow'));
 assert.equal(g.messages.find((m) =>m.id==='overflow').error.code,-32085);
 release();await delay(20);assert.equal(f.requests.some((m) =>m.method==='turn/start'),false);
 g.send({id:'read',method:'thread/read',params:{threadId:'t'}});await until(()=>f.requests.some((m) =>m.method==='thread/read'));
 await until(()=>g.messages.some((m) =>m.id==='read'));assert.equal(g.messages.find((m) =>m.id==='read').error.data.resultUnknown,true);
 g.send({id:'next',method:'thread/read',params:{threadId:'t'}});await until(()=>f.requests.filter((m) =>m.method==='thread/read').length===2);
});

test('timed out mutation cannot be acknowledged or reexecuted; late native result replaces uncertainty',async (t) =>{
 const f=await fixture(t,1000,undefined,{requestTimeoutMs:40}),g=await f.connect();
 const start={method:'thread/start',params:{__opencraftOrchestrationOperation:'slow',__opencraftDeferPublication:true}};
 g.send({id:'slow',...start});await until(()=>g.messages.some((m) =>m.id==='slow'));
 assert.equal(g.messages.find((m) =>m.id==='slow').error.data.resultUnknown,true);
 g.send({id:'ack',method:'opencraft/orchestration/ack',params:{operationId:'slow'}});await until(()=>g.messages.some((m) =>m.id==='ack'));assert.equal(g.messages.find((m) =>m.id==='ack').result.acknowledged,false);
 g.send({id:'retry',...start});await until(()=>g.messages.some((m) =>m.id==='retry'));assert.equal(g.messages.find((m) =>m.id==='retry').error.data.resultUnknown,true);
 const native=f.requests.find((m) =>m.method==='thread/start');f.nativeSockets[0]!.send(JSON.stringify({id:native.id,result:{thread:{id:'late-private'}}}));
 // Reply processing precedes this capability response on the same lane's event loop.
 await delay(20);g.send({id:'confirmed',...start});await until(()=>g.messages.some((m) =>m.id==='confirmed'));
 assert.equal(g.messages.find((m) =>m.id==='confirmed').result.thread.id,'late-private');
 assert.equal(f.requests.filter((m) =>m.method==='thread/start').length,1);
 g.send({id:'publish',method:'opencraft/orchestration/publish',params:{operationId:'slow'}});await until(()=>g.messages.some((m) =>m.id==='publish'));assert.equal(g.messages.find((m) =>m.id==='publish').result.published,true);
});

test('empty detached lanes retire while an admitted execution lane survives beyond idle deadline',async (t) =>{
 const f=await fixture(t,1000,undefined,{idleLaneMs:20});
 for(let i=0;i<34;i++){const g=await f.connect('empty-'+i);g.socket.terminate();await until(()=>g.socket.readyState===WebSocket.CLOSED);}
 await until(()=>f.nativeSockets.every((s) =>s.readyState===WebSocket.CLOSED));
 const g=await f.connect('running');g.send({id:'run',method:'turn/start',params:{threadId:'t'}});await until(()=>f.requests.some((m) =>m.method==='turn/start'));
 const request=f.requests.find((m) =>m.method==='turn/start');f.nativeSockets.at(-1)!.send(JSON.stringify({id:request.id,result:{turn:{id:'turn'}}}));await until(()=>g.messages.some((m) =>m.id==='run'));
 g.socket.terminate();await until(()=>g.socket.readyState===WebSocket.CLOSED);await delay(60);
 assert.equal(f.nativeSockets.at(-1)!.readyState,WebSocket.OPEN);
 const count=f.nativeSockets.length;await f.connect('running');assert.equal(f.nativeSockets.length,count);
});

test('a human callback arriving after detach revokes idle retirement',async (t) =>{
 const f=await fixture(t,1000,undefined,{idleLaneMs:50}),g=await f.connect();
 g.socket.terminate();await until(()=>g.socket.readyState===WebSocket.CLOSED);await delay(10);
 f.nativeSockets[0]!.send(JSON.stringify({id:'approval',method:'item/commandExecution/requestApproval',params:{threadId:'t',turnId:'turn',itemId:'item'}}));
 await until(()=>f.relay.pendingCallbacks===1);await delay(80);
 assert.equal(f.nativeSockets[0]!.readyState,WebSocket.OPEN);
 const reconnected=await f.connect();await until(()=>reconnected.messages.some((m) =>m.id==='approval'));
});

test('publication admission failure is a replayable rejection rather than an orphan operation',async (t) =>{
 const f=await fixture(t),a=await f.connect('owner'),b=await f.connect('other');
 const start={method:'thread/start',params:{__opencraftOrchestrationOperation:'same-key',__opencraftDeferPublication:true}};
 a.send({id:'own',...start});await until(()=>f.requests.some((m) =>m.method==='thread/start'));
 b.send({id:'foreign',...start});await until(()=>b.messages.some((m) =>m.id==='foreign'));
 b.send({id:'repeat',...start});await until(()=>b.messages.some((m) =>m.id==='repeat'));
 assert.deepEqual(b.messages.find((m) =>m.id==='foreign').error,b.messages.find((m) =>m.id==='repeat').error);
 assert.equal(f.requests.filter((m) =>m.method==='thread/start').length,1);
});

test('native socket loss preserves an uncertain operation and fences retry and acknowledgement',async (t) =>{
 const f=await fixture(t),first=await f.connect('owner');
 const op={method:'thread/start',params:{cwd:'/workspace',__opencraftOrchestrationOperation:'same-op',__opencraftOrchestrationIncarnation:f.relay.incarnation}};
 first.send({id:'first',...op});await until(()=>f.requests.some((m) =>m.method==='thread/start'));
 f.nativeSockets[0]!.terminate();await until(()=>first.socket.readyState===WebSocket.CLOSED);
 assert.equal(f.relay.pendingMutations,1);
 const next=await f.connect('owner');next.send({id:'retry',...op});
 await until(()=>next.messages.some((m) =>m.id==='retry'));
 assert.equal(next.messages.find((m) =>m.id==='retry').error.data.resultUnknown,true);
 next.send({id:'ack',method:'opencraft/orchestration/ack',params:{operationId:'same-op'}});
 await until(()=>next.messages.some((m) =>m.id==='ack'));assert.equal(next.messages.find((m) =>m.id==='ack').result.acknowledged,false);
 assert.equal(f.requests.filter((m) =>m.method==='thread/start').length,1);
 next.send({id:'different',method:'thread/start',params:{...op.params,cwd:'/other'}});
 await until(()=>next.messages.some((m) =>m.id==='different'));assert.match(next.messages.find((m) =>m.id==='different').error.message,/reused/);
});

test('confirmed private result and publication authority survive native connection replacement',async (t) =>{
 const f=await fixture(t),first=await f.connect('owner'),viewer=await f.connect('viewer');
 const op={method:'thread/start',params:{__opencraftOrchestrationOperation:'private-op',__opencraftDeferPublication:true}};
 first.send({id:'first',...op});await until(()=>f.requests.some((m) =>m.method==='thread/start'));
 const request=f.requests.find((m) =>m.method==='thread/start');
 f.nativeSockets[0]!.send(JSON.stringify({id:request.id,result:{thread:{id:'private-child'}}}));
 await until(()=>first.messages.some((m) =>m.id==='first'));
 f.nativeSockets[0]!.terminate();await until(()=>first.socket.readyState===WebSocket.CLOSED);
 const next=await f.connect('owner');next.send({id:'retry',...op});
 await until(()=>next.messages.some((m) =>m.id==='retry'));assert.equal(next.messages.find((m) =>m.id==='retry').result.thread.id,'private-child');
 viewer.send({id:'foreign',method:'opencraft/orchestration/publish',params:{operationId:'private-op'}});
 await until(()=>viewer.messages.some((m) =>m.id==='foreign'));assert.equal(viewer.messages.find((m) =>m.id==='foreign').result.published,false);
 next.send({id:'publish',method:'opencraft/orchestration/publish',params:{operationId:'private-op'}});
 await until(()=>next.messages.some((m) =>m.id==='publish'));assert.equal(next.messages.find((m) =>m.id==='publish').result.published,true);
 assert.equal(f.requests.filter((m) =>m.method==='thread/start').length,1);
});

test('acknowledgement before publication does not discard private owner on disconnect',async (t) =>{
 const f=await fixture(t),first=await f.connect('owner');
 first.send({id:'first',method:'thread/start',params:{__opencraftOrchestrationOperation:'private-op',__opencraftDeferPublication:true}});
 await until(()=>f.requests.some((m) =>m.method==='thread/start'));
 f.nativeSockets[0]!.send(JSON.stringify({id:f.requests.find((m) =>m.method==='thread/start').id,result:{thread:{id:'private-child'}}}));
 await until(()=>first.messages.some((m) =>m.id==='first'));
 first.send({id:'ack',method:'opencraft/orchestration/ack',params:{operationId:'private-op'}});
 await until(()=>first.messages.some((m) =>m.id==='ack'));assert.equal(f.relay.pendingMutations,0);
 f.nativeSockets[0]!.terminate();await until(()=>first.socket.readyState===WebSocket.CLOSED);
 // A different owner admission runs the unused-owner collector.
 await f.connect('other');
 const next=await f.connect('owner');
 next.send({id:'publish',method:'opencraft/orchestration/publish',params:{operationId:'private-op'}});
 await until(()=>next.messages.some((m) =>m.id==='publish'));assert.equal(next.messages.find((m) =>m.id==='publish').result.published,true);
});

test('unconfirmed private creation stays fenced with an explicit uncertain receipt after native loss',async (t) =>{
 const f=await fixture(t),first=await f.connect('owner'),viewer=await f.connect('viewer');
 const op={method:'thread/start',params:{__opencraftOrchestrationOperation:'private-op',__opencraftDeferPublication:true}};
 first.send({id:'first',...op});await until(()=>f.requests.some((m) =>m.method==='thread/start'));
 f.nativeSockets[0]!.terminate();await until(()=>first.socket.readyState===WebSocket.CLOSED);
 const next=await f.connect('owner');next.send({id:'retry',...op});
 await until(()=>next.messages.some((m) =>m.id==='retry'));assert.equal(next.messages.find((m) =>m.id==='retry').error.data.resultUnknown,true);
 next.send({id:'publish',method:'opencraft/orchestration/publish',params:{operationId:'private-op'}});
 viewer.send({id:'read',method:'thread/read',params:{threadId:'unidentified-private'}});
 await until(()=>next.messages.some((m) =>m.id==='publish')&&viewer.messages.some((m) =>m.id==='read'));
 assert.equal(next.messages.find((m) =>m.id==='publish').result.published,false);
 assert.equal(viewer.messages.find((m) =>m.id==='read').error.code,-32004);
 assert.equal(f.requests.filter((m) =>m.method==='thread/start').length,1);
});

test('native loss during preparation releases unused barrier, rejects late forwarding and retains promise capacity',async (t) =>{
 let release!:()=>void,entered=false;const held=new Promise<void>((resolve) => (release = resolve));
 const f=await fixture(t,1000,async(method,params)=>{if(method==='thread/start'){entered=true;await held;}return params;},{maxPendingRequests:2});
 const first=await f.connect('owner');
 const op={method:'thread/start',params:{__opencraftOrchestrationOperation:'preparing',__opencraftDeferPublication:true}};
 first.send({id:'first',...op});await until(()=>entered);
 f.nativeSockets[0]!.terminate();await until(()=>first.socket.readyState===WebSocket.CLOSED);
 const next=await f.connect('owner');next.send({id:'retry',...op});
 await until(()=>next.messages.some((m) =>m.id==='retry'));
 assert.deepEqual(next.messages.find((m) =>m.id==='retry').error.data,{notSubmitted:true,forwarded:false,resultUnknown:false,orchestrationRejected:true});
 next.send({id:'read',method:'thread/read',params:{threadId:'unrelated'}});
 await until(()=>f.requests.some((m) =>m.method==='thread/read'));
 next.send({id:'capacity',method:'model/list',params:{}});
 await until(()=>next.messages.some((m) =>m.id==='capacity'));assert.equal(next.messages.find((m) =>m.id==='capacity').error.code,-32085);
 release();await delay(20);
 assert.equal(f.requests.some((m) =>m.method==='thread/start'),false);
});

test('empty failed native lanes recycle owner capacity while unknown operations cannot be evicted',async (t) =>{
 const f=await fixture(t);
 for(let i=0;i<34;i++){
  const peer=await f.connect('empty-'+i);
  f.nativeSockets.at(-1)!.terminate();await until(()=>peer.socket.readyState===WebSocket.CLOSED);
 }
 const op={method:'thread/start',params:{__opencraftOrchestrationOperation:'retained'}};
 const first=await f.connect('owner');first.send({id:'first',...op});
 await until(()=>f.requests.some((m) =>m.method==='thread/start'));
 f.nativeSockets.at(-1)!.terminate();await until(()=>first.socket.readyState===WebSocket.CLOSED);
 await f.connect('collector');
 const next=await f.connect('owner');next.send({id:'retry',...op});
 await until(()=>next.messages.some((m) =>m.id==='retry'));assert.equal(next.messages.find((m) =>m.id==='retry').error.data.resultUnknown,true);
 assert.equal(f.requests.filter((m) =>m.method==='thread/start').length,1);
});

test('a saturated preparation owner can still reconnect to retrieve its rejection',async (t) =>{
 let release!:()=>void,entered=false;const held=new Promise<void>((resolve) => (release = resolve));
 const f=await fixture(t,1000,async(method,params)=>{if(method==='thread/start'){entered=true;await held;}return params;},{maxPendingRequests:1});
 const first=await f.connect('owner');const op={method:'thread/start',params:{__opencraftOrchestrationOperation:'held'}};
 first.send({id:'first',...op});await until(()=>entered);
 f.nativeSockets[0]!.terminate();await until(()=>first.socket.readyState===WebSocket.CLOSED);
 const next=await f.connect('owner');assert.ok(next.messages.find((m) =>m.id==='init').result);
 next.send({id:'retry',...op});await until(()=>next.messages.some((m) =>m.id==='retry'));
 assert.equal(next.messages.find((m) =>m.id==='retry').error.data.forwarded,false);
 next.send({id:'blocked',method:'model/list',params:{}});await until(()=>next.messages.some((m) =>m.id==='blocked'));
 assert.equal(next.messages.find((m) =>m.id==='blocked').error.code,-32085);
 release();await delay(20);assert.equal(f.requests.some((m) =>m.method==='thread/start'),false);
});

test('completed read-only lanes retire beyond the lane limit, but unknown methods retain ownership', async (t) => {
 const f=await fixture(t,1000,undefined,{idleLaneMs:10});
 for(let i=0;i<34;i++) {
  const g=await f.connect('read-'+i),native=f.nativeSockets.at(-1)!;
  g.send({id:'catalog',method:'model/list',params:{}});
  await until(()=>f.requests.filter((m) =>m.method==='model/list').length===i+1);
  const request=f.requests.filter((m) =>m.method==='model/list').at(-1);
  native.send(JSON.stringify({id:request.id,result:{data:[]}}));
  await until(()=>g.messages.some((m) =>m.id==='catalog'));
  g.socket.terminate();await until(()=>native.readyState===WebSocket.CLOSED);
 }
 const g=await f.connect('unknown'),native=f.nativeSockets.at(-1)!;
 g.send({id:'unknown',method:'future/operation',params:{}});
 await until(()=>f.requests.some((m) =>m.method==='future/operation'));
 native.send(JSON.stringify({id:f.requests.find((m) =>m.method==='future/operation').id,result:{}}));
 await until(()=>g.messages.some((m) =>m.id==='unknown'));
 g.socket.terminate();await delay(40);assert.equal(native.readyState,WebSocket.OPEN);
});

test('a pending read prevents retirement until its native reply arrives', async (t) => {
 const f=await fixture(t,1000,undefined,{idleLaneMs:10}),g=await f.connect(),native=f.nativeSockets[0]!;
 g.send({id:'read',method:'thread/read',params:{threadId:'t'}});
 await until(()=>f.requests.some((m) =>m.method==='thread/read'));
 g.socket.terminate();await delay(40);assert.equal(native.readyState,WebSocket.OPEN);
 native.send(JSON.stringify({id:f.requests.find((m) =>m.method==='thread/read').id,result:{thread:{id:'t'}}}));
 await until(()=>native.readyState===WebSocket.CLOSED);
});

test('human response identity fences native ID reuse after native reconnection', async (t) => {
 const f=await fixture(t),first=await f.connect();
 const approval={id:1,method:'item/commandExecution/requestApproval',params:{threadId:'t',turnId:'turn',itemId:'item'}};
 f.nativeSockets[0]!.send(JSON.stringify(approval));await until(()=>first.messages.some((m) =>m.id===1));
 const oldKey=first.messages.find((m) =>m.id===1).__opencraftInteractionKey;
 f.nativeSockets[0]!.terminate();await until(()=>first.socket.readyState===WebSocket.CLOSED);
 const next=await f.connect();f.nativeSockets[1]!.send(JSON.stringify(approval));
 await until(()=>next.messages.some((m) =>m.id===1));
 const key=next.messages.find((m) =>m.id===1).__opencraftInteractionKey;
 assert.notEqual(key,oldKey);
 next.send({id:1,__opencraftInteractionKey:oldKey,result:{decision:'accept'}});
 next.send({id:2,__opencraftInteractionKey:oldKey,result:{decision:'accept'}});
 next.send({id:'barrier',method:'opencraft/orchestration/private-capability'});
 await until(()=>next.messages.some((m) =>m.id==='barrier'));
 assert.equal(f.requests.some((m) =>m.id===1||m.id===2),false);
 next.send({id:1,__opencraftInteractionKey:key,result:{decision:'decline'}});
 await until(()=>f.requests.some((m) =>m.id===1));
 assert.deepEqual(f.requests.find((m) =>m.id===1),{id:1,result:{decision:'decline'}});
});



test('a caller fingerprint cannot hide argument reuse, while object key order preserves the same operation', async (t) => {
 const f=await fixture(t),g=await f.connect();
 const params={__opencraftOrchestrationOperation:'same-identity',__opencraftOrchestrationFingerprint:'caller-identity',cwd:'/synthetic/work',config:{a:1,b:2}};
 g.send({id:'first',method:'thread/start',params});await until(()=>f.requests.some((m) =>m.method==='thread/start'));
 g.send({id:'changed',method:'thread/start',params:{...params,cwd:'/synthetic/other'}});
 await until(()=>g.messages.some((m) =>m.id==='changed'));assert.equal(g.messages.find((m) =>m.id==='changed').error.code,-32600);
 g.send({id:'equivalent',method:'thread/start',params:{...params,config:{b:2,a:1}}});
 g.send({id:'barrier',method:'opencraft/orchestration/ack',params:{operationId:'not-an-operation'}});
 await until(()=>g.messages.some((m) =>m.id==='barrier'));
 const native=f.requests.find((m) =>m.method==='thread/start');f.nativeSockets[0]!.send(JSON.stringify({id:native.id,result:{thread:{id:'created'}}}));
 await until(()=>g.messages.some((m) =>m.id==='equivalent'));
 assert.equal(g.messages.find((m) =>m.id==='equivalent').result.thread.id,'created');
 assert.equal(f.requests.filter((m) =>m.method==='thread/start').length,1);
});


test('native loss during preparation rejects late forwarding and retains promise capacity',async (t) =>{
 let release!:()=>void,entered=false;const held=new Promise<void>((resolve) => (release = resolve));
 const f=await fixture(t,1000,async(method,params)=>{if(method==='thread/start'){entered=true;await held;}return params;},{maxPendingRequests:2});
 const first=await f.connect('owner');
 const op={method:'thread/start',params:{__opencraftOrchestrationOperation:'preparing'}};
 first.send({id:'first',...op});await until(()=>entered);
 f.nativeSockets[0]!.terminate();await until(()=>first.socket.readyState===WebSocket.CLOSED);
 const next=await f.connect('owner');next.send({id:'retry',...op});
 await until(()=>next.messages.some((m) =>m.id==='retry'));
 assert.deepEqual(next.messages.find((m) =>m.id==='retry').error.data,{notSubmitted:true,forwarded:false,resultUnknown:false,orchestrationRejected:true});
 next.send({id:'read',method:'thread/read',params:{threadId:'unrelated'}});
 await until(()=>f.requests.some((m) =>m.method==='thread/read'));
 next.send({id:'capacity',method:'model/list',params:{}});
 await until(()=>next.messages.some((m) =>m.id==='capacity'));assert.equal(next.messages.find((m) =>m.id==='capacity').error.code,-32085);
 release();await delay(20);
 assert.equal(f.requests.some((m) =>m.method==='thread/start'),false);
});

test("bound execution reaches native unchanged and a lost binding never forwards a turn", async (t) => {
  let active = true;
  t.mock.method(console, "warn", () => {});
  const policy = codexSandboxRequestPolicy(
    async () => {
      throw Error("local fallback forbidden");
    },
    undefined,
    undefined,
    async () => ({
      kind: "bound",
      binding: {
        async executionFields() {
          if (!active) throw Error("private provider diagnostic");
          return { cwd: "/workspace", environments: [{ environmentId: "workspace-remote", cwd: "/workspace" }] };
        },
      },
    }),
  );
  const f = await fixture(t, 1000, policy),
    gateway = await f.connect();
  const sandboxPolicy = { type: "workspaceWrite", writableRoots: ["/workspace"], networkAccess: false };
  gateway.send({
    id: "bound-turn",
    method: "turn/start",
    params: { threadId: "remote-thread", sandboxPolicy, approvalPolicy: "on-request", input: [] },
  });
  await until(() => f.requests.some((m) => m.method === "turn/start"));
  const request = f.requests.find((m) => m.method === "turn/start");
  assert.deepEqual(request.params.environments, [{ environmentId: "workspace-remote", cwd: "/workspace" }]);
  assert.deepEqual(request.params.sandboxPolicy, sandboxPolicy);
  assert.equal(request.params.approvalPolicy, "on-request");
  assert.equal(request.params.cwd, "/workspace");
  f.nativeSockets[0]!.send(JSON.stringify({ id: request.id, result: { turn: { id: "turn", status: "completed" } } }));
  await until(() => gateway.messages.some((m) => m.id === "bound-turn"));
  active = false;
  gateway.send({ id: "lost-turn", method: "turn/start", params: { threadId: "remote-thread", input: [] } });
  await until(() => gateway.messages.some((m) => m.id === "lost-turn"));
  assert.deepEqual(gateway.messages.find((m) => m.id === "lost-turn").error, {
    code: -32084,
    message: "Execution environment unavailable",
  });
  assert.equal(f.requests.filter((m) => m.method === "turn/start").length, 1);
});
