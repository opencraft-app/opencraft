import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { PiEngine, piModel } from '../../plugins/pi-engine/src/index.js';
import { startEngineHost } from '../../apps/local-agent-host/src/engine-host.js';
import { WebSocketTransport } from '../../packages/appserver-transport-websocket/src/index.js';
import { AppHostServer } from '../../packages/app-host-server/src/index.js';
import { ActorStore } from '../../packages/access-control/src/actors.js';
import { Collaboration } from '../../packages/access-control/src/collaboration.js';
import { SessionCapabilities } from '../../packages/session-capabilities/src/index.js';
import { IM_REPLY_TOOL } from '../../plugins/im/src/reply-tool.js';
import { ImPlugin } from '../../plugins/im/src/server.js';
import { SwitchboardStore } from '../../plugins/im/src/store.js';
import { stewardRoute } from '../../plugins/im/src/templates.js';
import { encodeConversationRef } from '../../packages/appserver-protocol/src/collaboration.js';
import { createRoutedConversationExecution } from '../../scripts/conversation-execution.mjs';
import { createImExecution } from '../../scripts/im-plugins.mjs';
import WebSocket from 'ws';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';

const signal = () => new AbortController().signal;
async function root(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'im-multi-engine-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const actors = new ActorStore(join(directory, 'actors.sqlite'));
  const human = actors.resolveHuman({provider:'local',subject:'fixture',displayName:'Human',expiresAt:Date.now()+60_000})!;
  t.after(() => actors.close());
  return {directory,actors,human};
}

test('Pi IM uses native durable input and both browser/Host tools; final and duplicate input never resend', async t => {
  const {directory,actors,human} = await root(t), capabilities = new SessionCapabilities();
  const faux = fauxProvider({tokensPerSecond:10000}), models = createModels(); models.setProvider(faux.provider);
  const engine = new PiEngine({directory:join(directory,'pi'),cwd:directory,models:Object.assign(models,{getAvailableSnapshot:()=>faux.models}) as unknown as ModelRuntime,
    sessionCapabilities:capabilities.scoped('server:fixture:pi')});
  let browserCalls=0;
  const browser = {notify(){},async request(){browserCalls++;return {success:true,contentItems:[{type:'inputText',text:'browser result'}]};}};
  const {thread} = await engine.request('thread/start',{model:piModel('faux','faux-1'),cwd:directory,
    dynamicTools:[{type:'function',name:'probe',description:'Browser probe',inputSchema:{type:'object',properties:{}}}]},browser);
  const host = await startEngineHost({providers:[engine],defaultEngine:'pi'});
  const appHost = new AppHostServer({logicalClientRouting:true,physicalHostLifetime:'server',createTransport:()=>new WebSocketTransport({url:host.websocketUrl,createSocket:url=>new WebSocket(url)})});
  t.after(async()=>{await appHost.close();await host.close();});
  const execution = createRoutedConversationExecution(()=>appHost,{machineId:'fixture',engines:['pi'],getInputs:async()=>engine.inputs});
  const collaboration = new Collaboration(join(directory,'collaboration.sqlite'),actors,execution);
  t.after(()=>collaboration.close());
  const store = new SwitchboardStore(join(directory,'im.sqlite'));
  const ref = {serverId:'server:fixture:pi',threadId:thread.id};
  store.saveChannel({id:'bot',provider:'wecom',ownerId:human.actorId,name:'Fixture',groupScope:'chat',botId:'synthetic'},true,null);
  store.route('bot',1,stewardRoute(encodeConversationRef(ref)),true);
  const im = new ImPlugin(store,createImExecution({actors,collaboration,getAppHost:()=>appHost}),1024,true);
  im.register({id:'bot',ownerId:human.actorId,senders:{sender:human.actorId},groupScope:'chat'});
  t.after(()=>im.close());
  const identity = (session: typeof ref) => ({ serverId: session.serverId, threadId: session.threadId });
  capabilities.register({id:'im.reply',tools:session=>im.replyAvailable(identity(session))?[IM_REPLY_TOOL]:[],call:(session,name,args,signal)=>im.reply(identity(session),args,signal)});
  const deliveries:string[]=[];im.setDelivery(async(_channel,address,text)=>{assert.equal(address.chat,'original');deliveries.push(text);});
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('opencraft_0_probe',{}, {id:'browser'})],{stopReason:'toolUse'}),
    () => fauxAssistantMessage([fauxToolCall('opencraft_host_im_reply',{replyRef:store.messages('bot')[0]!.reply_ref,text:'complete Pi answer'}, {id:'reply'})],{stopReason:'toolUse'}),
    fauxAssistantMessage('final remains in workbench'),
  ]);
  const done = new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Pi IM did not settle')),10_000);engine.subscribe((method)=>{if(method==='turn/completed'){clearTimeout(timer);resolve();}});});
  const message = {id:'external-one',source:{chatId:'original',chatType:'direct' as const,senderId:'sender'},text:'Please answer once',replyAddress:{chat:'original',expiresAt:Date.now()+60_000},
    async reply(){throw Error('automatic final must not send');},async accepted(){throw Error('stream must not send');}};
  await im.receive('bot',message);await collaboration.pump();await done;await collaboration.pump();
  await im.receive('bot',message);await collaboration.pump();
  assert.deepEqual(deliveries,['complete Pi answer']);assert.equal(browserCalls,1);
  const record = store.messages('bot')[0]!;assert.equal(record.state,'delivered');
  assert.deepEqual(capabilities.tools({serverId:'server:fixture:dsh',threadId:thread.id}),[]);
  const history = (await engine.request('thread/read',{threadId:thread.id,includeTurns:true},browser)).thread.turns;
  assert.equal(history.length,1);assert.match(JSON.stringify(history),/final remains in workbench/);
  const request = collaboration.getRequest(human,record.request_id!);assert.equal(request.state,'submitted');
  const inputId = 'actor-input:'+record.request_id;
  assert.equal((await engine.inputs.receipt(thread.id,inputId))?.state,'delivered');
  await appHost.close();await host.close();
  const reopened = new PiEngine({directory:join(directory,'pi'),cwd:directory,models:Object.assign(models,{getAvailableSnapshot:()=>faux.models}) as unknown as ModelRuntime});
  t.after(()=>reopened.close());assert.equal((await reopened.inputs.receipt(thread.id,inputId))?.state,'delivered');
  assert.equal((await reopened.inputs.submit(thread.id,inputId,'must not run',()=>false))?.state,'delivered');
  assert.equal(faux.state.callCount,3);
});

test('multi-engine admission isolates server identity, safely defers busy native input and never replays unknown handoff',async t=>{
  const {directory,actors,human}=await root(t);let busy=true,sent=0,current=true,ambiguous=false;
  const receipts=new Map<string,any>();
  const inputs={async receipt(_thread:string,id:string){return receipts.get(id)??null;},async submit(thread:string,id:string,_text:string,canAdmit:()=>boolean){
    if(busy||!canAdmit())return null;sent++;assert.equal(thread,'pi_same');if(ambiguous)throw Error('native timeout');
    const receipt={state:'delivered',turnId:'native-turn'};receipts.set(id,receipt);return receipt;
  }};
  const execution=createRoutedConversationExecution(()=>null,{machineId:'fixture',engines:['pi','dsh'],getInputs:async engine=>{assert.equal(engine,'pi');return inputs;}});
  const service=new Collaboration(join(directory,'collaboration.sqlite'),actors,execution,Date.now,()=>current);t.after(()=>service.close());
  const ref={serverId:'server:fixture:pi',threadId:'pi_same'};
  const send=(key:string,execution?:any)=>service.sendConversation(human,{reference:encodeConversationRef(ref),content:key,idempotencyKey:key,...(execution?{execution}:{})}).requestId!;
  const id=send('one');
  assert.equal(service.authorizeInput(ref.threadId,'actor-input:'+id,'queue',undefined,ref.serverId),true);
  assert.equal(service.authorizeInput(ref.threadId,'actor-input:'+id,'queue',undefined,'server:fixture:dsh'),false);
  await service.pump();assert.equal(service.getRequest(human,id).state,'accepted');assert.equal(sent,0);
  busy=false;await service.pump();await service.pump();assert.equal(service.getRequest(human,id).state,'submitted');assert.equal(sent,1);
  const steer=send('steer',{mode:'steer',expectedTurnId:'foreign'});await service.pump();assert.equal(service.getRequest(human,steer).state,'rejected');assert.equal(sent,1);
  ambiguous=true;const unknown=send('unknown');await service.pump();await service.pump();assert.equal(service.getRequest(human,unknown).state,'unknown');assert.equal(sent,2);
  await service.pump();assert.equal(sent,2);
  const revoked=send('revoke');current=false;await service.pump();assert.equal(service.getRequest(human,revoked).state,'rejected');assert.equal(sent,2);
  await assert.rejects(execution.receipt({hostId:'opencraft-server',serverId:'server:fixture:dsh',threadId:'pi_same'},'forged'));
});

test('conversation picker reads both Hosts on its first page, preserves independent cursors and maps sources by canonical identity',async t=>{
  const {directory,actors,human}=await root(t),calls:any[]=[];
  const appHost=new AppHostServer({logicalClientRouting:true,physicalHostLifetime:'server',createTransport(hostId){
    const messages=new Set<(frame:string)=>void>(),statuses=new Set<(status:any)=>void>();let state:any={state:'idle'};
    return {get status(){return state;},async connect(){state={state:'open'};statuses.forEach(fn=>fn(state));},async send(raw:string){
      const frame=JSON.parse(raw);if(frame.id===undefined)return;
      let result:any={};
      if(frame.method==='thread/list'){
        calls.push({hostId,cursor:frame.params.cursor});
        result=hostId==='local-codex'?{data:[{id:'pi_same',name:'Codex conversation'}],nextCursor:frame.params.cursor?null:'codex-page-2'}
          :{data:[{id:'pi_same',name:'Pi conversation'},{id:'same',name:'DSH conversation'}],nextCursor:null};
      } else if(frame.method==='thread/read')result={thread:{id:frame.params.threadId,ephemeral:false}};
      messages.forEach(fn=>fn(JSON.stringify({id:frame.id,result,[LOGICAL_CLIENT_FIELD]:frame[LOGICAL_CLIENT_FIELD]})));},
      subscribeMessage(fn:(frame:string)=>void){messages.add(fn);return()=>messages.delete(fn);},subscribeStatus(fn:(status:any)=>void){statuses.add(fn);return()=>statuses.delete(fn);},async close(){},
    };
  }});t.after(()=>appHost.close());
  const execution=createRoutedConversationExecution(()=>appHost,{machineId:'fixture',engines:['pi','dsh'],getInputs:async()=>null});
  const first=await execution.discover('',null);assert.deepEqual(first.conversations.map((c:any)=>c.ref.serverId),['server:fixture:codex','server:fixture:pi','server:fixture:dsh']);
  assert.equal(calls.length,2);assert.ok(first.nextCursor);
  const second=await execution.discover('',first.nextCursor);assert.equal(second.conversations.length,1);assert.equal(second.nextCursor,null);assert.equal(calls.length,3);assert.equal(calls[2].hostId,'local-codex');assert.equal(calls[2].cursor,'codex-page-2');
  const {ImChannelService}=await import('../../scripts/im-channel-service.mjs');
  const collaboration=new Collaboration(join(directory,'collaboration.sqlite'),actors,execution);t.after(()=>collaboration.close());
  const service=await ImChannelService.open([],{dataDirectory:directory,actors,collaboration,getAppHost:()=>appHost,actorAccess:{authenticate:()=>human},credentials:{set:async()=>{},remove:async()=>{},resolve:async()=>null}});t.after(()=>service.close());
  const document=await service.operation(human,{action:'list'});assert.equal(document.servers.length,3);
  for(const [hostId,threadId]of [['local-codex','pi_same'],['opencraft-server','pi_same'],['opencraft-server','same']]){
    const result=await service.operation(human,{action:'sources',hostId,threadId});assert.deepEqual(result.sources,[]);
  }
  await assert.rejects(service.operation(human,{action:'sources',hostId:'untrusted',threadId:'same'}),/unsupported_host/);
});
