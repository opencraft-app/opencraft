import { ordinaryNativeRouting, readOrdinaryWorkspacePlacement } from '../../assets/ordinary-native-routing';
import { createCodexWorkspaceHooks } from '../../../../scripts/codex-workspace-hooks.mjs';
import { PublishedOrdinaryGitSources, InstalledOrdinaryWorkspaceSources } from '../../assets/ordinary-git-sources';
import { ordinaryNativeAttachment } from '../../assets/ordinary-native-attachment';
import { createWorkspaceExecutionAuthority, consumeWorkspaceExecutionGrant, workspaceGrantField } from '@opencraft/sandbox-node/workspace-execution-channel';
import type { DuplexTransport, TransportStatus } from '@opencraft/appserver-client/transport';
import { ManagedNfsLibraries } from '../../assets/libraries';
import { PLATFORM_ASSET_SCOPE } from '../../assets/contract';
import { validateInstalledPolicy } from '../../assets/installed-sandbox-config';
import { terminalResourceOwnerId } from '../../../../scripts/host-terminal-transport';
import { SandboxProcessService } from '../../../../apps/local-agent-host/src/sandbox-process-service';
import test from 'node:test';
import { CodexEngineAdapter } from '../../../../apps/opencraft-daemon/src/codex-engine-adapter';
import { startCodexCore } from '../../../../apps/codex-core/src/main';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';
import { spawn } from 'node:child_process';
import { OrdinaryNativeCreation, OrdinaryNativeRestoration } from '../../assets/ordinary-native-creation';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstalledOrdinaryConversationRuntime, type OrdinaryRuntimeAdmission, type OrdinaryWorkspaceSources } from '../../assets/ordinary-conversation-runtime';
import { InstalledOrdinaryEnvironmentCatalog } from '../../assets/ordinary-environment-catalog';
import { SandboxConfigurations } from '../../assets/sandbox-configurations';
import { OrdinaryWorkspaceStore } from '../../../../apps/local-agent-host/src/ordinary-workspace-store';
import type { InstalledOrdinarySandboxAllocator } from '../../assets/ordinary-sandbox-allocator';
import type { createSandboxConversationBinding } from '../../../../apps/local-agent-host/src/sandbox-conversation-binding';
import type { OrdinaryExecutionBinding } from '../../../../apps/local-agent-host/src/ordinary-conversation-owner';

function fixture(t: test.TestContext, browser?: NonNullable<ConstructorParameters<typeof InstalledOrdinaryConversationRuntime>[3]>['browser'], installedBrowser?: import('../../assets/installed-sandbox-config').InstalledSandboxPolicy['templates'][number]['browser']) {
  const root = mkdtempSync(join(tmpdir(), 'ordinary-runtime-')), store = new OrdinaryWorkspaceStore(root, 'deployment');
  const documents = new Map<string, { revision: number; document: unknown }>();
  const vault = { readDocument(scope: string, ns: string) { return structuredClone(documents.get(scope+'/'+ns) ?? { revision: 0, document: null }); },
    writeDocument(scope: string, ns: string, revision: number, document: unknown) { documents.set(scope+'/'+ns, { revision: revision+1, document: structuredClone(document) }); } };
  const configurations = new SandboxConfigurations(vault);
  configurations.adoptInstallation({ apiUrl: 'https://api.example.test', sandboxUrl: 'https://sandbox.example.test',
    capacity: { cpuMillis: 2, memoryBytes: 2 }, lease: { timeoutMs: 300000, renewEveryMs: 60000, maxLifetimeMs: 3600000 },
    persistentWorkspaces: true, templates: ['base','browser'].map(id => ({ id, name: id, workspaceRoot: '/workspace', resources: { cpuMillis: 1, memoryBytes: 1 }, ...(installedBrowser ? {browser:installedBrowser} : {}) })) }, 'synthetic-key');
  const records=configurations.installedRuntime()!.records;
  new ManagedNfsLibraries(vault).register({id:'shared',name:'Shared',kind:'nfs',managedBy:'e2b',mountPath:'/shared',
    credentialId:records[0]!.credential.id,credentialGeneration:records[0]!.credential.generation,
    volumeId:'22222222-2222-2222-2222-222222222222',environmentIds:records.map(r=>r.environment.id),
    templateIds:records.map(r=>r.environment.templateId),verifiedAt:'2026-11-18T00:00:00.000Z'},0);
  const catalog = new InstalledOrdinaryEnvironmentCatalog(configurations);
  const admission: OrdinaryRuntimeAdmission = { authority: { principalId: 'alice', hostId: 'host' },
    catalog: { scope: 'alice', current: () => true }, async authorize() {} };
  const bindings: Parameters<typeof createSandboxConversationBinding>[0][] = [];
  const events: string[] = [], leases: { workspaceId: string; generation: number }[] = [], losses: (() => void)[] = [];
  let sequence = 0, resolveHook = async () => {}, failClose = false;
  let prepareHook: () => Promise<void> = async () => {};
  let mountHook: () => Promise<void> = async () => {};
  let source: Awaited<ReturnType<OrdinaryWorkspaceSources['resolve']>> = {kind:'empty'};
  const sources: OrdinaryWorkspaceSources = { async resolve() { events.push('resolve'); await resolveHook(); return source; },
    async authorize() { events.push('authorize-source'); }, async prepare(input) { await input.authorize(); events.push('prepare-source'); return prepareHook(); } };
  const allocator: Pick<InstalledOrdinarySandboxAllocator,'allocate'|'inspect'|'close'> = {
    async allocate(input) { await input.authorize(); events.push('allocate'); leases.push(input.lease); losses.push(input.onLost);
      return { instanceId: 'instance-'+(++sequence), privateVolumeId: 'volume-'+input.lease.workspaceId,
        environment: { resources: {cpuMillis:1,memoryBytes:1}, capabilities: {terminal:false}, async spawn() { throw Error('unused'); }, async close() {} },
        async close() { events.push('kill'); if(failClose) throw Error('delete failed'); } }; },
    async inspect(_context,_environment,input,authorize) { await authorize(); events.push('inspect'); assert.ok(input.privateVolumeId.startsWith('volume-ws-')); return 'absent'; },
    async close() { events.push('pool-close'); },
  };
  const bind = async (o: Parameters<typeof createSandboxConversationBinding>[0]): Promise<OrdinaryExecutionBinding> => {
    await o.authorize(); events.push('bind');bindings.push(o);let closed=false;
    return { isCurrent:()=>!closed, async executionFields() { await o.authorize(); return { cwd:o.cwd,runtimeWorkspaceRoots:[o.cwd],environments:[{environmentId:o.environmentId!,cwd:o.cwd}] }; },
      async executionSelection() { await o.authorize(); return { kind:'bound', workspaceId:o.workspaceLease!.workspaceId, generation:o.workspaceLease!.generation, environmentId:o.environmentId!, cwd:o.cwd, execServerUrl:'ws://127.0.0.1:4321/'+'1'.repeat(64) }; },
      async bindThread() { events.push('bind-thread'); }, async close() { closed=true;events.push('binding-close'); } };
  };
  const all: InstalledOrdinaryConversationRuntime[] = [];
  const make = (sourceOwner:OrdinaryWorkspaceSources=sources) => { const r = new InstalledOrdinaryConversationRuntime(store,catalog,sourceOwner,{allocator,bind,browser,verifyMounts:async()=>{events.push('verify-mounts');await mountHook();return {cwd:'/workspace'};}}); all.push(r);return r; };
  const runtime = make();
  const start = (r=runtime,a=admission,intentId='intent') => r.start({admission:a,intentId,environment:catalog.snapshot(a.catalog).environments[0]!.target,source:{kind:'empty'},
    nativeStart:async(fields) => { events.push('native'); assert.equal(fields.cwd,'/workspace');return {thread:{id:'thread-'+sequence}}; }});
  t.after(async()=>{for(const r of all)await r.close().catch(()=>{});store.close();rmSync(root,{recursive:true,force:true});});
  return {setMountCheck(fn:()=>Promise<void>){mountHook=fn;},catalog,configurations,bindings,setSource(value:typeof source){source=value},root,runtime,make,start,store,admission,events,leases,losses,target:catalog.snapshot(admission.catalog).environments[0]!.target,setResolve(fn:()=>Promise<void>){resolveHook=fn},setPrepare(fn:()=>Promise<void>){prepareHook=fn},failCleanup(){failClose=true}};
}

test('composition prepares source before bridge/Native, persists before return and deduplicates', async t=>{
 const f=fixture(t),receipt=await f.start();
 assert.equal(f.store.forThread(f.admission.authority,receipt.threadId)?.workspaceId,receipt.workspaceId);
 assert.ok(f.events.indexOf('verify-mounts')<f.events.indexOf('prepare-source'));
 assert.ok(f.events.indexOf('prepare-source')<f.events.indexOf('bind'));assert.ok(f.events.indexOf('bind')<f.events.indexOf('native'));
 assert.deepEqual(await f.start(),receipt);assert.equal(f.events.filter(e=>e==='native').length,1);
 await f.runtime.bindingFor(f.admission,receipt.threadId);
 await f.runtime.close();assert.deepEqual(f.events.slice(-3),['binding-close','kill','pool-close']);
});
test('distinct principals get distinct private workspaces and cannot use another binding',async t=>{
 const f=fixture(t),a=await f.start();
 const bob={...f.admission,authority:{principalId:'bob',hostId:'host'},catalog:{scope:'bob',current:()=>true}};
 const b=await f.start(f.runtime,bob);assert.notEqual(a.workspaceId,b.workspaceId);
 await assert.rejects(f.runtime.bindingFor(bob,a.threadId),/unavailable/);
});
test('restart restores stored selection and same workspace/volume without resolving current source again',async t=>{
 const f=fixture(t),created=await f.start();await f.runtime.close();const runtime=f.make();
 f.setResolve(async()=>{throw Error('must not resolve latest')});
 const restored=await runtime.restore({admission:f.admission,threadId:created.threadId,nativeResume:async(id,fields)=>{
  assert.equal(id,created.threadId);assert.equal(fields.cwd,'/workspace');return {thread:{id}};
 }});
 assert.deepEqual(restored,created);assert.equal(f.leases[0]!.workspaceId,f.leases[1]!.workspaceId);assert.equal(f.leases[1]!.generation,2);
 assert.ok(!f.events.includes('inspect'));await runtime.bindingFor(f.admission,created.threadId);
});
test('source preparation failure reclaims exact compute without bridge or Native creation',async t=>{
 const f=fixture(t);f.setPrepare(async()=>{throw Error('missing base')});await assert.rejects(f.start(),/missing base/);
 assert.ok(f.events.includes('kill'));assert.ok(!f.events.includes('bind'));assert.ok(!f.events.includes('native'));
 assert.equal(f.store.pendingThreadStarts('host').length,0);
});
test('provider loss revokes binding and closes bridge before compute',async t=>{
 const f=fixture(t),created=await f.start();f.losses[0]!();
 await assert.rejects(f.runtime.bindingFor(f.admission,created.threadId));
 await f.runtime.close();assert.deepEqual(f.events.slice(-3),['binding-close','kill','pool-close']);
});
test('shutdown waits for source admission and prevents delayed allocation',async t=>{
 const f=fixture(t);let release!:()=>void,entered!:()=>void;
 const ready=new Promise<void>(r=>entered=r);f.setResolve(async()=>{entered();await new Promise<void>(r=>release=r)});
 const started=f.start();const rejected=assert.rejects(started,/expired/);await ready;
 let closed=false;const close=f.runtime.close().then(()=>{closed=true});await Promise.resolve();assert.equal(closed,false);
 release();await rejected;await close;assert.ok(!f.events.includes('allocate'));
});
test('cleanup error still attempts pool shutdown and is never reported as successful close',async t=>{
 const f=fixture(t);await f.start();f.failCleanup();await assert.rejects(f.runtime.close(),/cleanup unconfirmed/);
 assert.equal(f.events.at(-1),'pool-close');
});

test('uncertain retained member is inspected before recreating the same workspace',async t=>{
 const f=fixture(t),created=await f.start();await f.runtime.close();
 const lease=f.store.beginCreate(f.admission.authority,created.workspaceId);
 f.store.recordProviderReceipt(f.admission.authority,lease,{instanceId:'interrupted-instance',privateVolumeId:'volume-'+created.workspaceId});
 f.store.markUncertain(f.admission.authority,lease);
 const runtime=f.make();await runtime.restore({admission:f.admission,threadId:created.threadId,
  nativeResume:async(id)=>({thread:{id}})});
 assert.ok(f.events.includes('inspect'));assert.ok(f.events.indexOf('inspect')<f.events.lastIndexOf('allocate'));
 assert.equal(f.leases.at(-1)!.workspaceId,created.workspaceId);
});

function handoff(f: ReturnType<typeof fixture>) {
 const context={sender:null}, request={method:'thread/start',context:()=>context};
 const creation=new OrdinaryNativeCreation(f.runtime,async(_context,params)=>({admission:f.admission,intentId:String(params.intentId),environment:f.target,source:{kind:'empty'}}));
 return {context,request,creation};
}
test('private receipt handoff unblocks Native before publishing the durable workspace',async t=>{
 const f=fixture(t),h=handoff(f);t.after(()=>h.creation.close());
 const prepared=await h.creation.prepare('physical-1',h.request,{intentId:'handoff'});
 assert.equal(prepared.kind,'dispatch');if(prepared.kind!=='dispatch')throw Error('expected dispatch');
 assert.equal((await prepared.resolve()).kind,'bound');assert.equal(f.store.pendingThreadStarts('host').length,1);
 await assert.rejects(f.runtime.bindingFor(f.admission,'thread-handoff'));
 await h.creation.finalize({requestId:'physical-1',context:h.context,result:{thread:{id:'thread-handoff'}}});
 assert.equal(f.store.pendingThreadStarts('host').length,0);await f.runtime.bindingFor(f.admission,'thread-handoff');
 const duplicate=await h.creation.prepare('physical-2',h.request,{intentId:'handoff'});
 assert.equal(duplicate.kind,'existing');assert.equal(f.leases.length,1);
 await h.creation.close();await f.runtime.bindingFor(f.admission,'thread-handoff');
 await assert.rejects(h.creation.finalize({requestId:'physical-1',context:h.context,result:{thread:{id:'thread-handoff'}}}),/unavailable/);
});
test('negative Native receipt completes cleanup without waiting for a public RPC reply',async t=>{
 const f=fixture(t),h=handoff(f);t.after(()=>h.creation.close());
 await h.creation.prepare('negative',h.request,{intentId:'negative'});
 await h.creation.finalize({requestId:'negative',context:h.context,error:{code:-32602}});
 assert.deepEqual(f.events.slice(-2),['binding-close','kill']);
 // Rejection is not interpreted as proof that Native created nothing.
 assert.equal(f.store.pendingThreadStarts('host').length,1);
});
test('attachment loss releases an in-flight creation but never switches to local execution',async t=>{
 const f=fixture(t),h=handoff(f);t.after(()=>h.creation.close());
 const prepared=await h.creation.prepare('interrupted',h.request,{intentId:'interrupted'});
 await h.creation.close();assert.deepEqual(f.events.slice(-2),['binding-close','kill']);
 if(prepared.kind==='dispatch')await assert.rejects(prepared.resolve(),/cancelled/);
 await assert.rejects(h.creation.prepare('new',h.request,{intentId:'new'}),/unavailable/);
});
test('cleanup failure on a negative receipt is propagated, not mistaken for a clean rejection',async t=>{
 const f=fixture(t),h=handoff(f);t.after(()=>h.creation.close());
 await h.creation.prepare('bad-cleanup',h.request,{intentId:'bad-cleanup'});f.failCleanup();
 await assert.rejects(h.creation.finalize({requestId:'bad-cleanup',context:h.context,error:{code:-32602}}),/cleanup unconfirmed/);
});
test('a different in-process request context cannot settle the private receipt',async t=>{
 const f=fixture(t),h=handoff(f);t.after(()=>h.creation.close());
 await h.creation.prepare('scope',h.request,{intentId:'scope'});
 await assert.rejects(h.creation.finalize({requestId:'scope',context:{sender:null},result:{thread:{id:'foreign'}}}),/authority mismatch/);
 assert.equal(f.store.forThread(f.admission.authority,'foreign'),null);
 assert.ok(f.events.includes('kill'));
});

test('interruption retires old attempts without disabling requests after reconnect',async t=>{
 const f=fixture(t),h=handoff(f);t.after(()=>h.creation.close());
 await h.creation.prepare('old',h.request,{intentId:'old'});await h.creation.interrupt();
 const next=await h.creation.prepare('new',h.request,{intentId:'new'});assert.equal(next.kind,'dispatch');
 await h.creation.finalize({requestId:'new',context:h.context,result:{thread:{id:'after-reconnect'}}});
 await f.runtime.bindingFor(f.admission,'after-reconnect');
});

for (const resumeMode of ['native', 'provisional', ...(process.env.OPENCRAFT_TEST_NATIVE_EXECUTABLE ? ['provisional-real-native'] : [])])
test('actual adapter and Core confirm '+resumeMode+' restoration before public success',async t=>{
 const realNative=resumeMode==='provisional-real-native', provisionalMode=resumeMode!=='native';
 const f=fixture(t),token='private-test-core-token-'.repeat(3),frames:any[]=[];
 const options={endpoint:join(f.root,'control.sock'),authToken:token,executable:process.execPath,runtimeDirectory:f.root,
  dataDirectory:join(f.root,'core-data'),nativeCodexHomeDirectory:join(f.root,'native'),fetch:async()=>Response.json({plan_type:'pro'}),
  spawnAppServer:({args,cwd,env}:{args:readonly string[];cwd:string;env:NodeJS.ProcessEnv})=>realNative
   ? spawn(process.env.OPENCRAFT_TEST_NATIVE_EXECUTABLE!,args,{cwd,env:{HOME:f.root,CODEX_HOME:env.CODEX_HOME,PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe']})
   : spawn(process.execPath,[new URL('../../../../tests/fixtures/fake-codex-unix-appserver.mjs',import.meta.url).pathname,args[2]!.slice('unix://'.length)],{cwd,env,stdio:['pipe','pipe','pipe']})};
 const core=await startCodexCore(options);
 const h=new OrdinaryNativeCreation(f.runtime,async(_context,params)=>({admission:f.admission,intentId:String(params.workspaceIntent),environment:f.target,source:{kind:'empty'}}));
 const resumedRuntime=f.make();
 // The exact thread ID is supplied after creation, never guessed from a request.
 let resumeThread='';
 const resumeOperation=new OrdinaryNativeRestoration(resumedRuntime,async(_context,params)=>{
  assert.equal(params.threadId,resumeThread);return {admission:f.admission,threadId:resumeThread};
 });
 let needsWorkspaceResume=true;
 let resumeConfirmed=false,enterResume!:()=>void,releaseResume!:()=>void;
 const resumeEntered=new Promise<void>(resolve=>{enterResume=resolve;});
 const resumeBarrier=new Promise<void>(resolve=>{releaseResume=resolve;});
 const authoritySocket=join(f.root,'handoff.sock');
 const authority=await createWorkspaceExecutionAuthority({socketPath:authoritySocket,token});
 let attachment:ReturnType<typeof ordinaryNativeAttachment>;
 let selected=false,confirmed=false;let finalizationError:unknown;
 const adapter=new CodexEngineAdapter({...options,coreEndpoint:core.endpoint,coreAuthToken:token,coreHostOverlays:true,logDiagnostic:()=>{},
  ...createCodexWorkspaceHooks({createCodexWorkspaceHooks:(): Pick<Exclude<ConstructorParameters<typeof CodexEngineAdapter>[0],{kind:'remote'}>,
    'decorateNativeTransport'|'finalizeNativeCreation'|'finalizeNativeResume'|'requiresWorkspaceResume'|'restoreProvisionalWorkspace'>=>({
  decorateNativeTransport(native,lookup){
   // Fixture APP boundary: consumes the real private grant, then feeds the fake
   // Native executable. Not a deployed APP registration/execution proof.
   const receiver:DuplexTransport={
    get status(){return native.status;},connect:s=>native.connect(s),
    subscribeMessage:l=>native.subscribeMessage(l),subscribeStatus:l=>native.subscribeStatus(l),close:()=>native.close(),
    async send(frame,signal,progress){
     const m=JSON.parse(frame);
     if(!['thread/start','thread/resume'].includes(m.method))return native.send(frame,signal,progress);
     if(provisionalMode&&m.method==='thread/resume')throw Error('Empty Native must not be resumed');
     const {[workspaceGrantField]:ticket,...wire}=m.params;
     const selection=await consumeWorkspaceExecutionGrant({socketPath:authoritySocket,token},ticket,m.method,wire);
     assert.equal(selection.kind,'bound');if(selection.kind!=='bound')throw Error('Unexpected local fallback');selected=true;
     const {workspaceIntent:_,...params}=wire;
     // Real-Native opt-in covers empty-thread compatibility only. Compute and
     // environment registration remain synthetic; no model turn or E2B claim.
     await native.send(JSON.stringify({...m,params:realNative?{...params,cwd:f.root}
      :{...params,cwd:selection.cwd,environments:[{environmentId:selection.environmentId,cwd:selection.cwd}]}}),signal,progress);
    },
   };
   attachment=ordinaryNativeAttachment({native:receiver,authority,creation:h,lookup,
    restoration:{operation:resumeOperation,isWorkspaceResume:params=>params.threadId===resumeThread},
    isWorkspaceStart:params=>typeof params.workspaceIntent==='string',
    prepareExecution:async()=>{throw Error('Unexpected execution request');},
    onCleanupUnconfirmed(){finalizationError=Error('Attachment cleanup unconfirmed');}});
   return attachment.transport;
  },
  finalizeNativeCreation:async input=>{if(!input.params.workspaceIntent)return;try{await attachment.finalize(input);confirmed=true;}catch(error){finalizationError=error;throw error;}},
  requiresWorkspaceResume:threadId=>needsWorkspaceResume&&f.store.hasThread('host',threadId),
  ...(provisionalMode?{restoreProvisionalWorkspace:async(input:{threadId:string;confirm():Promise<unknown>})=>{
    enterResume();await resumeBarrier;
    await resumedRuntime.restore({admission:f.admission,threadId:input.threadId,nativeResume:async()=>{
      const evidence=await input.confirm();assert.equal((evidence as any).thread.id,input.threadId);return evidence;
    }});
    resumeConfirmed=true;
  }}:{}),
  finalizeNativeResume:async input=>{enterResume();await resumeBarrier;try{await attachment.finalize(input);resumeConfirmed=true;}catch(error){finalizationError=error;throw error;}},
  })}, 'host'),
 });
 adapter.subscribeMessage(frame=>{const m=JSON.parse(frame);if(m.id==='create'&&m.result)assert.equal(confirmed,true);frames.push(m)});
 const rpc=async(id:string,method:string,params:object={})=>{
  await adapter.sendWithContext(JSON.stringify({id,method,params,[LOGICAL_CLIENT_FIELD]:'viewer'}),{sender:null});
  for(let n=0;n<500;n++){const m=frames.find(m=>m.id===id&&!m.method);if(m){if(m.error)throw finalizationError ?? Error(m.error.message);return m.result}await new Promise(r=>setTimeout(r,10))}
  throw Error('Fixture RPC timeout');
 };
 try{
  await adapter.connect();await rpc('init','initialize',{clientInfo:{name:'opencraft_test',version:'1'},capabilities:{experimentalApi:true}});
  const result=await rpc('create','thread/start',{workspaceIntent:'adapter-intent',...(realNative?{model:'test-model'}:{})});
  assert.equal(selected,true);assert.equal(confirmed,true);await f.runtime.bindingFor(f.admission,result.thread.id);
  assert.equal(f.store.pendingThreadStarts('host').length,0);
  resumeThread=result.thread.id;
  needsWorkspaceResume=false;
  const localCached=await rpc('legacy-resume','thread/resume',{threadId:resumeThread});
  assert.equal(localCached.thread.id,resumeThread);assert.equal(resumeConfirmed,false);
  needsWorkspaceResume=true;
  await f.runtime.close();
  const resumed=rpc('resume','thread/resume',{threadId:resumeThread});
  await Promise.race([resumeEntered,resumed.then(()=>{throw Error('Resume bypassed private finalizer');})]);
  assert.equal(frames.some(frame=>frame.id==='resume'&&frame.result),false);
  await assert.rejects(resumedRuntime.bindingFor(f.admission,resumeThread));
  releaseResume();await resumed;
  assert.equal(resumeConfirmed,true);await resumedRuntime.bindingFor(f.admission,resumeThread);
  assert.equal(f.leases[0]!.workspaceId,f.leases[1]!.workspaceId);
 }finally{releaseResume();await adapter.close();await core.close();await authority.close()}
});

test('prepared private project cwd reaches Native and remains stable after restore',async t=>{
 const f=fixture(t);f.setSource({kind:'git',repositoryId:'repo',commit:'a'.repeat(40),libraryId:'shared',authorizationDomain:'alice',generation:'gen',relativePath:'subdir'});
 const receipt=await f.runtime.start({admission:f.admission,intentId:'project',environment:f.target,source:{kind:'empty'},nativeStart:async fields=>{
  assert.equal(fields.cwd,'/workspace/project/subdir');return {thread:{id:'project-thread'}};
 }});
 await f.runtime.close();
 await f.make().restore({admission:f.admission,threadId:receipt.threadId,nativeResume:async(id,fields)=>{
  assert.equal(fields.cwd,'/workspace/project/subdir');return {thread:{id}};
 }});
});

test('unsafe persisted source paths are rejected before allocation',async t=>{
 for(const relativePath of ['../shared','/shared/project','project//nested','project/..']){
  const f=fixture(t);f.setSource({kind:'git',repositoryId:'repo',commit:'a'.repeat(40),libraryId:'shared',authorizationDomain:'alice',generation:'gen',relativePath});
  await assert.rejects(f.start(),/Invalid resolved workspace selection/);
  assert.equal(f.events.includes('allocate'),false);assert.equal(f.events.includes('native'),false);
 }
});

test('runtime-created remote terminal uses the existing Gateway resource owner identity',async t=>{
 const f=fixture(t),receipt=await f.start(),options=f.bindings[0]!;
 const resourceOwnerId=terminalResourceOwnerId(f.admission.authority.principalId,f.admission.authority.hostId);
 assert.equal(options.processContext!.resourceOwnerId,resourceOwnerId);
 let exited!:(value:{code:number})=>void,closed=0;
 const exit=new Promise<{code:number}>(resolve=>exited=resolve);
 const processes=new SandboxProcessService({cwd:options.cwd,context:{...options.processContext!,threadId:receipt.threadId},
  authorize:options.authorize,onCleanupUnconfirmed(){throw Error('unexpected cleanup failure')},
  sandbox:{async spawn(command){
   assert.equal(command.cwd,'/workspace');assert.deepEqual(command.command,['/bin/sh']);
   return {kind:'terminal',id:'test-pty',exited:exit,async writeStdin(){},async resize(){},async terminate(){closed++;exited({code:0})}};
  }}});
 t.after(()=>processes.close());
 const scope={threadId:receipt.threadId,projectId:null};
 const params={processHandle:'remote-terminal',threadId:receipt.threadId,projectId:null,resourceOwnerId,tty:true,command:['/bin/sh'],size:{cols:80,rows:24}};
 assert.deepEqual(await processes.dispatch('process/spawn',params,scope),{processHandle:'remote-terminal'});
 const attached=await processes.dispatch('process/attach',{processHandle:'remote-terminal',afterSequence:0,resourceOwnerId},scope) as any;
 assert.equal(attached.context.resourceOwnerId,resourceOwnerId);
 await assert.rejects(processes.dispatch('process/spawn',{...params,processHandle:'foreign',resourceOwnerId:'another-user'},scope),/scope mismatch/);
 await processes.dispatch('process/kill',{processHandle:'remote-terminal',resourceOwnerId},scope);assert.equal(closed,1);
});

test('host-wide placement classification cannot turn a foreign workspace into local execution',async t=>{
 const f=fixture(t),receipt=await f.start();
 assert.equal(f.runtime.hasPlacement('host',receipt.threadId),true);
 assert.equal(f.runtime.hasPlacement('another-host',receipt.threadId),false);
 assert.equal(f.runtime.hasPlacement('host','unknown-thread'),false);
 await assert.rejects(f.runtime.bindingFor({...f.admission,authority:{principalId:'other',hostId:'host'}},receipt.threadId));
 await f.runtime.close();assert.throws(()=>f.runtime.hasPlacement('host',receipt.threadId),/closed/);
 const restarted=f.make();assert.equal(restarted.hasPlacement('host',receipt.threadId),true);
});


test('browser is lazy and each admitted conversation owns an isolated incarnation port',async t=>{
 let preparations=0;
 const f=fixture(t,{isolation:'isolated-vm-compatibility',prepare:async()=>{preparations++;throw Error('delivery unavailable')}});
 const a=await f.start(),b=await f.start(f.runtime,f.admission,'other-intent');
 const first=await f.runtime.bindingFor(f.admission,a.threadId),second=await f.runtime.bindingFor(f.admission,b.threadId);
 assert.ok(first.browser);assert.ok(second.browser);assert.notStrictEqual(first.browser,second.browser);assert.equal(preparations,0);
 first.browser.assertCurrent();
 await assert.rejects(first.browser.connect(),/delivery unavailable/);
 await assert.rejects(first.browser.connect(),/delivery unavailable/);assert.equal(preparations,1);
 second.browser.assertCurrent();await f.runtime.close();
 assert.throws(first.browser.assertCurrent,/unavailable|retired/);
 assert.throws(second.browser.assertCurrent,/unavailable|retired/);
 assert.equal(f.events.filter(e=>e==='binding-close').length,2);
});

test('browser preparation receives the same admitted durable workspace and template',async t=>{
 const inputs:any[]=[];
 const f=fixture(t,{isolation:'isolated-vm-compatibility',prepare:async input=>{
  await input.authorize();inputs.push(input);throw Error('test stop before spawn');
 }});
 const receipt=await f.start(),binding=await f.runtime.bindingFor(f.admission,receipt.threadId);
 await assert.rejects(binding.browser!.connect(),/test stop/);
 assert.equal(inputs[0].workspaceId,receipt.workspaceId);assert.equal(inputs[0].generation,f.leases[0]!.generation);
 assert.equal(inputs[0].environment.templateId,f.target.templateId);
 await f.runtime.close();assert.deepEqual(f.events.slice(-3),['binding-close','kill','pool-close']);
});

test('browser support absence stays explicit instead of selecting local execution',async t=>{
 const f=fixture(t),receipt=await f.start();const binding=await f.runtime.bindingFor(f.admission,receipt.threadId);
 assert.equal(binding.browser,undefined);
});


test('installed template delivery enables the actual runtime browser without an injected browser factory', async t => {
 const f=fixture(t,undefined,{isolation:'isolated-vm-compatibility',manifest:{version:1,archives:[
  {path:'/shared/.opencraft/runtime-cache/browser.tgz',sha256:'a'.repeat(64)}
 ]}});
 const created=await f.start(), binding=await f.runtime.bindingFor(f.admission,created.threadId);
 assert.ok(binding.browser);
 binding.browser.assertCurrent();
 // The fixture allocator deliberately has no command implementation. Reaching
 // spawn proves the installed preparer, not a local owner or test factory, ran.
 await assert.rejects(binding.browser.connect(),/unused/);
 await f.runtime.close();
 assert.throws(binding.browser.assertCurrent,/unavailable|retired/);
});


test('installed browser archive digest participates in the admitted environment revision', async t => {
 const installed={isolation:'isolated-vm-compatibility' as const,manifest:{version:1 as const,archives:[
  {path:'/shared/.opencraft/runtime-cache/browser.tgz',sha256:'a'.repeat(64)}
 ]}};
 const f=fixture(t,undefined,installed);
 const before=f.catalog.resolveEnvironment(f.admission.catalog,f.target);
 const runtime=f.catalog.runtime(f.admission.catalog,before);
 assert.equal(runtime.template.browser!.manifest.archives[0]!.sha256,'a'.repeat(64));
 // Installation snapshots cannot mutate the vault or another pinned lease.
 runtime.template.browser!.manifest.archives[0]!.sha256='b'.repeat(64);
 assert.equal(f.catalog.runtime(f.admission.catalog,before).template.browser!.manifest.archives[0]!.sha256,'a'.repeat(64));
 const stored=f.configurations.vault.readDocument(PLATFORM_ASSET_SCOPE,'document-sandbox-configurations');
 const document=stored.document as {installation: import('../../assets/installed-sandbox-config').InstalledSandboxPolicy};
 document.installation.templates[0]!.browser!.manifest.archives[0]!.sha256='b'.repeat(64);
 f.configurations.vault.writeDocument(PLATFORM_ASSET_SCOPE,'document-sandbox-configurations',stored.revision,stored.document);
 const after=f.catalog.resolveEnvironment(f.admission.catalog,f.target);
 assert.notEqual(after.configurationRevision,before.configurationRevision);
 await assert.rejects(runtime.authorize(),/unavailable/);

});
test('malformed installed browser delivery is rejected before runtime construction', t => {
 const f=fixture(t);
 const policy=f.configurations.installedRuntime()!.policy;
 policy.templates[0]!.browser={isolation:'automatic' as never,
  manifest:{version:1,archives:[{path:'/shared/.opencraft/runtime-cache/browser.tgz',sha256:'a'.repeat(64)}]}};
 assert.throws(()=>validateInstalledPolicy(policy),/Invalid installed sandbox policy/);
});


async function attachmentFixture(t:test.TestContext){
 const f=fixture(t),h=handoff(f),socketPath=join(f.root,'authority.sock'),token='attachment-authority-fixture-token-'.repeat(2);
 const authority=await createWorkspaceExecutionAuthority({socketPath,token});
 let state:TransportStatus={state:'open'}, failSend=false, missing=false, closed=false;
 const statuses=new Set<(s:TransportStatus)=>void>(), selections:unknown[]=[];
 const native:DuplexTransport={
  get status(){return state;},async connect(){},
  async send(frame){
   const m=JSON.parse(frame),{[workspaceGrantField]:ticket,...params}=m.params;
   assert.ok(ticket);assert.equal(JSON.stringify(params).includes('execServerUrl'),false);
   selections.push(await consumeWorkspaceExecutionGrant({socketPath,token},ticket,m.method,params));
   if(failSend)throw Error('native send failed');
  },
  subscribeMessage(){return ()=>{};},
  subscribeStatus(fn){statuses.add(fn);return()=>{statuses.delete(fn);};},
  async close(){closed=true;},
 };
 let uncertain=0;
 const attachment=ordinaryNativeAttachment({native,authority,creation:h.creation,lookup:()=>missing?null:h.request,
  isWorkspaceStart:p=>typeof p.intentId==='string',
  prepareExecution:async()=>{throw Error('unclassified execution');},
  onCleanupUnconfirmed(){uncertain++;}});
 t.after(async()=>{await attachment.transport.close().catch(()=>{});await authority.close();});
 return {f,h,attachment,selections,get uncertain(){return uncertain;},get closed(){return closed;},
  failSend(){failSend=true;},missing(){missing=true;},
  status(value:TransportStatus['state']){state={state:value};for(const fn of statuses)fn(state);},
  send(id:string,signal?:AbortSignal){return attachment.transport.send(JSON.stringify({id,method:'thread/start',params:{intentId:id}}),signal);}};
}
test('attachment uses actual private one-shot grant and durable receipt, without exposing execution URL',async t=>{
 const f=await attachmentFixture(t);await f.send('grant');
 assert.equal((f.selections[0] as any).kind,'bound');
 assert.equal(f.f.store.pendingThreadStarts('host').length,1);
 await f.attachment.finalize({requestId:'grant',context:f.h.context,result:{thread:{id:'grant-thread'}}});
 await f.f.runtime.bindingFor(f.f.admission,'grant-thread');
 await f.attachment.transport.close();assert.equal(f.closed,true);
 // Closing the physical attachment must not destroy a published workspace.
 await f.f.runtime.bindingFor(f.f.admission,'grant-thread');
});
test('attachment retains cancellation through receipt, and rejects late success',async t=>{
 const f=await attachmentFixture(t),controller=new AbortController();
 await f.send('cancel',controller.signal);controller.abort();
 await assert.rejects(f.attachment.finalize({requestId:'cancel',context:f.h.context,result:{thread:{id:'late'}}}));
 await f.attachment.transport.close();
 assert.ok(f.f.events.includes('kill'));assert.equal(f.f.store.forThread(f.f.admission.authority,'late'),null);
});
test('attachment send failure aborts creation without replay and still fences late receipt',async t=>{
 const f=await attachmentFixture(t);f.failSend();
 await assert.rejects(f.send('failed'),/native send failed/);
 assert.equal(f.selections.length,1);assert.ok(f.f.events.includes('kill'));
 await assert.rejects(f.attachment.finalize({requestId:'failed',context:f.h.context,result:{thread:{id:'late'}}}));
});
test('attachment refuses absent private admission before allocation or Native dispatch',async t=>{
 const f=await attachmentFixture(t);f.missing();
 await assert.rejects(f.send('missing'),/admission unavailable/);
 assert.equal(f.selections.length,0);assert.equal(f.f.leases.length,0);
});
test('attachment disconnect retires pending creation but allows fresh admitted work after reconnect',async t=>{
 const f=await attachmentFixture(t);await f.send('before');f.status('failed');
 f.status('open');
 await assert.rejects(f.attachment.finalize({requestId:'before',context:f.h.context,result:{thread:{id:'old'}}}));
 await f.send('after');
 await f.attachment.finalize({requestId:'after',context:f.h.context,result:{thread:{id:'new'}}});
 await f.f.runtime.bindingFor(f.f.admission,'new');assert.equal(f.selections.length,2);
});

test('closed attachment cannot silently accept a late positive creation receipt',async t=>{
 const f=await attachmentFixture(t);await f.send('closing');
 await f.attachment.transport.close();
 await assert.rejects(f.attachment.finalize({requestId:'closing',context:f.h.context,result:{thread:{id:'late'}}}),/closed/);
 assert.equal(f.closed,true);assert.ok(f.f.events.includes('kill'));
});
test('unclassified execution is rejected, not implicitly treated as local',async t=>{
 const f=await attachmentFixture(t);
 await assert.rejects(f.attachment.transport.send(JSON.stringify({id:'local',method:'thread/start',params:{}})),/unclassified/);
 assert.equal(f.selections.length,0);assert.equal(f.f.leases.length,0);
});
test('duplicate committed intent cannot dispatch another Native creation',async t=>{
 const f=await attachmentFixture(t);await f.send('first');
 await f.attachment.finalize({requestId:'first',context:f.h.context,result:{thread:{id:'original'}}});
 await assert.rejects(f.attachment.transport.send(JSON.stringify({id:'second',method:'thread/start',params:{intentId:'first'}})),/already created/);
 assert.equal(f.selections.length,1);assert.equal(f.f.leases.length,1);
 await f.f.runtime.bindingFor(f.f.admission,'original');
});


test('mount verification failure reclaims allocation before source writes, binding or Native creation',async t=>{
 const f=fixture(t);f.setMountCheck(async()=>{throw Error('mount proof rejected');});
 await assert.rejects(f.start(),/mount proof rejected/);
 assert.ok(f.events.includes('kill'));
 assert.ok(!f.events.includes('prepare-source'));assert.ok(!f.events.includes('bind'));assert.ok(!f.events.includes('native'));
});


test('concrete installed source owner persists a library reference and restores it with private cwd',async t=>{
 const f=fixture(t);
 const sources=new InstalledOrdinaryWorkspaceSources(f.catalog,new PublishedOrdinaryGitSources(f.configurations.vault));
 const runtime=f.make(sources);
 const created=await runtime.start({admission:f.admission,intentId:'library-source',environment:f.target,
  source:{version:1,kind:'library-reference',libraryId:'shared',relativePath:'docs'},
  nativeStart:async fields=>{assert.equal(fields.cwd,'/workspace');return {thread:{id:'library-thread'}};}});
 const selected=f.store.resolvedSelection(f.admission.authority,created.workspaceId);
 assert.equal(selected.source.kind,'library-reference');
 if(selected.source.kind!=='library-reference')throw Error('wrong source');
 assert.equal(selected.source.relativePath,'docs');
 await runtime.close();
 const restarted=f.make(sources);
 await restarted.restore({admission:f.admission,threadId:created.threadId,nativeResume:async(id,fields)=>{
  assert.equal(fields.cwd,'/workspace');return {thread:{id}};
 }});
 assert.deepEqual(f.store.resolvedSelection(f.admission.authority,created.workspaceId),selected);
 await restarted.bindingFor(f.admission,created.threadId);
});


test('restoration handoff confirms the same persisted thread before exposing its new binding',async t=>{
 const f=fixture(t),created=await f.start();await f.runtime.close();
 const runtime=f.make(),context={sender:null},request={method:'thread/resume',context:()=>context};
 const operation=new OrdinaryNativeRestoration(runtime,async()=>({admission:f.admission,threadId:created.threadId}));
 t.after(()=>operation.close());
 const prepared=await operation.prepare('resume',request,{threadId:created.threadId});
 assert.equal(prepared.kind,'dispatch');if(prepared.kind!=='dispatch')throw Error('missing dispatch');
 assert.equal((await prepared.resolve()).kind,'bound');
 await assert.rejects(runtime.bindingFor(f.admission,created.threadId));
 await operation.finalize({requestId:'resume',context,result:{thread:{id:created.threadId}}});
 await runtime.bindingFor(f.admission,created.threadId);
 assert.equal(f.leases[0]!.workspaceId,f.leases[1]!.workspaceId);
});
test('conflicting restored Native receipt retires only the newly allocated incarnation',async t=>{
 const f=fixture(t),created=await f.start();await f.runtime.close();
 const runtime=f.make(),context={sender:null},request={method:'thread/resume',context:()=>context};
 const operation=new OrdinaryNativeRestoration(runtime,async()=>({admission:f.admission,threadId:created.threadId}));
 t.after(()=>operation.close());
 await operation.prepare('resume',request,{threadId:created.threadId});
 await assert.rejects(operation.finalize({requestId:'resume',context,result:{thread:{id:'foreign'}}}),/conflict/);
 await assert.rejects(runtime.bindingFor(f.admission,created.threadId));
 assert.equal(f.events.filter(e=>e==='kill').length,2);
 assert.equal(f.store.forThread(f.admission.authority,created.threadId)!.workspaceId,created.workspaceId);
});
test('failed resume of an already live workspace does not destroy its published binding',async t=>{
 const f=fixture(t),created=await f.start(),context={sender:null},request={method:'thread/resume',context:()=>context};
 const binding=await f.runtime.bindingFor(f.admission,created.threadId);
 const operation=new OrdinaryNativeRestoration(f.runtime,async()=>({admission:f.admission,threadId:created.threadId}));
 t.after(()=>operation.close());
 const ready=await operation.prepare('live-resume',request,{threadId:created.threadId});assert.equal(ready.kind,'dispatch');
 await operation.finalize({requestId:'live-resume',context,error:{code:-32602}});
 assert.strictEqual(await f.runtime.bindingFor(f.admission,created.threadId),binding);
 assert.equal(f.events.includes('kill'),false);
});


test('cancelling a new restoration reclaims compute without deleting its durable working-copy identity',async t=>{
 const f=fixture(t),created=await f.start();await f.runtime.close();
 const runtime=f.make(),context={sender:null},request={method:'thread/resume',context:()=>context};
 const operation=new OrdinaryNativeRestoration(runtime,async()=>({admission:f.admission,threadId:created.threadId}));
 t.after(()=>operation.close());
 await operation.prepare('cancel-resume',request,{threadId:created.threadId});
 await operation.abort('cancel-resume');
 await assert.rejects(runtime.bindingFor(f.admission,created.threadId));
 assert.equal(f.store.forThread(f.admission.authority,created.threadId)!.workspaceId,created.workspaceId);
 assert.equal(f.events.filter(e=>e==='kill').length,2);
});
test('successful Native resume of an already live workspace keeps the original incarnation',async t=>{
 const f=fixture(t),created=await f.start(),context={sender:null},request={method:'thread/resume',context:()=>context};
 const binding=await f.runtime.bindingFor(f.admission,created.threadId);
 const operation=new OrdinaryNativeRestoration(f.runtime,async()=>({admission:f.admission,threadId:created.threadId}));
 await operation.prepare('live',request,{threadId:created.threadId});
 await operation.finalize({requestId:'live',context,result:{thread:{id:created.threadId}}});
 await operation.close();
 assert.strictEqual(await f.runtime.bindingFor(f.admission,created.threadId),binding);assert.equal(f.leases.length,1);
});


test('logical Native placement rejects path/owner injection and malformed selections',()=>{
 const target={version:1,configurationId:'installed',templateId:'base'};
 const valid={workspacePlacement:{version:1,intentId:'intent',environment:target}};
 assert.equal(readOrdinaryWorkspacePlacement({}),null);
 assert.deepEqual(readOrdinaryWorkspacePlacement(valid),{intentId:'intent',environment:target,source:{kind:'empty'}});
 for(const bad of [
   {...valid,cwd:'/workspace'}, {...valid,environments:[{environmentId:'foreign'}]},
   {workspacePlacement:{...valid.workspacePlacement,principalId:'other'}},
   {workspacePlacement:{...valid.workspacePlacement,intentId:''}},
   {workspacePlacement:{...valid.workspacePlacement,source:{version:1,kind:'library-reference',libraryId:'shared',relativePath:'../private'}}},
 ])assert.throws(()=>readOrdinaryWorkspacePlacement(bad),/Invalid workspace placement/);
});

async function routedFixture(t:test.TestContext) {
 const f=fixture(t),token='routing-private-test-token-'.repeat(3),socketPath=join(f.root,'routing.sock');
 const authority=await createWorkspaceExecutionAuthority({socketPath,token});
 t.after(()=>authority.close());
 const make=(admission=f.admission)=>{
  const context={sender:null},requests=new Map<string,{method:string;context():typeof context}>(),selections:any[]=[],frames:any[]=[];
  let current=true,defer=false;
  const hooks=ordinaryNativeRouting({hostId:'host',runtime:f.runtime,authority,admit:c=>{
   assert.strictEqual(c,context);return admission;
  },restoreProvisional:async()=>{throw Error('unused')},onCleanupUnconfirmed(){throw Error('unconfirmed')}});
  const native:DuplexTransport={status:{state:'open'},async connect(){},async close(){},
   subscribeMessage(){return()=>{}},subscribeStatus(){return()=>{}},
   async send(frame){
    const m=JSON.parse(frame);frames.push(m);
    if(!defer){const {[workspaceGrantField]:ticket,...params}=m.params;
     selections.push(await consumeWorkspaceExecutionGrant({socketPath,token},ticket,m.method,params));}
   }};
  const transport=hooks.decorateNativeTransport!(native,id=>requests.get(String(id))??null);
  t.after(()=>transport.close());
  const send=async(id:string,method:string,params:Record<string,unknown>)=>{
   requests.set(id,{method,context(){if(!current)throw Error('request retired');return context}});
   await transport.send(JSON.stringify({id,method,params}));
  };
  const receipt=(id:string,params:Record<string,unknown>,threadId:string,method='thread/start')=>
   (method==='thread/start'?hooks.finalizeNativeCreation!:hooks.finalizeNativeResume!)({requestId:id,params,context,result:{thread:{id:threadId}}});
  return {hooks,transport,send,receipt,selections,frames,defer(){defer=true},retire(){current=false}};
 };
 return {f,make,consume:async(frame:any)=>{
  const {[workspaceGrantField]:ticket,...params}=frame.params;
  return consumeWorkspaceExecutionGrant({socketPath,token},ticket,frame.method,params);
 }};
}

test('product Native router creates, executes and resumes one admitted durable workspace',async t=>{
 const {f,make}=await routedFixture(t),first=make();
 const params={workspacePlacement:{version:1,intentId:'routed',environment:f.target}};
 await first.send('same-id','thread/start',params);
 assert.equal(first.selections[0].kind,'bound');
 await first.receipt('same-id',params,'routed-thread');
 await first.send('turn','turn/start',{threadId:'routed-thread'});
 assert.equal(first.selections[1].workspaceId,first.selections[0].workspaceId);
 await first.transport.close();
 const next=make();
 await next.send('same-id','thread/resume',{threadId:'routed-thread'});
 await next.receipt('same-id',{threadId:'routed-thread'},'routed-thread','thread/resume');
 assert.equal(next.selections[0].workspaceId,first.selections[0].workspaceId);
 assert.equal(f.leases.length,1,'attachment close must not kill service-owned live workspace');
 await assert.rejects(first.receipt('same-id',params,'routed-thread'),/retired/);
 await assert.rejects(next.send('fork','thread/fork',{threadId:'routed-thread'}),/fork is not yet supported/);
});

test('product Native router never sends foreign or lost remote work through local execution',async t=>{
 const {f,make}=await routedFixture(t),created=await f.start();
 const foreign=make({...f.admission,authority:{principalId:'bob',hostId:'host'},catalog:{scope:'bob',current:()=>true}});
 await assert.rejects(foreign.send('foreign','turn/start',{threadId:created.threadId}));
 assert.equal(foreign.frames.length,0);
 const owner=make();f.losses[0]!();
 await assert.rejects(owner.send('lost','turn/start',{threadId:created.threadId}));
 assert.equal(owner.frames.length,0);
 for(const method of ['thread/resume','thread/fork']){
  await assert.rejects(owner.send('history',method,{threadId:'existing-local',history:[]}),/durable thread ID/);
  await assert.rejects(owner.send('path',method,{threadId:'existing-local',path:'/foreign/rollout'}),/durable thread ID/);
  await assert.rejects(owner.send('injected',method,{threadId:'existing-local',environments:[{environmentId:'workspace-foreign'}]}),/no admitted placement/);
 }
 assert.equal(owner.frames.length,0);
 await owner.send('local','turn/start',{threadId:'existing-local'});
 assert.deepEqual(owner.selections,[{kind:'local'}]);
});

test('private grants from a closed physical router cannot execute later',async t=>{
 const {f,make,consume}=await routedFixture(t),created=await f.start(),owner=make();
 owner.defer();await owner.send('turn','turn/start',{threadId:created.threadId});
 await owner.transport.close();
 await assert.rejects(consume(owner.frames[0]));
});


test('file scope projection is authoritative, read-only and survives compute shutdown', async t => {
 const f=fixture(t);
 assert.deepEqual(await f.runtime.fileScopeFor(f.admission,'local-thread'),{kind:'host'});
 const receipt=await f.start(), count=f.leases.length;
 assert.deepEqual(await f.runtime.fileScopeFor(f.admission,receipt.threadId),
   {kind:'workspace',threadId:receipt.threadId,root:'/workspace'});
 const bob={...f.admission,authority:{principalId:'bob',hostId:'host'},catalog:{scope:'bob',current:()=>true}};
 await assert.rejects(f.runtime.fileScopeFor(bob,receipt.threadId),/unavailable/);
 await f.runtime.close();const reopened=f.make();
 assert.deepEqual(await reopened.fileScopeFor(f.admission,receipt.threadId),
   {kind:'workspace',threadId:receipt.threadId,root:'/workspace'});
 assert.equal(f.leases.length,count,'projection must not create or restore compute');
 await assert.rejects(reopened.fileScopeFor({...f.admission,authorize:async()=>{throw Error('revoked')}},receipt.threadId),/revoked/);
});
