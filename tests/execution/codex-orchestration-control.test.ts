import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexOrchestrationControl, type CodexOrchestrationControlPort } from '../../apps/opencraft-daemon/src/codex-orchestration-control';
import type { RecoveryTurn } from '../../packages/host-recovery/src/index';
import type { AppServerThread } from '../../packages/appserver-protocol/src/index';
import { permissionModeProfileId } from '../../packages/appserver-protocol/src/index';

const thread = (turns: unknown[], status = 'idle') => ({ id: 'child', status: { type: status }, turns }) as AppServerThread;
function fixture() {
  const requests: Array<{method:string;params:Record<string,unknown>}> = [];
  let recovery: RecoveryTurn | null = null;
  let current = true;
  const port: CodexOrchestrationControlPort = {
    supported: () => true,
    request: async (method,params,admit) => {
      if (admit && !admit()) throw Error('revoked');
      requests.push({method,params});
      if (method === 'thread/resume') return {cwd:'/workspace',model:'inherited',modelProvider:'test',approvalPolicy:'never',sandbox:{type:'readOnly'}};
      return {thread:{id:'child'}};
    },
    read: async () => ({thread:thread([{id:'turn',status:'completed',items:[{type:'agentMessage',text:'Finished'}]}])}),
    recovery: () => recovery,
    pendingInput: () => false,
  };
  const control = new CodexOrchestrationControl(port);
  return {port,requests,setRecovery(value:RecoveryTurn){recovery=value;},revoke(){current=false;},
    invoke(method:string,params:Record<string,unknown>={}) {return control.handle('opencraft/orchestration/'+method,{operationId:'op',threadId:'source',...params},{sender:null,orchestrationOperationId:'op',orchestrationCanAdmit:()=>current}) as Promise<any>;},control};
}

test('private Host operations require trusted admission and preserve source permissions', async () => {
  const f=fixture();
  await assert.rejects(f.control.handle('opencraft/orchestration/create',{operationId:'op'},{sender:null}),{code:403});
  const settings=await f.invoke('prepare',{arguments:{cwd:'subdir',model:'chosen',title:'Review'}});
  assert.deepEqual(settings,{cwd:'/workspace/subdir',orchestrationSourceThreadId:'source',model:'chosen',modelProvider:'test',approvalPolicy:'never',sandbox:'read-only',orchestrationTitle:'Review'});
  await assert.rejects(f.invoke('prepare',{arguments:{cwd:'../outside'}}),{code:403});
  await f.invoke('create',{settings});
  const create=f.requests.find(r=>r.method==='thread/start')!,title=f.requests.find(r=>r.method==='thread/name/set')!;
  assert.equal(create.params.__opencraftOrchestrationOperation,'op');assert.equal(title.params.__opencraftOrchestrationOperation,'op:title');
  assert.equal(create.params.__opencraftOrchestrationFingerprint,title.params.__opencraftOrchestrationFingerprint);
  assert.equal(create.params.orchestrationTitle,undefined);
  f.revoke();await assert.rejects(f.invoke('create',{settings}),{code:403});
  assert.equal(f.requests.filter(r=>r.method==='thread/start').length,1);
});

test('a foreign source keeps delegation bounds while freezing Codex defaults and avoiding a foreign generation route', async () => {
  const f = fixture(), original = f.port.request;
  f.port.incarnation = () => 'codex-owner';
  f.port.request = async (method, params, admit) => method === 'config/read'
    ? { config: { model: 'codex-default', model_provider: 'codex-provider', model_reasoning_effort: 'medium' } }
    : original(method, params, admit);
  const settings = await f.invoke('prepare', { sourceSettings: { cwd: '/workspace', model: 'pi:foreign:model', modelProvider: 'foreign',
    permissions: permissionModeProfileId('full'), approvalPolicy: 'never', sandbox: 'danger-full-access' }, arguments: { cwd: 'child' } });
  assert.equal(settings.cwd, '/workspace/child'); assert.equal(settings.model, 'codex-default'); assert.equal(settings.modelProvider, 'codex-provider');
  assert.equal(settings.orchestrationHostIncarnation, 'codex-owner'); assert.equal(settings.orchestrationCrossDriver, true);
  assert.equal(f.requests.filter(request => request.method === 'thread/resume').length, 0);
  await f.invoke('create', { settings: { ...settings, orchestrationDriver: 'codex' } });
  const created = f.requests.find(request => request.method === 'thread/start')!;
  assert.equal(created.params.__opencraftOrchestrationSourceThreadId, undefined);
  assert.equal(created.params.orchestrationDriver, undefined); assert.equal(created.params.orchestrationCrossDriver, undefined);
  assert.equal(created.params.permissions, undefined); assert.equal(created.params.sandbox, 'danger-full-access');
  await assert.rejects(f.invoke('prepare', { sourceSettings: { cwd: '/workspace', permissions: 'full' }, arguments: { cwd: '../outside' } }), { code: 403 });
  await assert.rejects(f.invoke('prepare', { sourceSettings: { cwd: '/workspace', permissions: 'untranslatable' }, arguments: {} }), { code: 403 });
});

test('nullable native Codex defaults stay absent instead of becoming invalid child overrides', async () => {
  const f = fixture(), original = f.port.request;
  f.port.request = async (method, params, admit) => method === 'config/read'
    ? { config: { model: null, model_provider: null, model_reasoning_effort: null } } : original(method, params, admit);
  const settings = await f.invoke('prepare', { sourceSettings: { cwd: '/workspace', sandbox: 'danger-full-access', approvalPolicy: 'never' }, arguments: {} });
  assert.equal('model' in settings, false); assert.equal('modelProvider' in settings, false); assert.equal('config' in settings, false);
  await f.invoke('create', { settings });
  const native = f.requests.find(request => request.method === 'thread/start')!.params;
  assert.equal(native.config, undefined); assert.equal(native.model, undefined);
});

test('recovery lifecycle is authoritative while notices omit active recovery states',async()=>{
  const f=fixture(),base:RecoveryTurn={threadId:'child',turnId:'retry',rootTurnId:'root',attempts:1,inputId:'continuation',state:'preparing'};
  for(const state of ['interrupted','preparing','dispatching'] as const){f.setRecovery({...base,state});assert.deepEqual(await f.invoke('status'),{threadId:'source',turnId:'retry',rootTurnId:'root',state:'recovering'});}
  for(const state of ['exhausted','unconfirmed'] as const){f.setRecovery({...base,state});assert.equal((await f.invoke('status')).state,state);}
  f.setRecovery({...base,state:'handled',handledReason:'user_stop'});assert.equal((await f.invoke('status')).state,'completed','stop intent cannot replace a completed outcome');
  f.port.read=async()=>({thread:thread([{id:'retry',status:'inProgress',items:[]}],'active')});assert.equal((await f.invoke('status')).state,'active','rejected or unknown stop has no false terminal');
  f.port.read=async()=>({thread:thread([{id:'retry',status:'interrupted',items:[]}])});assert.equal((await f.invoke('status')).state,'interrupted_by_user');
  f.port.read=async()=>({thread:thread([{id:'retry',status:'completed',items:[]}])});
  f.setRecovery({...base,state:'complete'});assert.equal((await f.invoke('status')).state,'completed');
  f.port.pendingInput=()=> 'pending';assert.equal((await f.invoke('status')).state,'starting');
  f.port.pendingInput=()=> 'unknown';assert.equal((await f.invoke('status')).state,'unconfirmed');
});

test('inspect reads only recent user and assistant text, prioritizes the newest text and bounds UTF-8',async()=>{
  const f=fixture();let reads=0;
  f.port.read=async()=>{reads++;return {thread:thread([{id:'turn',items:[{type:'userMessage',content:[{type:'text',text:'旧'.repeat(40_000)}]},{type:'commandExecution',aggregatedOutput:'SECRET TOOL OUTPUT'},{type:'agentMessage',text:'Latest answer'}]}])};};
  const result=await f.invoke('inspect',{limit:1});
  assert.equal(reads,1);assert.equal(result.entries.at(-1).text,'Latest answer');assert.ok(Buffer.byteLength(JSON.stringify(result))<24*1024);
  assert.doesNotMatch(JSON.stringify(result),/SECRET TOOL OUTPUT/);assert.equal(f.requests.length,0);
});


test('only a confirmed Native rejection becomes a durable create failure; transport loss stays unknown',async()=>{
  const f=fixture();f.port.request=async()=>{throw Object.assign(Error('Native rejected'),{code:400,data:{orchestrationRejected:true}});};
  assert.deepEqual(await f.invoke('create',{settings:{cwd:'/workspace'}}),{rejected:{status:400}});
  f.port.request=async()=>{throw Error('Connection lost after send');};await assert.rejects(f.invoke('create',{settings:{cwd:'/workspace'}}),/Connection lost/);
});

test('a Codex native full-access source exports the portable profile only for cross-driver preparation', async () => {
  const f=fixture(), original=f.port.request;
  f.port.request=async(method,params,admit)=>method==='thread/resume'
    ? {cwd:'/workspace',approvalPolicy:'never',sandbox:{type:'dangerFullAccess'},activePermissionProfile:{id:':danger-full-access'}}
    : original(method,params,admit);
  const native=await f.invoke('prepare',{arguments:{}});
  assert.equal(native.permissions,':danger-full-access','same-driver creation preserves the native profile');
  const portable=await f.invoke('prepare',{arguments:{},sourceOnly:true});
  assert.equal(portable.permissions,permissionModeProfileId('full'),'foreign drivers consume the shared permission contract');
  f.port.request=async()=>({cwd:'/workspace',approvalPolicy:'never',sandbox:{type:'dangerFullAccess'},activePermissionProfile:{id:'custom-unknown'}});
  assert.equal((await f.invoke('prepare',{arguments:{},sourceOnly:true})).permissions,'custom-unknown','unknown custom policies cannot be promoted to Full access');
});
