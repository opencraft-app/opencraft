import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {LOGICAL_CLIENT_FIELD} from '@opencraft/app-host-protocol';
import {CodexEngineAdapter} from '../../apps/opencraft-daemon/src/codex-engine-adapter.js';
import {ExecutionEnvironmentRuntime} from '@opencraft/execution-environment';
import {AccountEnvironment} from '@opencraft/execution-environment/account-environment';
import {EmployeeGitVaultStore} from '@opencraft/execution-environment/employee-git-vault-store';

async function sharedCredentialAdapter(t:test.TestContext) {
  const root=await mkdtemp(join(tmpdir(),'native-control-model-'));
  const frames:any[]=[],writes:any[]=[];
  const vault=await EmployeeGitVaultStore.open(root),runtime=new ExecutionEnvironmentRuntime(root,vault);
  for(const user of ['alice','bob']) new AccountEnvironment(vault).replace('employee:'+user,{projectId:null},0,[{name:'SERVICE_KEY',value:'synthetic-'+user,secret:true}]);
  const adapter=new CodexEngineAdapter({executable:process.execPath,runtimeDirectory:root,dataDirectory:join(root,'codex'),nativeCodexHomeDirectory:join(root,'native'),
    upstreamBaseUrl:'http://127.0.0.1:9/backend-api/codex',fetch:async()=>Response.json({ok:true}),
    executionEnvironment:runtime,sharedTurnInput:true,
    spawnAppServer:({cwd,env})=>spawn(process.execPath,[new URL('../fixtures/fake-codex-stdio-appserver.mjs',import.meta.url).pathname],{cwd,env:{...env,OPENCRAFT_TEST_NATIVE_QUEUE_STEER:'2',OPENCRAFT_TEST_UNLOAD_ON_UNSUBSCRIBE:'1'},stdio:['pipe','pipe','pipe']}),
    createMaintenanceClient:async()=>{throw Error('not used')}});
  const internal=adapter as any;adapter.subscribeMessage(frame=>frames.push(JSON.parse(frame)));
  const write=internal.writePhysical.bind(internal);internal.writePhysical=async(message:any,...args:any[])=>{writes.push(structuredClone(message));return write(message,...args)};
  const wait=async(id:string)=>{const deadline=Date.now()+10000;for(;;){const result=frames.find(row=>row.id===id);if(result)return result;if(Date.now()>deadline)throw Error('fixture reply timed out: '+id);await new Promise(resolve=>setTimeout(resolve,10))}};
  let sequence=0;
  const request=async(method:string,params:Record<string,unknown>,user:string|null=null)=>{const id='model:'+(++sequence);await adapter.sendWithContext(JSON.stringify({id,method,params,[LOGICAL_CLIENT_FIELD]:'viewer'}),{sender:null,...(user?{executionPrincipal:{provider:'employee',subject:user},validUntil:Date.now()+60000}:{})});return wait(id)};
  t.after(async()=>{await adapter.close();runtime.close();vault.close();await rm(root,{recursive:true,force:true})});
  await adapter.connect();await request('initialize',{});
  return {request,internal,runtime,frames,writes,root};
}

test('shared direct and queued steer survive loss of Gateway ENV/active-Turn caches without transferring execution', async t => {
  const f=await sharedCredentialAdapter(t);
  const threadId=(await f.request('thread/start',{cwd:f.root,testNoServerRequest:true},'alice')).result.thread.id;
  const started=await f.request('turn/start',{threadId,input:[{type:'text',text:'alice work'}],clientUserMessageId:'owner-input'},'alice');
  const turnId=started.result.turn.id;
  const queued=await f.request('thread/queue/add',{threadId,input:[{type:'text',text:'bob queued'}],clientUserMessageId:'bob-queued-control'},'bob');
  const before=f.writes.filter(row=>row.method==='thread/resume'&&row.params.config).length;
  f.internal.executionEnvironments.clear();f.internal.initialEnvironmentThreads.clear();f.internal.activeTurns.clear();
  f.internal.executionLeases.suspend();await f.internal.reconcileExecutionLeases();
  const nativeLeases=f.internal.hostState.database.prepare('SELECT execution_id, input_id,generation FROM execution_leases WHERE thread_id=? AND turn_id=?').all(threadId,turnId);
  const direct=await f.request('turn/steer',{threadId,expectedTurnId:turnId,input:[{type:'text',text:'bob control'}],clientUserMessageId:'bob-control'},'bob');
  assert.ok(direct.result,JSON.stringify(direct.error));
  const steered=await f.request('thread/queue/steer',{threadId,expectedTurnId:turnId,queuedSubmissionId:queued.result.queuedSubmission.id},'bob');
  assert.ok(steered.result,JSON.stringify(steered.error));
  assert.equal(f.internal.executionEnvironments.size,0,'control never repairs/reinstalls ENV from the viewer');
  assert.equal(f.writes.filter(row=>row.method==='thread/resume'&&row.params.config).length,before);
  assert.deepEqual(f.internal.hostState.database.prepare('SELECT execution_id,input_id,generation FROM execution_leases WHERE thread_id=? AND turn_id=?').all(threadId,turnId),nativeLeases);
  assert.equal(f.internal.executionLeases.getSubmission(threadId,'owner-input').principal.subject,'alice');
  assert.equal(f.internal.executionLeases.getSubmission(threadId,'bob-queued-control').principal.subject,'bob');
  const shell=await f.request('thread/shellCommand',{threadId,command:'must-not-run'},'bob');
  assert.equal(shell.error.data.notSubmitted,true);assert.equal(f.writes.some(row=>row.method==='thread/shellCommand'),false);
});

for(const phase of ['idle','active','native-unattributed'] as const) test(`Goal control uses native intent, not ENV ownership (${phase})`,async t=>{
  const f=await sharedCredentialAdapter(t);
  const threadId=(await f.request('thread/start',{cwd:f.root,testNoServerRequest:true},'alice')).result.thread.id;
  if(phase!=='idle') assert.ok((await f.request('turn/start',{threadId,input:[{type:'text',text:'work'}],clientUserMessageId:'goal-base'},'alice')).result);
  f.internal.executionEnvironments.clear();f.internal.initialEnvironmentThreads.clear();
  if(phase==='native-unattributed') f.internal.executionLeases.observedStart(threadId,'native-goal-continuation');
  const before=f.writes.filter(row=>row.method==='thread/resume'&&row.params.config).length;
  const provenance=f.internal.hostState.database.prepare('SELECT * FROM execution_submissions WHERE thread_id=?').all(threadId);
  for(const change of [{objective:'edited intention'}, {status:'paused'},{status:'active'},{status:'complete'}]) {
    const result=await f.request('thread/goal/set',{threadId,...change,expectedVersion:'native-version'},'bob');
    assert.ok(result.result,JSON.stringify(result.error));
    assert.deepEqual(f.writes.filter(row=>row.method==='thread/goal/set').at(-1).params,{threadId,...change,expectedVersion:'native-version'});
  }
  assert.ok((await f.request('thread/goal/clear',{threadId,expectedVersion:'native-version'},'bob')).result);
  assert.equal(f.internal.executionEnvironments.size,0);
  assert.equal(f.writes.filter(row=>row.method==='thread/resume'&&row.params.config).length,before);
  assert.deepEqual(f.internal.hostState.database.prepare('SELECT * FROM execution_submissions WHERE thread_id=?').all(threadId),provenance,'Goal editor does not acquire execution credentials');
  const anonymous=await f.request('thread/goal/set',{threadId,objective:'denied'});
  assert.equal(anonymous.error.data.notSubmitted,true);
});

test('native control read failure is not an account mismatch and leaves queued custody unchanged',async t=>{
  const f=await sharedCredentialAdapter(t);
  const threadId=(await f.request('thread/start',{cwd:f.root,testNoServerRequest:true},'alice')).result.thread.id;
  const started=await f.request('turn/start',{threadId,input:[{type:'text',text:'work'}],clientUserMessageId:'owner'},'alice');
  const queued=await f.request('thread/queue/add',{threadId,input:[{type:'text',text:'pending'}],clientUserMessageId:'queued'},'bob');
  f.internal.executionEnvironments.clear();
  const original=f.internal.requestPhysical.bind(f.internal);
  f.internal.requestPhysical=async(method:string,...args:unknown[])=>{if(method==='thread/turns/list')throw Error('private native failure');return original(method,...args)};
  const result=await f.request('thread/queue/steer',{threadId,expectedTurnId:started.result.turn.id,queuedSubmissionId:queued.result.queuedSubmission.id},'bob');
  assert.deepEqual(result.error.data,{code:'EXECUTION_CONTROL_UNAVAILABLE',reason:'native-unavailable',notSubmitted:true,submissionOutcome:'rejected',retryable:true});
  assert.ok(!JSON.stringify(result).includes('private native failure'));
  assert.equal(f.internal.queueStore().find(threadId,queued.result.queuedSubmission.id).state,'queued');
  assert.equal(f.writes.some(row=>row.method==='turn/steer'),false);
});

test('shared Turn control is an explicit trusted policy, not implied by the presence of an ENV provider',async t=>{
  const f=await sharedCredentialAdapter(t);
  const threadId=(await f.request('thread/start',{cwd:f.root,testNoServerRequest:true},'alice')).result.thread.id;
  const start=await f.request('turn/start',{threadId,input:[{type:'text',text:'work'}],clientUserMessageId:'restricted-owner'},'alice');
  f.internal.options.sharedTurnInput=false;
  const denied=await f.request('turn/steer',{threadId,expectedTurnId:start.result.turn.id,input:[{type:'text',text:'denied'}],clientUserMessageId:'restricted-control'},'bob');
  assert.equal(denied.error.data.notSubmitted,true);assert.equal(f.writes.some(row=>row.method==='turn/steer'),false);
  assert.equal(f.internal.executionEnvironments.get(threadId).account,'employee:alice');
});
