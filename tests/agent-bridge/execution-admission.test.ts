import test from 'node:test';
import assert from 'node:assert/strict';
import {LOGICAL_CLIENT_FIELD} from '@opencraft/app-host-protocol';
import { BridgeExecutionAdmissionTransport,createServerCodexBridge } from '../../apps/opencraft-daemon/src/bridge-execution-admission';

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


test('the Server bridge factory leaves the default legacy transport and admission owner untouched',()=>{
  const legacy:any={};
  const transport=createServerCodexBridge(legacy,undefined,{async admit(){throw Error('legacy admission replaced');},sign(){throw Error('legacy signed');},started(){throw Error('legacy binding replaced');}});
  assert.equal(transport,legacy);
});

test('creation installs only a reserved MCP configuration and binds it after domain admission',async()=>{
  const {createBridgeSessionMcp}=await import('../../apps/opencraft-daemon/src/bridge-execution-admission');
  let bound=0,canceled=0,prepared=0,resets=0;
  const configuration={url:'http://127.0.0.1:1/mcp',http_headers:{Authorization:'opaque-unbound-reservation'}};
  const helper=createBridgeSessionMcp({
    config(){return configuration;},
    prepareExecution(){prepared++;return {configuration,bindThread(){},bind(){bound++;},resetBeforeStart(){resets++;},cancel(){canceled++;}};},
  },threadId=>({serverId:'server',threadId}),async()=>{});
  const sent:any[]=[],received:any[]=[];let native!:(raw:string)=>void;
  const inner:any={status:{state:'open'},async connect(){},async close(){},subscribeStatus:()=>()=>{},
    subscribeMessage:(listener:any)=>{native=listener;return()=>{};},async send(raw:string){sent.push(JSON.parse(raw));}};
  let admitted=false;
  const transport=new BridgeExecutionAdmissionTransport(inner,{...helper,async admit(threadId,inputId){if(!admitted)throw Error('revoked');return {serverId:'server',threadId,execution:{inputId,executionId:'execution'}};},sign:()=> 'signed-admission',started(){}});
  transport.subscribeMessage(raw=>received.push(JSON.parse(raw)));
  await transport.send(JSON.stringify({id:'create',method:'thread/start',params:{cwd:'/workspace',agentBridge:{threadId:'one'},config:{custom:'preserved'}}}));
  assert.equal(prepared,1);assert.equal(bound,0);
  assert.deepEqual(sent[0].params.config['mcp_servers.opencraft_session'],configuration);
  assert.equal(sent[0].params.config.custom,'preserved');
  const start=JSON.stringify({id:'start',method:'turn/start',params:{threadId:'bridge:codex:one',clientUserMessageId:'input',input:[]}});
  await transport.send(start);assert.equal(bound,0);assert.equal(received.at(-1).error.message,'cliUnavailable');
  admitted=true;await transport.send(start);assert.equal(bound,1);
  assert.deepEqual(sent.at(-1).params.opencraftSessionMcp,configuration);
  native(JSON.stringify({id:'start',error:{data:{submissionOutcome:'rejected'}}}));
  assert.equal(resets,1);await transport.send(start);assert.equal(bound,2);
  native(JSON.stringify({method:'turn/started',params:{threadId:'bridge:codex:one',turn:{id:'turn'}}}));
  native(JSON.stringify({method:'turn/completed',params:{threadId:'bridge:codex:one',turn:{id:'turn'}}}));
  assert.equal(canceled,1);
});

test('a rejected duplicate creation cannot cancel another creation or the installed first binding',async()=>{
  const {createBridgeSessionMcp}=await import('../../apps/opencraft-daemon/src/bridge-execution-admission');
  let canceled=0;
  const helper=createBridgeSessionMcp({config(){return null;},prepareExecution(){return {configuration:{url:'http://127.0.0.1:1/mcp'},bindThread(){},bind(){},resetBeforeStart(){},cancel(){canceled++;}};},},
    threadId=>({serverId:'server',threadId}),async()=>{});
  const first=await helper.prepareSessionMcp('one'),duplicate=await helper.prepareSessionMcp('one');
  duplicate.settle?.('rejected');assert.equal(canceled,0);
  first.settle?.('accepted');
  const afterSuccess=await helper.prepareSessionMcp('one');afterSuccess.settle?.('rejected');assert.equal(canceled,0);
  helper.completed('one');assert.equal(canceled,1);
  const failed=await helper.prepareSessionMcp('two');failed.settle?.('rejected');assert.equal(canceled,2);
});

test('pre-dispatch creation validation failures release every memory reservation',async t=>{
  const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {SessionCapabilities}=await import('../../packages/session-capabilities/src/index');
  const {SessionCapabilityMcp}=await import('../../packages/session-capabilities/src/mcp');
  const {createBridgeSessionMcp}=await import('../../apps/opencraft-daemon/src/bridge-execution-admission');
  const root=await mkdtemp(join(tmpdir(),'p7a-uninitialized-'));
  const mcp=new SessionCapabilityMcp(new SessionCapabilities(),Buffer.alloc(32,7));await mcp.listen();t.after(()=>mcp.close());
  const helper=createBridgeSessionMcp(mcp,threadId=>({serverId:'server',threadId}),async()=>{});
  const legacy:any={status:{state:'open'},subscribeMessage:()=>()=>{},subscribeStatus:()=>()=>{},async close(){}};
  const issuedConfigurations:Record<string,any>[]=[];
  const transport=createServerCodexBridge(legacy,{url:'http://127.0.0.1:1',token:'private-test-token-00000000000000000000',serverId:'server',inboxPath:join(root,'inbox.db')},{...helper,async prepareSessionMcp(threadId){const prepared=await helper.prepareSessionMcp(threadId);issuedConfigurations.push(prepared.configuration!);return prepared;},async admit(){throw Error('unused');},sign(){return '';},started(){}});
  t.after(async()=>{await transport.close();await mcp.close();await rm(root,{recursive:true,force:true});});
  for(let i=0;i<300;i++)await assert.rejects(transport.send(JSON.stringify({id:i,method:'thread/start',params:{agentBridge:{threadId:'uninitialized-'+i,clientRequestId:'create'}},[LOGICAL_CLIENT_FIELD]:'unused'})));
  assert.equal(issuedConfigurations.length,300);
  for(const config of [issuedConfigurations[0],issuedConfigurations.at(-1)!]){
    const revoked=await fetch(config.url,{method:'POST',headers:{...config.http_headers,'content-type':'application/json'},body:'{}'});
    assert.equal(revoked.status,401);
  }
  const fresh=await helper.prepareSessionMcp('still-available');fresh.settle?.('rejected');
});

test('admission owner close releases more than 256 installed but unstarted reservations, preserving first-turn approvals',async t=>{
  const {SessionCapabilities}=await import('../../packages/session-capabilities/src/index');
  const {SessionCapabilityMcp}=await import('../../packages/session-capabilities/src/mcp');
  const {createBridgeSessionMcp}=await import('../../apps/opencraft-daemon/src/bridge-execution-admission');
  const capabilities=new SessionCapabilities();capabilities.register({id:'platform',tools:()=>[{name:'approved_read',description:'Read bounded data',inputSchema:{type:'object'},approval:'preauthorized'}],async call(){return {};}});
  const mcp=new SessionCapabilityMcp(capabilities,Buffer.alloc(32,8));await mcp.listen();t.after(()=>mcp.close());
  const helper=createBridgeSessionMcp(mcp,threadId=>({serverId:'server',threadId}),s=>capabilities.refresh(s));
  let native!:(raw:string)=>void;
  const inner:any={status:{state:'open'},async close(){},subscribeMessage:(l:any)=>{native=l;return()=>{};},subscribeStatus:()=>()=>{},async send(raw:string){const f=JSON.parse(raw);native(JSON.stringify({id:f.id,result:{thread:{id:f.params.agentBridge.threadId}}}));}};
  const transport=new BridgeExecutionAdmissionTransport(inner,{...helper,async admit(){throw Error('unused');},sign(){return '';},started(){}});
  let config:any;
  const original=helper.prepareSessionMcp;
  for(let i=0;i<300;i++){
    const prepared=await original('bridge:codex:'+i);prepared.settle?.('accepted');
    if(i===0)config=prepared.configuration;
  }
  assert.deepEqual(config.tools,{approved_read:{approval_mode:'approve'}});
  const bound=await helper.sessionMcp({serverId:'server',threadId:'bridge:codex:0',execution:{inputId:'first',executionId:'first'}});
  assert.deepEqual(bound,config);
  await transport.close();
  const revoked=await fetch(config.url,{method:'POST',headers:{...config.http_headers,'content-type':'application/json'},body:'{}'});
  assert.equal(revoked.status,401);
  const fresh=await helper.prepareSessionMcp('after-owner-close');fresh.settle?.('rejected');
  const legacyPending=Array.from({length:256},()=>mcp.prepareExecution());
  assert.throws(()=>mcp.prepareExecution(),/Too many pending/);
  for(const reservation of legacyPending)reservation.cancel();
});

test('an unknown start retains its source until a delayed native Turn can bind it',async()=>{
  let native!:(raw:string)=>void,resets=0,started=0;
  const inner:any={status:{state:'open'},subscribeMessage:(l:any)=>{native=l;return()=>{};},subscribeStatus:()=>()=>{},async send(raw:string){const f=JSON.parse(raw);native(JSON.stringify({id:f.id,error:{data:{submissionOutcome:'unknown'}}}));}};
  const transport=new BridgeExecutionAdmissionTransport(inner,{async admit(threadId,inputId){return {serverId:'server',threadId,execution:{inputId,executionId:inputId}};},sign:()=> 'signed',started(){started++;},rejectedBeforeStart(){resets++;}});
  await transport.send(JSON.stringify({id:'unknown',method:'turn/start',params:{threadId:'bridge:codex:one',clientUserMessageId:'original',input:[]}}));
  native(JSON.stringify({method:'turn/started',params:{threadId:'bridge:codex:one',turn:{id:'late'}}}));
  assert.equal(started,1);assert.equal(resets,0);
});
