import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {CodexEngineAdapter} from '../../apps/opencraft-daemon/src/codex-engine-adapter';
import {THREAD_DEFAULTS_SCOPE,THREAD_DEFAULTS_WRITE,THREAD_DEFAULTS_READ,THREAD_DEFAULTS_CAPABILITY} from '@opencraft/appserver-protocol/collaboration';
import {ModelPolicyStore} from '@opencraft/model-usage-policy';
const bundle={permissionMode:'accept-edits',mode:'plan',model:'gpt-6.1-sol',reasoningEffort:'medium'};
async function fixture(t:test.TestContext){
 const root=await mkdtemp('/tmp/oc-defaults-host-');let current=true;const calls:any[]=[];const diagnostics:any[]=[];
 const policy=new ModelPolicyStore(join(root,'policy.sqlite'));
 const adapter=new CodexEngineAdapter({logDiagnostic:event=>diagnostics.push(event),executable:process.execPath,runtimeDirectory:root,dataDirectory:join(root,'data'),nativeCodexHomeDirectory:join(root,'native'),upstreamBaseUrl:'http://127.0.0.1:9/local-stub',fetch:async()=>Response.json({ok:true}),modelPolicyPath:join(root,'policy.sqlite'),
  spawnAppServer:({cwd,env})=>spawn(process.execPath,[new URL('../fixtures/fake-codex-stdio-appserver.mjs',import.meta.url).pathname],{cwd,env:{...env,OPENCRAFT_TEST_MODEL_SETTINGS:'1',OPENCRAFT_TEST_THREAD_DEFAULTS:'1',OPENCRAFT_TEST_NO_SERVER_REQUEST:'1',OPENCRAFT_TEST_UNIQUE_THREADS:'1'},stdio:['pipe','pipe','pipe']}),
  createMaintenanceClient:async()=>{throw Error('not used');},collaboration:{serverId:'server',started(){},continued(){},authorize(){},assertThreadDefaults(context){assert.equal(current,true);assert.equal(context.actorId,'synthetic-human');},async command(){return{};},async tool(){return null;}}});
 const pending=new Map<string,(v:any)=>void>();let sequence=0;adapter.subscribeMessage(raw=>{const packet=JSON.parse(raw);if(packet.id&&!packet.method)pending.get(String(packet.id))?.(packet);});
 const context={sender:null,actorContext:{actorId:'synthetic-human',generation:1,credentialId:null,expiresAt:Date.now()+60000},resourceOwner:{id:'synthetic',assertCurrent(){assert.equal(current,true);}}};
 const rpc=async(method:string,params:any={},trusted:any=context)=>{const id=String(++sequence);let timer:NodeJS.Timeout;
  const response=new Promise<any>((resolve,reject)=>{pending.set(id,resolve);timer=setTimeout(()=>reject(Error('synthetic RPC timeout '+method)),15000);});
  try{await adapter.sendWithContext(JSON.stringify({id,method,params,__opencraftClient:'human'}),trusted);return await response;}finally{clearTimeout(timer!);pending.delete(id);}};
 await adapter.connect();const init=await rpc('initialize',{clientInfo:{name:'defaults-fixture',version:'1'},capabilities:{experimentalApi:true}});assert.equal(init.result.capabilities.extensions[THREAD_DEFAULTS_CAPABILITY].version,1);
 const threadId=(await rpc('thread/start',{cwd:root})).result.thread.id;
 t.after(async()=>{await adapter.close();policy.close();await rm(root,{recursive:true,force:true});});
 return {root,threadId,adapter,rpc,context,policy,diagnostics,set current(v:boolean){current=v;},async writes(){return (await rpc('test/defaultsWrites')).result.data;}};
}
test('real adapter Native ACK/read are distinct, and managed/raw model policy rejects before mutation',async t=>{
 const f=await fixture(t),params={threadId:f.threadId,scope:THREAD_DEFAULTS_SCOPE,bundle};
 await f.rpc('test/defaultsBehavior',{threadId:f.threadId,value:'ack-only'});const first=await f.rpc(THREAD_DEFAULTS_WRITE,params);assert.equal(first.error,undefined);assert.equal(first.result.requestState,'acknowledged');assert.equal(first.result.observation.mode,null);assert.notEqual(first.result.observation.model,bundle.model);
 await f.rpc('test/defaultsBehavior',{threadId:f.threadId,value:'normal'});const applied=await f.rpc(THREAD_DEFAULTS_WRITE,params);assert.equal(applied.result.observation.mode,'plan');assert.equal(applied.result.observation.model,bundle.model);assert.equal(applied.result.actualTurnSettings,null);
 const writes=await f.writes();assert.equal(writes.length,2);assert.equal(writes[1].collaborationMode.settings.developer_instructions,null);assert.equal(Object.hasOwn(writes[1],'model'),false);
 await f.rpc('test/defaultsRequirements',{value:{allowedSandboxModes:['read-only']}});assert.ok((await f.rpc(THREAD_DEFAULTS_WRITE,params)).error);assert.equal((await f.writes()).length,2);
 await f.rpc('test/defaultsRequirements',{value:null});
 await f.rpc('test/defaultsPermissionsAllowed',{value:false});assert.equal((await f.rpc(THREAD_DEFAULTS_WRITE,params)).error.data.code,'permission_mode_disallowed');assert.equal((await f.writes()).length,2);await f.rpc('test/defaultsPermissionsAllowed',{value:true});
 f.policy.write(0,[{engine:'codex',model:bundle.model}],'synthetic-admin');
 assert.ok((await f.rpc(THREAD_DEFAULTS_WRITE,params)).error);
 assert.ok((await f.rpc('thread/settings/update',{threadId:f.threadId,model:'gpt-6-luna',collaborationMode:{mode:'plan',settings:{model:bundle.model,reasoning_effort:bundle.reasoningEffort,developer_instructions:null}}})).error);assert.equal((await f.writes()).length,2);
 f.policy.write(1,[],'synthetic-admin');
 const observed=await f.rpc(THREAD_DEFAULTS_READ,{threadId:f.threadId});assert.equal(observed.result.mode,'plan');assert.equal((await f.writes()).length,2);
 f.current=false;assert.ok((await f.rpc(THREAD_DEFAULTS_WRITE,params)).error);
});
test('setter owns Thread operation until its Native ACK, so queued start cannot interleave',async t=>{
 const f=await fixture(t);
 await f.rpc('test/defaultsBehavior',{threadId:f.threadId,value:'hold'});
 const update=f.rpc(THREAD_DEFAULTS_WRITE,{threadId:f.threadId,scope:THREAD_DEFAULTS_SCOPE,bundle});
 // A protocol count read is a deterministic barrier: the setter has reached Native.
 for(let n=0;n<50;n++){if((await f.writes()).length===1)break;if(n===49)throw Error('setter not submitted');}
 const added=await f.rpc('thread/queue/add',{threadId:f.threadId,clientUserMessageId:'synthetic-queued',input:[{type:'text',text:'synthetic'}]});assert.equal(added.error,undefined);
 const row=(await f.rpc('thread/queue/list',{threadId:f.threadId})).result.data[0];assert.ok(row.id,'queue list contains only queued rows');
 const before=await f.rpc('test/readAcceptedInputs');assert.equal(before.result.data.length,0);
 await f.rpc('test/releaseDefaults',{threadId:f.threadId});assert.equal((await update).result.requestState,'acknowledged');
 for(let n=0;n<50;n++){if((await f.rpc('test/readAcceptedInputs')).result.data.length===1)break;if(n===49)throw Error('queue did not start');}
 assert.equal((await f.rpc('test/readAcceptedInputs')).result.data.length,1);
});

test('an explicit frozen settings read failure cannot dispatch as inherited defaults',async t=>{
 const f=await fixture(t);let reads=0;
 (f.adapter as any).options.collaborationInput={available:()=>true,mode:()=> 'queue',authorize:()=>true,settingsAvailable:()=>true,settings(){reads++;throw Error('synthetic settings store unavailable');}};
 const admitted={...f.context,collaborationRequestId:'synthetic-read-failure'};
 const added=await f.rpc('thread/queue/add',{threadId:f.threadId,clientUserMessageId:'actor-input:synthetic-read-failure',input:[{type:'text',text:'synthetic'}]},admitted);assert.equal(added.error,undefined);
 const start=await f.rpc('thread/queue/start',{threadId:f.threadId,queuedSubmissionId:added.result.queuedSubmission.id},admitted);assert.ok(start.error);assert.ok(reads>0);assert.equal((await f.rpc('test/readAcceptedInputs')).result.data.length,0);
});

test('raw and typed setters recheck the same model policy immediately before physical write',async t=>{
 const f=await fixture(t);f.policy.write(0,[{engine:'codex',model:'gpt-6-luna'}],'synthetic-admin');
 const adapter=f.adapter as any,check=adapter.checkModelPolicy.bind(adapter);let changed=false;
 adapter.checkModelPolicy=async(method:string,params:any)=>{const guard=await check(method,params);if(method==='thread/settings/update'&&guard&&!changed){changed=true;f.policy.write(1,[{engine:'codex',model:bundle.model}],'synthetic-admin');}return guard;};
 const result=await f.rpc(THREAD_DEFAULTS_WRITE,{threadId:f.threadId,scope:THREAD_DEFAULTS_SCOPE,bundle});assert.ok(result.error);assert.equal(changed,true);assert.equal((await f.writes()).length,0);
 const raw=await f.rpc('thread/settings/update',{threadId:f.threadId,collaborationMode:{mode:'plan',settings:{model:bundle.model,reasoning_effort:bundle.reasoningEffort,developer_instructions:null}}});assert.ok(raw.error);assert.equal((await f.writes()).length,0);
});
test('revocation while waiting for the Thread owner cannot authorize a second setter',async t=>{
 const f=await fixture(t);await f.rpc('test/defaultsBehavior',{threadId:f.threadId,value:'hold'});
 const params={threadId:f.threadId,scope:THREAD_DEFAULTS_SCOPE,bundle};const first=f.rpc(THREAD_DEFAULTS_WRITE,params);
 for(let n=0;n<50;n++){if((await f.writes()).length===1)break;if(n===49)throw Error('write not reached');}
 const second=f.rpc(THREAD_DEFAULTS_WRITE,params);f.current=false;
 await f.rpc('test/releaseDefaults',{threadId:f.threadId},{sender:null});assert.ok((await first).error);assert.ok((await second).error);
 const count=await f.rpc('test/defaultsWrites',{}, {sender:null});assert.equal(count.result.data.length,1);
});

test('cold defaults load the same Thread without overrides; observation and unknown never load or replay',async t=>{
 const f=await fixture(t),adapter=f.adapter as any,request=adapter.requestPhysical.bind(adapter);
 let cold=true,resumes=0,setters=0,loseAck=false;const resumeParams:any[]=[];
 adapter.requestPhysical=async(method:string,params:any,...args:any[])=>{
  if(method==='thread/resume'){resumes++;resumeParams.push(params);cold=false;}
  const result=await request(method,params,...args);
  if(method==='thread/read')return {...result,thread:{...result.thread,status:{type:cold?'notLoaded':'idle'}}};
  if(method==='thread/settings/update'){setters++;if(loseAck){loseAck=false;cold=true;throw Error('synthetic lost ACK');}}
  return result;
 };
 assert.equal((await f.rpc(THREAD_DEFAULTS_READ,{threadId:f.threadId})).result.source,'native/thread/read');assert.equal(resumes,0);assert.equal(setters,0);
 const params={threadId:f.threadId,scope:THREAD_DEFAULTS_SCOPE,bundle};
 assert.equal((await f.rpc(THREAD_DEFAULTS_WRITE,params)).result.requestState,'acknowledged');assert.deepEqual(resumeParams,[{threadId:f.threadId,excludeTurns:true}]);assert.equal(setters,1);
 assert.equal((await f.rpc(THREAD_DEFAULTS_WRITE,params)).result.requestState,'acknowledged');assert.equal(resumes,1);assert.equal(setters,2);
 loseAck=true;assert.equal((await f.rpc(THREAD_DEFAULTS_WRITE,params)).result.requestState,'unknown');assert.equal(resumes,1);assert.equal(setters,3);
 await f.rpc(THREAD_DEFAULTS_READ,{threadId:f.threadId});assert.equal(resumes,1);assert.equal(setters,3);
});

test('cold preparation revalidates resource authority and exact resume identity before the setter',async t=>{
 const f=await fixture(t),adapter=f.adapter as any,request=adapter.requestPhysical.bind(adapter);let behavior='wrong-thread',setters=0;
 adapter.requestPhysical=async(method:string,params:any,...args:any[])=>{
  if(method==='thread/settings/update')setters++;
  const result=await request(method,params,...args);
  if(method==='thread/read')return {...result,thread:{...result.thread,status:{type:'notLoaded'}}};
  if(method==='thread/resume'){
   if(behavior==='revoke')f.current=false;
   return {...result,thread:{...result.thread,id:behavior==='wrong-thread'?'other-thread':f.threadId}};
  }
  return result;
 };
 const params={threadId:f.threadId,scope:THREAD_DEFAULTS_SCOPE,bundle};
 assert.ok((await f.rpc(THREAD_DEFAULTS_WRITE,params)).error);assert.equal(setters,0);
 behavior='revoke';assert.ok((await f.rpc(THREAD_DEFAULTS_WRITE,params)).error);assert.equal(setters,0);
});

test('typed defaults real adapter reports a lost ACK safely under the same transient trace without replay',async t=>{
 const f=await fixture(t),adapter=f.adapter as any,request=adapter.requestPhysical.bind(adapter);let writes=0;
 const secret='SYNTHETIC_PRIVATE_body_path_principal_execution_key';
 adapter.requestPhysical=async(method:string,...args:any[])=>{const result=await request(method,...args);if(method==='thread/settings/update'){writes++;throw Object.assign(Error(secret),{code:-32000,data:{body:secret},stack:secret});}return result;};
 const traceId='c29d192f-bd96-4b7d-b5d5-9ac5676bcece';
 const result=await f.rpc(THREAD_DEFAULTS_WRITE,{threadId:f.threadId,scope:THREAD_DEFAULTS_SCOPE,bundle},{...f.context,controlObservation:{traceId,control:'thread-defaults'}});
 assert.equal(result.result.requestState,'unknown');assert.equal(writes,1);
 const events=f.diagnostics.filter(e=>e.event==='conversation-control');assert.equal(events.length,1);assert.equal(events[0].traceId,traceId);assert.equal(events[0].rpcCode,-32000);assert.equal(events[0].phase,'defaults-write');
 assert.equal(JSON.stringify(events).includes(secret),false);assert.equal(JSON.stringify(events).includes(f.threadId),false);assert.equal(JSON.stringify(events).includes(f.context.actorContext.actorId),false);
 await f.rpc(THREAD_DEFAULTS_READ,{threadId:f.threadId});assert.equal(writes,1);assert.equal(f.diagnostics.filter(e=>e.event==='conversation-control').length,1);
});
