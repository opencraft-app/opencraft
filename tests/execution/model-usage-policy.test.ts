import { AcpEngine } from '../../plugins/acp-engine/src/index.js';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { ModelPolicyStore,assertModelPolicy,projectModels,createDshPolicyBoundary } from '@opencraft/model-usage-policy';
import { modelPolicyHttp } from '@opencraft/model-usage-policy/http';
import { ModelPolicyTransport } from '@opencraft/model-usage-policy/transport';
import { PiEngine,piModel } from '../../plugins/pi-engine/src/index.js';
import { createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
const client={notify(){},async request(){throw Error('Unexpected tool');}};
async function fixture(t:test.TestContext){const root=await mkdtemp(join(tmpdir(),'model-policy-'));const path=join(root,'policy.sqlite');const store=new ModelPolicyStore(path);t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});return {root,path,store};}
test('policy CAS and audit survive reopening; malformed rules and stale writes leave no audit',async t=>{
 const f=await fixture(t);f.store.write(0,[{engine:'codex',effort:'ultra'}],'actor:admin');
 assert.throws(()=>f.store.write(0,[],'other'),/revision_conflict/);assert.equal(f.store.audit().length,1);
 assert.throws(()=>f.store.write(1,[{engine:'unknown',model:'x'}],'a'),/invalid/);
 assert.throws(()=>assertModelPolicy(f.path,'codex','gpt','ultra',[{model:'gpt',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]),e=>(e as any).data.alternatives[0]==='high');
 assert.equal(assertModelPolicy(f.path,'codex','gpt','high'),1);
 const second=new ModelPolicyStore(f.path);assert.deepEqual(second.read(),f.store.read());second.close();
 assert.throws(()=>assertModelPolicy(join(f.root,'missing'),'pi','x'),/unavailable/);
});
test('admin HTTP rejects members and revoked identity; audit records authenticated actor',async t=>{
 const f=await fixture(t);let role='member';const handle=modelPolicyHttp(f.store,()=>({actor:'server-actor',administrator:role==='admin',origin:null}));
 const server=createServer((req,res)=>void handle(req,res));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 const url=`http://127.0.0.1:${(server.address() as any).port}`;
 const write=()=>fetch(url+'/__opencraft_model_policy',{method:'POST',headers:{origin:url,'content-type':'application/json'},body:JSON.stringify({revision:0,rules:[{engine:'pi',model:'pi:faux:faux-1'}]})});
 assert.deepEqual(await (await fetch(url+'/__opencraft_model_policy')).json(),{canManage:false});assert.equal((await write()).status,403);
 role='admin';assert.equal((await write()).status,200);assert.equal(f.store.audit()[0].actor,'server-actor');
 assert.equal((await write()).status,409);assert.equal(f.store.audit().length,1);
});
test('gateway rejects webpage/API/IM/orchestration/goal requests and queue dispatch before forwarding',async t=>{
 const f=await fixture(t);f.store.write(0,[{engine:'codex',model:'blocked'}],'admin');
 const received:any[]=[];let listener:(s:string)=>void=()=>{};
 const inner:any={status:{state:'open'},connect:async()=>{},close:async()=>{},subscribeStatus:()=>()=>{},subscribeMessage:(fn:any)=>{listener=fn;return()=>{};},async send(frame:string){const m=JSON.parse(frame);received.push(m);if(String(m.id).startsWith('model-policy:'))listener(JSON.stringify({id:m.id,result:m.method==='thread/read'?{thread:{model:'blocked',reasoningEffort:'high'}}:{data:[{model:'allowed',defaultReasoningEffort:'high'}]}}));}};
 const gateway=new ModelPolicyTransport(inner,f.path);const replies:any[]=[];gateway.subscribeMessage(s=>replies.push(JSON.parse(s)));t.after(()=>gateway.close());
 for(const source of ['web','api','im','orchestration','goal'])for(const method of ['turn/start','turn/steer','thread/queue/start','thread/queue/steer'])await gateway.send(JSON.stringify({id:source+method,method,params:{threadId:'t'}}));
 await gateway.send(JSON.stringify({id:'collaboration',method:'turn/start',params:{threadId:'t',model:'allowed',collaborationMode:{mode:'default',settings:{model:'blocked',reasoning_effort:'high'}}}}));
 assert.equal(replies.length,21);assert.ok(replies.every(r=>r.error.data.code==='model_usage_restricted'&&r.error.data.alternatives.includes('allowed')));
 assert.ok(received.every(m=>String(m.id).startsWith('model-policy:')));
});
test('DSH resolved native boundary covers goal and queued turns, keeps running turn, catches changed model',async t=>{
 const f=await fixture(t),gate=createDshPolicyBoundary(f.path),session={};const config={provider:'p',model:'m',reasoningEffort:'high'};
 await gate.admit(session,1,config);f.store.write(0,[{engine:'dsh',model:'dsh-model:p:m'}],'admin');
 await gate.admit(session,1,config);await assert.rejects(gate.admit(session,2,config),/Contact/);
 for(const next of ['goal','queue','resume'])await assert.rejects(gate.admit({source:next},2,config),/Contact/);
 await gate.admit(session,1,{...config,model:'m2'});
});
test('Pi direct Turn and automatic queue admission re-read policy after thread creation',async t=>{
 const f=await fixture(t),faux=fauxProvider({tokensPerSecond:10000});faux.setResponses([]);const runtime=createModels();runtime.setProvider(faux.provider);
 const models=Object.assign(runtime,{getAvailableSnapshot:()=>faux.models}) as any;
 const pi=new PiEngine({directory:join(f.root,'pi'),cwd:f.root,models,modelPolicyPath:f.path});t.after(()=>pi.close());
 const {thread}=await pi.request('thread/start',{model:piModel('faux','faux-1'),cwd:f.root},client);
 f.store.write(0,[{engine:'pi',model:piModel('faux','faux-1')}],'admin');
 await assert.rejects(pi.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'blocked'}]},client),/Contact|restricted/);
 const session=(pi as any).sessions.get(thread.id);let claimed=false;const native=await (pi as any).native(session);const original=native.claimQueue;native.claimQueue=async()=>{claimed=true;};
 await assert.rejects((pi as any).dispatchQueue(session),/Contact|restricted/);assert.equal(claimed,false);native.claimQueue=original;
 await pi.request('thread/queue/add',{threadId:thread.id,clientUserMessageId:'queued-blocked',input:[{type:'text',text:'queued'}]},client);
 await new Promise(r=>setTimeout(r,100));
 const queue=await pi.request('thread/queue/list',{threadId:thread.id},client);
 assert.equal(queue.data.length,1);assert.equal(queue.data[0].pausedReason,'model-restricted');
 assert.equal((await pi.request('thread/read',{threadId:thread.id,includeTurns:true},client)).thread.turns.length,0);
});
test('directory removes banned models and efforts without changing saved defaults',async t=>{
 const f=await fixture(t);f.store.write(0,[{engine:'codex',model:'b'},{engine:'codex',effort:'ultra'}],'admin');
 const data=projectModels(f.path,'codex',[{model:'b'},{model:'a',defaultReasoningEffort:'ultra',supportedReasoningEfforts:[{reasoningEffort:'high'},{reasoningEffort:'ultra'}]}]);
 assert.equal(data[0].hidden,true);assert.deepEqual(data[1].supportedReasoningEfforts,[{reasoningEffort:'high'}]);assert.equal(data[1].defaultReasoningEffort,'ultra');
});

test('ACP actual native default and catalog are enforced for API, IM and continuation',async t=>{
 for(const id of ['acp','dsh-acp'] as const){
  const f=await fixture(t),trace=join(f.root,'trace');
  const acp=new AcpEngine({id,command:process.execPath,args:[resolve('tests/fixtures/acp-engine-peer.mjs')],cwd:f.root,dataDirectory:join(f.root,'acp'),modelPolicyPath:f.path,env:{ACP_TEST_MODELS:'1',ACP_TEST_TRACE:trace}});t.after(()=>acp.close());
  const {thread}=await acp.request('thread/start',{},client);
  assert.equal(thread.model,id+':default-native');assert.equal((await acp.request('model/list',{},client)).data.length,2);
  f.store.write(0,[{engine:id,model:id+':default-native'}],'admin');
  await assert.rejects(acp.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'blocked'}]},client),/restricted/);
  await assert.rejects(acp.inputs.submit(thread.id,'im-blocked','blocked',()=>true),/restricted/);
  assert.ok(!(await readFile(trace,'utf8')).includes('session/prompt'));
  assert.equal(await acp.inputs.receipt(thread.id,'im-blocked'),null);
 }
});

async function untilPolicy(check:()=>Promise<boolean>,label:string){const until=Date.now()+8000;while(!await check()){if(Date.now()>until)throw Error(label);await new Promise(r=>setTimeout(r,20));}}
test('Pi validates config reasoning overrides after native thinking resolution',async t=>{
 const f=await fixture(t),faux=fauxProvider();(faux.models[0] as any).reasoning=true;const runtime=createModels();runtime.setProvider(faux.provider);
 const pi=new PiEngine({directory:join(f.root,'pi'),cwd:f.root,models:Object.assign(runtime,{getAvailableSnapshot:()=>faux.models}) as any,modelPolicyPath:f.path});t.after(()=>pi.close());
 const {thread}=await pi.request('thread/start',{model:piModel('faux','faux-1'),effort:'medium',cwd:f.root},client);
 f.store.write(0,[{engine:'pi',effort:'high'}],'admin');
 await assert.rejects(pi.request('turn/start',{threadId:thread.id,config:{model_reasoning_effort:'high'},input:[{type:'text',text:'blocked'}]},client),/restricted/);
 assert.equal((await pi.request('thread/read',{threadId:thread.id},client)).thread.reasoningEffort,'medium');
 assert.equal(faux.state.callCount,0);
});
test('Pi detached shell completion after restriction retains input and never wakes a new model round',async t=>{
 const f=await fixture(t),faux=fauxProvider({tokensPerSecond:100000});
 faux.setResponses([fauxAssistantMessage(fauxToolCall('bash',{command:'sleep 2; printf shell-result',yield_time_ms:20}),{stopReason:'toolUse'}),fauxAssistantMessage('background running'),fauxAssistantMessage('must not run')]);
 const runtime=createModels();runtime.setProvider(faux.provider);
 const pi=new PiEngine({directory:join(f.root,'pi'),cwd:f.root,models:Object.assign(runtime,{getAvailableSnapshot:()=>faux.models}) as any,modelPolicyPath:f.path});t.after(()=>pi.close());
 const {thread}=await pi.request('thread/start',{model:piModel('faux','faux-1'),cwd:f.root},client);
 await pi.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'run background'}]},client);
 const session=(pi as any).sessions.get(thread.id),native=await (pi as any).native(session);
 await untilPolicy(async()=>faux.state.callCount===2&&!(await native.snapshot()).live.run,'initial round completion');
 f.store.write(0,[{engine:'pi',model:piModel('faux','faux-1')}],'admin');
 await untilPolicy(async()=>(await native.snapshot()).shell.records.some((r:any)=>r.state==='completed'),'shell completion');
 await new Promise(r=>setTimeout(r,100));
 assert.equal(faux.state.callCount,2);const snapshot=await native.snapshot();
 assert.notEqual(snapshot.shell.records[0].notified,true);assert.equal(snapshot.submissions.filter((s:any)=>s.requestId?.startsWith('pi-shell:')).length,0);
});

test('ACP config updates while idle are authoritative and cold model selection resumes first with native config id',async t=>{
 const f=await fixture(t),options={command:process.execPath,args:[resolve('tests/fixtures/acp-engine-peer.mjs')],cwd:f.root,dataDirectory:join(f.root,'acp'),modelPolicyPath:f.path,env:{ACP_TEST_MODELS:'1',ACP_TEST_MODEL_CONFIG_ID:'model-selector'}};
 const acp=new AcpEngine(options);t.after(()=>acp.close());
 const {thread}=await acp.request('thread/start',{},client);const nativeId=(acp as any).sessions.get(thread.id).nativeId;
 f.store.write(0,[{engine:'acp',model:'acp:blocked-native'}],'admin');
 await (acp as any).transport.request('fixture/modelUpdate',{sessionId:nativeId});
 assert.equal((await acp.request('thread/read',{threadId:thread.id},client)).thread.model,'acp:blocked-native');
 await assert.rejects(acp.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'blocked'}]},client),/restricted|Contact/);
 await acp.close();
 const restored=new AcpEngine(options);t.after(()=>restored.close());
 const result=await restored.request('turn/start',{threadId:thread.id,model:'acp:allowed-native',input:[{type:'text',text:'cold selection'}]},client);
 assert.equal(result.turn.status,'inProgress');
 assert.equal((await restored.request('thread/read',{threadId:thread.id},client)).thread.model,'acp:allowed-native');
 await restored.close();
});
