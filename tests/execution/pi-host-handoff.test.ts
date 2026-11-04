import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import type { SessionCapabilityPort } from '@opencraft/session-capabilities';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { PiEngine, piModel } from '../../plugins/pi-engine/src/index.js';
import { AcpHostHandoff } from '../../plugins/acp-engine/src/host-handoff.js';
import { PiOwnerHandoff } from '../../scripts/server-deployment/pi-owner-handoff.mjs';
const client = { notify() {}, async request() { throw new Error('No tools'); } };
function models(responses:any[] = []) {
 const faux=fauxProvider({tokensPerSecond:10000});faux.setResponses(responses);const runtime=createModels();runtime.setProvider(faux.provider);
 return Object.assign(runtime,{getAvailableSnapshot:()=>faux.models}) as unknown as ModelRuntime;
}
async function fixture(t:test.TestContext,responses:any[] = [],sessionCapabilities?:SessionCapabilityPort) {
 const root=await mkdtemp(join(tmpdir(),'pi-handoff-'));for(const path of ['pi','models','projects'])await mkdir(join(root,path));
 const authority=new AcpHostHandoff(join(root,'pi'),'old');await authority.load();
 const admission={open:()=>authority.snapshot().phase==='open',run:authority.run.bind(authority)};
 const engine=new PiEngine({directory:join(root,'pi'),dataDirectory:root,cwd:root,models:models(responses),admission,sessionCapabilities});await engine.start();
 t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});return {root,engine,authority};
}
const expected=(authority:AcpHostHandoff)=>({expectedOwner:authority.owner,expectedEpoch:authority.snapshot().epoch,operationId:'test',fence:'test'});
async function until(check:()=>Promise<boolean>){const end=Date.now()+15000;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,25));}throw Error('Timeout');}

test('Pi fence rejects RPC and IM; unknown release remains fenced',async t=>{
 const f=await fixture(t);const {thread}=await f.engine.request('thread/start',{model:piModel('faux','faux-1')},client);
 await f.authority.fence(expected(f.authority));
 await assert.rejects(f.engine.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'forbidden'}]},client),/fenced/);
 await assert.rejects(f.engine.inputs.submit(thread.id,'im','forbidden',async()=>true),/fenced/);
 assert.equal(await f.engine.inputs.receipt(thread.id,'im'),null);
 await f.engine.request('turn/interrupt',{threadId:thread.id},client);
 assert.equal((await f.engine.handoffObservation()).activeCount,0);
 const next=new AcpHostHandoff(join(f.root,'pi'),'next');await assert.rejects(next.load(),/unconfirmed/);
});

test('cold successor reads history and cannot resume with stale store proof',async t=>{
 const f=await fixture(t,[fauxAssistantMessage('durable answer')]);
 const {thread}=await f.engine.request('thread/start',{model:piModel('faux','faux-1')},client);
 await f.engine.request('turn/start',{threadId:thread.id,clientUserMessageId:'first',input:[{type:'text',text:'hello'}]},client);
 await until(async()=>(await f.engine.handoffObservation()).activeCount===0);
 await f.authority.fence(expected(f.authority));const observed=await f.engine.handoffObservation();
 await f.authority.release(expected(f.authority),()=>observed,()=>f.engine.close());
 const owner=new PiOwnerHandoff(f.root,{entry:'test'},()=>({coverage:'complete',activeCount:0}));await owner.load();
 const next=new PiEngine({directory:join(f.root,'pi'),dataDirectory:f.root,cwd:f.root,models:models(),admission:owner});t.after(()=>next.close());await next.start();
 owner.attach(next,{consumerObservation:()=>({coverage:'complete',activeCount:0})},[]);
 const ready=await owner.control('cold-ready',expected(owner.authority));assert.equal(ready.handoff.phase,'cold-ready');
 await assert.rejects(next.request('thread/list',{},client),/fenced/);
 await writeFile(join(f.root,'models','change.json'),'{}');
 await assert.rejects(owner.control('resume',{...expected(owner.authority),identity:ready.handoff.ready.identity}),/changed/);
 const fresh=await owner.control('cold-ready',expected(owner.authority));await owner.control('resume',{...expected(owner.authority),identity:fresh.handoff.ready.identity});
 const history=await next.request('thread/read',{threadId:thread.id,includeTurns:true},client);
 assert.equal(history.thread.turns.length,1);assert.equal(history.thread.turns[0].items.find((item:any)=>item.type==='agentMessage').text,'durable answer');
 assert.equal((await next.inputs.receipt(thread.id,'first'))?.state,'delivered');
});

test('corrupt index or native ledger cannot certify idle',async t=>{
 const f=await fixture(t);await f.engine.close();await writeFile(join(f.root,'pi','pi_dead.json'),'{broken');
 const next=new PiEngine({directory:join(f.root,'pi'),cwd:f.root,models:models()});t.after(()=>next.close());await next.start();
 assert.equal((await next.handoffObservation()).coverage,'unknown');
});

test('paused queue and future schedule remain durable work after fence',async t=>{
 const f=await fixture(t);const {thread}=await f.engine.request('thread/start',{model:piModel('faux','faux-1')},client);
 await f.engine.request('turn/interrupt',{threadId:thread.id},client);
 await f.engine.request('thread/queue/add',{threadId:thread.id,clientUserMessageId:'queued',input:[{type:'text',text:'later'}]},client);
 const before=await f.engine.request('thread/queue/list',{threadId:thread.id},client);assert.equal(before.data.length,1);
 await f.authority.fence(expected(f.authority));
 const observed=await f.engine.handoffObservation();assert.equal(observed.coverage,'complete');assert.ok(observed.activeCount!>0);
 await assert.rejects(f.authority.release(expected(f.authority),()=>observed,async()=>{}),/not drained/);
 await new Promise(r=>setTimeout(r,100));
 const snapshot=(await import('../../plugins/pi-engine/src/read-history.js')).readPiSnapshot;
 const native=await snapshot(join(f.root,'pi',thread.id+'.sqlite'),join(f.root,'read'));
 assert.equal(native.queue?.items.length,1);assert.equal(native.submissions.length,0);
});

test('OS unknown and extra background process cannot release a Pi owner',async t=>{
 const f=await fixture(t);const owner=new PiOwnerHandoff(f.root,{entry:'test'},()=>({coverage:'unknown',activeCount:null}));await owner.load();
 // This in-process fixture supplies an idle native owner, but not an OS proof.
 owner.attach(f.engine,{consumerObservation:()=>({coverage:'complete',activeCount:0}),close:()=>f.engine.close()},[]);
 await owner.control('fence',expected(owner.authority));
 assert.equal((await owner.inspect()).coverage,'unknown');
 await assert.rejects(owner.control('release',expected(owner.authority)),/not drained/);
 assert.equal(owner.authority.snapshot().phase,'fenced');
});

test('in-flight private tool retains native occupancy through fence',async t=>{
 const {fauxToolCall}=await import('@earendil-works/pi-ai/providers/faux');
 const f=await fixture(t,[fauxAssistantMessage([fauxToolCall('opencraft_0_effect',{value:'once'})],{stopReason:'toolUse'}),fauxAssistantMessage('done')]);
 let release!:(value:any)=>void,entered!:()=>void;
 const ready=new Promise<void>(r=>{entered=r;});let effects=0;
 const tools={notify(){},request:async()=>{entered();return new Promise(r=>{release=(value:any)=>{effects++;r(value);};});}};
 const {thread}=await f.engine.request('thread/start',{model:piModel('faux','faux-1'),dynamicTools:[{name:'effect',description:'once',inputSchema:{type:'object',properties:{value:{type:'string'}}}}]},tools);
 await f.engine.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'effect'}]},tools);await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('Tool not reached')),15000))]);
 await f.authority.fence(expected(f.authority));const occupied=await f.engine.handoffObservation();assert.ok(occupied.activeCount!>0);
 await assert.rejects(f.authority.release(expected(f.authority),()=>occupied,async()=>{}),/not drained/);
 release({success:true,contentItems:[{type:'inputText',text:'done'}]});
 await until(async()=>(await f.engine.handoffObservation()).activeCount===0);assert.equal(effects,1);
});

test('future schedule is retained after fence and cannot start',async t=>{
 const f=await fixture(t);const {thread}=await f.engine.request('thread/start',{model:piModel('faux','faux-1')},client);
 await f.engine.request('opencraft/schedules/save',{threadId:thread.id,expectedRevision:0,nextRunAt:Date.now()+3600000,intervalMinutes:null,timeZone:'UTC',prompt:'later',permissions:'opencraft:permission-mode:full'},client);
 await f.authority.fence(expected(f.authority));const observed=await f.engine.handoffObservation();assert.equal(observed.coverage,'complete');assert.ok(observed.activeCount!>0);
 await assert.rejects(f.authority.release(expected(f.authority),()=>observed,async()=>{}),/not drained/);
});

test('unknown aggregate IM custody survives restart and never repeats the send',async t=>{
 const {PiRemoteInputs}=await import('../../scripts/server-deployment/pi-remote-inputs.mjs');const f=await fixture(t);let sends=0,receipt:any=null;
 const owners=new Map([['acp',{submit:async()=>{sends++;throw Error('HTTP outcome unknown');},receipt:async()=>receipt}]]);
 const admission={open:()=>true,run:async(run:any)=>run()};const custody=new PiRemoteInputs(join(f.root,'pi'),owners,admission);await custody.load();
 await assert.rejects(custody.submit('acp_one','actor-input:one','private',async()=>true),/unknown/);assert.equal(custody.observation().coverage,'unknown');
 const next=new PiRemoteInputs(join(f.root,'pi'),owners,admission);await next.load();assert.equal(next.observation().coverage,'unknown');
 assert.equal((await next.submit('acp_one','actor-input:one','private',async()=>true))?.state,'unknown');assert.equal(sends,1);
 receipt={state:'delivered',turnId:'native-one'};assert.equal((await next.receipt('acp_one','actor-input:one')).turnId,'native-one');
 assert.equal(next.observation().coverage,'complete');
 const cold=new PiRemoteInputs(join(f.root,'pi'),owners,admission);await cold.load();assert.equal(cold.observation().activeCount,0);
});

test('5000 normal consumer completions retain zero occupancy',async t=>{
 const {startEngineHost}=await import('../../apps/local-agent-host/src/engine-host.js');const {WebSocket}=await import('ws');
 let emit!:(method:string,params:any)=>void;
 const provider:any={id:'acp',label:'fixture',threadPrefix:'acp_',modelPrefix:'acp:',ownsThread:()=>true,ownsModel:()=>true,request:async()=>({}),disconnect(){},close:async()=>{},subscribe:(listener:any)=>{emit=listener;return()=>{};}};
 const host=await startEngineHost({providers:[provider],defaultEngine:'acp'});t.after(()=>host.close());
 const socket=new WebSocket(host.websocketUrl);await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});t.after(()=>socket.close());
 for(let n=0;n<5000;n++){emit('turn/started',{threadId:'acp_fixture',turn:{id:String(n),status:'inProgress'}});emit('turn/completed',{threadId:'acp_fixture',turn:{id:String(n),status:'completed'}});}
 assert.deepEqual(host.consumerObservation(),{coverage:'complete',activeCount:0});
});

test('fenced shell monitor retains its event without creating a native input; Stop reconciles it',async t=>{
 const {fauxToolCall}=await import('@earendil-works/pi-ai/providers/faux');const {readPiSnapshot}=await import('../../plugins/pi-engine/src/read-history.js');
 const f=await fixture(t);const command=`while [ ! -e '${f.root}/monitor-gate' ]; do sleep .05; done; printf 'READY\\n'; sleep .2; printf 'DONE\\n'`;
 // Use the fixture runtime's configured provider without replacing its engine.
 const m=models([fauxAssistantMessage(fauxToolCall('interactive_shell',{command,mode:'monitor',monitor:{strategy:'stream',triggers:[{id:'ready',literal:'READY'}]}}),{stopReason:'toolUse'}),fauxAssistantMessage('monitor started')]);
 const authority=f.authority;await f.engine.close();
 const engine=new PiEngine({directory:join(f.root,'monitor-pi'),dataDirectory:f.root,cwd:f.root,models:m,admission:{open:()=>authority.snapshot().phase==='open',run:authority.run.bind(authority)}});t.after(()=>engine.close());await engine.start();
 const {thread}=await engine.request('thread/start',{model:piModel('faux','faux-1')},client);
 await engine.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'monitor'}]},client);
 const snapshot=()=>readPiSnapshot(join(f.root,'monitor-pi',thread.id+'.sqlite'),join(f.root,'read'));
 await until(async()=>!!(await snapshot()).shell?.records.some(row=>row.state==='running'));
 await authority.fence(expected(authority));await writeFile(join(f.root,'monitor-gate'),'go');
 await until(async()=>!!(await snapshot()).shell?.records.some(row=>row.state==='completed'));
 const state=await snapshot();assert.equal(state.submissions.length,1);assert.ok(state.shell!.records.some(row=>row.monitorEvents?.length));
 assert.ok((await engine.handoffObservation()).activeCount!>0);
 await engine.request('turn/interrupt',{threadId:thread.id},client);
 assert.equal((await snapshot()).submissions.length,1);assert.ok((await snapshot()).shell!.records.every(row=>!row.monitorEvents?.length));await engine.close();
});

test('platform tool timeout remains unknown after the native request settles',async t=>{
 const {startEngineHost}=await import('../../apps/local-agent-host/src/engine-host.js');const {WebSocket}=await import('ws');
 const provider:any={id:'acp',label:'fixture',threadPrefix:'acp_',modelPrefix:'acp:',ownsThread:()=>true,ownsModel:()=>true,subscribe:()=>()=>{},disconnect(){},close:async()=>{},
 request:async(method:string,_params:any,owner:any)=>method==='thread/start'?{thread:{id:'acp_tool',status:{type:'idle'}}}:owner.request('item/tool/call',{threadId:'acp_tool',turnId:'one'})};
 const host=await startEngineHost({providers:[provider],defaultEngine:'acp'});t.after(()=>host.close());const socket=new WebSocket(host.websocketUrl);t.after(()=>socket.close());
 await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
 const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();let seq=0,toolReached!:()=>void;
 const tool=new Promise<void>(r=>{toolReached=r;});
 socket.on('message',data=>{const frame=JSON.parse(String(data));if(frame.method){toolReached();return;}const call=pending.get(frame.id);if(call){pending.delete(frame.id);frame.error?call.reject(Error(frame.error.message)):call.resolve(frame.result);}});
 const rpc=(method:string,params:any)=>{const id=++seq;const result=new Promise((resolve,reject)=>pending.set(id,{resolve,reject}));socket.send(JSON.stringify({jsonrpc:'2.0',id,method,params}));return result;};
 await rpc('thread/start',{});t.mock.timers.enable({apis:['setTimeout']});
 const running=rpc('turn/start',{threadId:'acp_tool'});const rejected=assert.rejects(running,/timed out/);await tool;t.mock.timers.tick(120000);await rejected;t.mock.timers.reset();
 assert.equal(host.consumerObservation().coverage,'unknown');
});


test('private capability transport failure stays unknown after native settlement and cold read',async t=>{
 const {fauxToolCall}=await import('@earendil-works/pi-ai/providers/faux');let calls=0;
 const f=await fixture(t,[fauxAssistantMessage(fauxToolCall('opencraft_host_private_effect',{}),{stopReason:'toolUse'}),fauxAssistantMessage('tool failed')],{
  tools:()=>[{name:'private_effect',description:'isolated transport',inputSchema:{type:'object'}}],
  call:async()=>{calls++;throw Error('Synthetic private HTTP outcome unknown');},
 });
 const {thread}=await f.engine.request('thread/start',{model:piModel('faux','faux-1')},client);
 await f.engine.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'private effect'}]},client);
 await until(async()=>calls===1&&(await f.engine.request('thread/read',{threadId:thread.id},client)).thread.status.type==='idle');
 await f.authority.fence(expected(f.authority));
 assert.equal((await f.engine.handoffObservation()).coverage,'unknown');
 await f.engine.close();const cold=new PiEngine({directory:join(f.root,'pi'),dataDirectory:f.root,cwd:f.root,models:models(),admission:{open:()=>false,run:f.authority.run.bind(f.authority)}});t.after(()=>cold.close());await cold.start();
 assert.equal((await cold.handoffObservation()).coverage,'unknown');await cold.close();assert.equal(calls,1);
});
