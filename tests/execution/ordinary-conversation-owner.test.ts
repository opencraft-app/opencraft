import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrdinaryWorkspaceStore } from '../../apps/local-agent-host/src/ordinary-workspace-store';
import { OrdinaryConversationOwner, type OrdinaryCreationOptions, type OrdinaryRestoreOptions } from '../../apps/local-agent-host/src/ordinary-conversation-owner';
const authority = { principalId: 'alice', hostId: 'host' };
function fixture(t: test.TestContext) {
 const root = mkdtempSync(join(tmpdir(), 'ordinary-owner-'));
 const store = new OrdinaryWorkspaceStore(root, 'test'), owner = new OrdinaryConversationOwner(store);
 const owners = new Set([owner]);
 t.after(async () => { for (const current of owners) await current.close().catch(() => {}); store.close(); rmSync(root, { recursive: true, force: true }); });
 const events: string[] = [];
 const fields = { cwd: '/workspace', runtimeWorkspaceRoots: ['/workspace'], environments: [{ environmentId: 'workspace-test', cwd: '/workspace' }] };
 let revoked = false;
 const options: OrdinaryCreationOptions = {
  authority, intentId: 'intent', selection: { version: 1, environment: { configurationId: 'e2b', configurationRevision: 'a'.repeat(64), templateId: 'base', cpuMillis: 1000, memoryBytes: 1024 }, source: { kind: 'empty' } },
  async authorize() { if (revoked) throw Error('revoked'); },
  async allocate(lease) { events.push('allocate'); assert.equal(store.read(authority, lease.workspaceId).phase, 'creating');
   return { instanceId: 'instance', privateVolumeId: 'volume', environment: { resources: { cpuMillis: 1000, memoryBytes: 1024 }, capabilities: { terminal: false }, async spawn() { throw Error('not used'); }, async close() {} }, async close() { events.push('kill'); } }; },
  async prepare(_allocation, _authorize, context) { fields.environments[0] && (fields.environments[0].environmentId = context.environmentId); events.push('prepare'); return { async executionFields() { return fields; }, async close() { events.push('binding-close'); } }; },
  async nativeStart() { events.push('native'); assert.equal(store.pendingThreadStarts('host').length, 1); return { thread: { id: 'thread' } }; },
 };
 return { store, owner, options, events, fields, newOwner() { const next = new OrdinaryConversationOwner(store); owners.add(next); return next; }, revoke() { revoked = true; } };
}
test('composed creation persists receipt, routes by trusted scope, deduplicates and closes in order', async t => {
 const f = fixture(t), receipt = await f.owner.start(f.options);
 assert.equal(f.store.forThread(authority, 'thread')?.workspaceId, receipt.workspaceId);
 assert.deepEqual(await f.owner.start(f.options), receipt);
 assert.equal(f.events.filter(e => e === 'native').length, 1);
 assert.deepEqual(await (await f.owner.bindingFor(authority, 'thread')).executionFields(), f.fields);
 await assert.rejects(f.owner.bindingFor({ ...authority, principalId: 'bob' }, 'thread'), /unavailable/);
 await f.owner.close(); assert.deepEqual(f.events, ['allocate', 'prepare', 'native', 'binding-close', 'kill']);
 assert.equal(f.store.read(authority, receipt.workspaceId).phase, 'idle');
 await assert.rejects(f.owner.bindingFor(authority, 'thread'), /unavailable/);
});
test('lost Native reply cleans compute but fences every retry', async t => {
 const f = fixture(t); f.options.nativeStart = async () => { f.events.push('native'); throw Error('timeout'); };
 await assert.rejects(f.owner.start(f.options), /timeout/);
 await assert.rejects(f.owner.start(f.options), /reconciliation/);
 assert.deepEqual(f.events, ['allocate', 'prepare', 'native', 'binding-close', 'kill']);
 assert.equal(f.store.pendingThreadStarts('host')[0].binding.phase, 'idle');
});
test('pre-dispatch failure is retryable and never calls Native', async t => {
 const f = fixture(t), prepare = f.options.prepare;
 f.options.prepare = async () => { throw Error('bootstrap'); };
 await assert.rejects(f.owner.start(f.options), /bootstrap/);
 assert.equal(f.store.pendingThreadStarts('host').length, 0);
 f.options.prepare = prepare; await f.owner.start(f.options);
 assert.equal(f.events.filter(e => e === 'allocate').length, 2);
});
test('authorization lost during Native call retains receipt without publishing binding', async t => {
 const f = fixture(t); f.options.nativeStart = async () => { f.revoke(); return { thread: { id: 'late' } }; };
 await assert.rejects(f.owner.start(f.options), /revoked/);
 assert.equal(f.store.forThread(authority, 'late')?.phase, 'idle');
 assert.equal(f.store.pendingThreadStarts('host').length, 0);
 await assert.rejects(f.owner.bindingFor(authority, 'late'), /unavailable/);
});
test('shutdown waits for late Native response and reclaims exact allocation', async t => {
 const f = fixture(t); let resolve!: (v: unknown) => void, started!: () => void;
 const began = new Promise<void>(r => started = r);
 f.options.nativeStart = async () => { started(); return new Promise(r => resolve = r); };
 const pending = assert.rejects(f.owner.start(f.options), /closed/); await began;
 const closing = f.owner.close(); resolve({ thread: { id: 'late' } });
 await pending; await closing; assert.equal(f.store.forThread(authority, 'late')?.phase, 'idle');
 assert.deepEqual(f.events.slice(-2), ['binding-close', 'kill']);
});
test('invalid local execution binding fails before Native dispatch', async t => {
 const f = fixture(t); f.fields.environments = [];
 await assert.rejects(f.owner.start(f.options), /Invalid ordinary execution/);
 assert.equal(f.store.pendingThreadStarts('host').length, 0);
 assert.equal(f.events.includes('native'), false);
});
test('binding cleanup failure still deletes compute and makes shutdown fail visibly', async t => {
 const f = fixture(t); f.options.prepare = async (_a, _authorize, context) => ({ async executionFields() { return { ...f.fields, environments: [{ environmentId: context.environmentId, cwd: '/workspace' }] }; }, async close() { throw Error('bridge'); } });
 await f.owner.start(f.options); await assert.rejects(f.owner.close(), /cleanup unconfirmed/);
 assert.equal(f.events.filter(e => e === 'kill').length, 1);
});
test('concurrent same-intent submissions invoke Native exactly once', async t => {
 const f = fixture(t); let resolve!: (v: unknown) => void, started!: () => void;
 const began = new Promise<void>(r => started = r);
 f.options.nativeStart = async () => { f.events.push('native'); started(); return new Promise(r => resolve = r); };
 const first = f.owner.start(f.options); await began;
 await assert.rejects(f.owner.start(f.options), /reconciliation/);
 resolve({ thread: { id: 'thread' } }); await first;
 assert.equal(f.events.filter(e => e === 'allocate').length, 1);
 assert.equal(f.events.filter(e => e === 'native').length, 1);
});
test('malformed Native response remains uncertain, never publishes a binding', async t => {
 const f = fixture(t); f.options.nativeStart = async () => ({ thread: {} });
 await assert.rejects(f.owner.start(f.options), /receipt missing/);
 assert.equal(f.store.pendingThreadStarts('host').length, 1);
 await assert.rejects(f.owner.start(f.options), /reconciliation/);
});
test('mutating admission input during authorization cannot replace persisted identity', async t => {
 const f = fixture(t), original = structuredClone(f.options.selection);
 f.options.authority = { ...authority };
 f.options.authorize = async selection => {
  assert.deepEqual(selection, original);
  selection.environment.templateId = 'callback-mutated';
  f.options.selection.environment.templateId = 'caller-mutated';
  f.options.authority.principalId = 'bob';
 };
 const receipt = await f.owner.start(f.options);
 assert.deepEqual(f.store.resolvedSelection(authority, receipt.workspaceId), original);
 assert.equal(f.store.forThread({ ...authority, principalId: 'bob' }, 'thread'), null);
});

function restoreOptions(f: ReturnType<typeof fixture>): OrdinaryRestoreOptions {
 return { ...f.options, threadId: 'thread', async inspect() { return 'absent'; },
  async nativeResume(threadId, fields) { f.events.push('resume'); assert.equal(fields.cwd, '/workspace'); return { thread: { id: threadId } }; } };
}
test('new owner restores same workspace/volume and exact selection without creating a Native thread', async t => {
 const f = fixture(t), first = await f.owner.start(f.options), environmentId = f.fields.environments[0].environmentId;
 await f.owner.close(); const next = f.newOwner(), options = restoreOptions(f);
 options.authorize = async selection => assert.deepEqual(selection, f.options.selection);
 options.prepare = async (allocation, authorize, context) => {
  assert.equal(context.threadId, 'thread'); assert.equal(context.environmentId, environmentId);
  return f.options.prepare(allocation, authorize, context);
 };
 assert.deepEqual(await next.restore(options), first);
 assert.deepEqual(await next.restore(options), first);
 assert.equal(f.events.filter(e => e === 'native').length, 1);
 assert.equal(f.events.filter(e => e === 'resume').length, 1);
 assert.equal(f.store.read(authority, first.workspaceId).generation, 2);
 assert.equal(f.store.read(authority, first.workspaceId).privateVolumeId, 'volume');
});
test('unconfirmed old live member blocks restore; verified absence permits same workspace only', async t => {
 const f = fixture(t), first = await f.owner.start(f.options); await f.owner.close();
 const abandoned = f.store.beginCreate(authority, first.workspaceId);
 f.store.recordProviderReceipt(authority, abandoned, { instanceId: 'abandoned', privateVolumeId: 'volume' });
 f.store.confirmCreated(authority, abandoned, 'abandoned');
 const next = f.newOwner(), options = restoreOptions(f);
 for (const result of ['present', 'unknown'] as const) {
  options.inspect = async binding => { assert.equal(binding.privateVolumeId, 'volume'); return result; };
  await assert.rejects(next.restore(options), /requires reconciliation/);
 }
 assert.equal(f.events.filter(e => e === 'allocate').length, 1);
 options.inspect = async () => 'absent';
 await next.restore(options); assert.equal(f.store.read(authority, first.workspaceId).generation, 3);
});
test('revoked exact selection and wrong principal cannot allocate during restore', async t => {
 const f = fixture(t); await f.owner.start(f.options); await f.owner.close(); const next = f.newOwner(), options = restoreOptions(f);
 await assert.rejects(next.restore({ ...options, authority: { ...authority, principalId: 'bob' } }), /not found/);
 options.authorize = async () => { throw Error('catalog generation revoked'); };
 await assert.rejects(next.restore(options), /revoked/);
 assert.equal(f.events.filter(e => e === 'allocate').length, 1);
});
test('resume timeout or wrong receipt releases compute and never changes the persisted thread', async t => {
 const f = fixture(t), first = await f.owner.start(f.options); await f.owner.close(); const next = f.newOwner(), options = restoreOptions(f);
 options.nativeResume = async () => { throw Error('resume timeout'); };
 await assert.rejects(next.restore(options), /timeout/);
 assert.equal(f.store.read(authority, first.workspaceId).phase, 'idle');
 options.nativeResume = async () => ({ thread: { id: 'wrong' } });
 await assert.rejects(next.restore(options), /receipt conflict/);
 assert.equal(f.store.read(authority, first.workspaceId).threadId, 'thread');
 assert.equal(f.store.pendingThreadStarts('host').length, 0);
 await next.restore(restoreOptions(f));
});
test('concurrent restores cannot reconcile away a pending in-process allocation', async t => {
 const f = fixture(t); await f.owner.start(f.options); await f.owner.close(); const next = f.newOwner(), options = restoreOptions(f);
 let release!: () => void, entered!: () => void;
 const began = new Promise<void>(r => entered = r), gate = new Promise<void>(r => release = r);
 options.allocate = async (...args) => { entered(); await gate; return f.options.allocate(...args); };
 const first = next.restore(options); await began;
 await assert.rejects(next.restore(options), /already pending/); release(); await first;
 assert.equal(f.events.filter(e => e === 'allocate').length, 2);
});

test('thread-scoped resources attach only after the receipt is durable', async t => {
 const f = fixture(t), prepare = f.options.prepare; let attached = 0;
 f.options.prepare = async (...args) => ({ ...await prepare(...args), async bindThread(threadId) {
  assert.equal(f.store.forThread(authority, threadId)?.threadId, threadId); attached++;
 } });
 await f.owner.start(f.options); assert.equal(attached, 1);
 await f.owner.close(); const next = f.newOwner(); await next.restore(restoreOptions(f)); assert.equal(attached, 2);
});
test('transport loss invalidates published routing and reclaims compute before shutdown', async t => {
 const f = fixture(t), prepare = f.options.prepare; let lost!: () => void;
 f.options.prepare = async (...args) => { lost = args[2].onLost; return prepare(...args); };
 const receipt = await f.owner.start(f.options); lost(); lost();
 await assert.rejects(f.owner.bindingFor(authority, receipt.threadId), /unavailable|lost/);
 await f.owner.close(); assert.equal(f.events.filter(e => e === 'kill').length, 1);
 assert.equal(f.store.read(authority, receipt.workspaceId).phase, 'idle');
});
test('loss during preparation cleans the late binding and never calls Native', async t => {
 const f = fixture(t), prepare = f.options.prepare;
 f.options.prepare = async (...args) => { args[2].onLost(); return prepare(...args); };
 await assert.rejects(f.owner.start(f.options), /transport lost/);
 assert.deepEqual(f.events, ['allocate', 'prepare', 'binding-close', 'kill']);
 assert.equal(f.store.pendingThreadStarts('host').length, 0);
});
test('loss during Native response saves positive evidence but does not expose resources', async t => {
 const f = fixture(t), prepare = f.options.prepare; let lost!: () => void;
 f.options.prepare = async (...args) => { lost = args[2].onLost; return prepare(...args); };
 f.options.nativeStart = async () => { lost(); return { thread: { id: 'late' } }; };
 await assert.rejects(f.owner.start(f.options), /transport lost/);
 assert.equal(f.store.forThread(authority, 'late')?.phase, 'idle');
 await assert.rejects(f.owner.bindingFor(authority, 'late'), /unavailable/);
});
test('loss after restore invalidates its routing and releases the replacement instance', async t => {
 const f = fixture(t); await f.owner.start(f.options); await f.owner.close();
 const next = f.newOwner(), options = restoreOptions(f), prepare = options.prepare; let lost!: () => void;
 options.prepare = async (...args) => { lost = args[2].onLost; return prepare(...args); };
 await next.restore(options); lost();
 await assert.rejects(next.bindingFor(authority, 'thread'), /unavailable|lost/);
 await next.close(); assert.equal(f.events.filter(e => e === 'kill').length, 2);
});

test('Native admission receives the prepared private binding and exact durable lease generation', async t => {
 const f = fixture(t), prepare = f.options.prepare; const generations: number[] = [];
 let prepared: Awaited<ReturnType<typeof prepare>>;
 f.options.prepare = async (allocation, authorize, context) => {
  generations.push(context.generation);
  assert.equal(context.environmentId, 'workspace-' + context.workspaceId);
  prepared = await prepare(allocation, authorize, context); return prepared;
 };
 const nativeStart = f.options.nativeStart;
 f.options.nativeStart = async (fields, binding) => { assert.equal(binding, prepared); return nativeStart(fields, binding); };
 await f.owner.start(f.options); await f.owner.close();
 const next = f.newOwner(), options = restoreOptions(f), resume = options.nativeResume;
 options.nativeResume = async (threadId, fields, binding) => { assert.equal(binding, prepared); return resume(threadId, fields, binding); };
 await next.restore(options);
 assert.deepEqual(generations, [1, 2]);
});


test('archiving a parent cannot retire compute shared with an active child', async t => {
 const f=fixture(t),first=await f.owner.start(f.options);
 const fork=f.store.beginThreadFork(authority,'thread','fork');
 f.store.confirmThreadForked(authority,fork.lease,'fork','child');
 await assert.rejects(f.owner.applyThreadLifecycle({hostId:authority.hostId,threadId:'thread',state:'archived',generation:1}), /Shared workspace cleanup requires reconciliation/);
 assert.equal(f.store.hasActiveMembers(authority,first.workspaceId),true);
 assert.equal(f.store.read(authority,first.workspaceId).phase,'live');
 assert.equal(f.events.filter(event=>event==='kill').length,0);
 await assert.rejects(f.owner.bindingFor(authority,'thread'),/retired|archived/);
});

test('active lifecycle observation never retires a workspace', async t => {
 const f=fixture(t),first=await f.owner.start(f.options);
 assert.deepEqual(await f.owner.applyThreadLifecycle({hostId:authority.hostId,threadId:'thread',state:'active',generation:1}),{managed:true});
 assert.equal(f.store.read(authority,first.workspaceId).phase,'live');
 assert.equal(f.events.filter(event=>event==='kill').length,0);
 await f.owner.bindingFor(authority,'thread');
});


test('shared member restore reuses one allocation and archive closes only its view', async t => {
 const f=fixture(t),prepare=f.options.prepare,views=new Map<string,{closed:boolean}>();
 f.options.prepare=async (...args)=>{
  const root=await prepare(...args);
  return {...root,async forThread(threadId:string){
   let state=views.get(threadId);if(!state||state.closed){state={closed:false};views.set(threadId,state);}
   const viewState=state;
   return {...root,isCurrent:()=>!viewState.closed,async close(){viewState.closed=true;}};
  },async closeThread(threadId:string){const state=views.get(threadId);if(state)state.closed=true;}};
 };
 const started=await f.owner.start(f.options),parent=await f.owner.bindingFor(authority,'thread');
 const fork=f.store.beginThreadFork(authority,'thread','side');f.store.confirmThreadForked(authority,fork.lease,'side','child');
 const restored=await f.owner.restore({...restoreOptions(f),threadId:'child',async nativeResume(id){return {thread:{id}}}});
 assert.equal(restored.workspaceId,started.workspaceId);assert.equal(f.events.filter(x=>x==='allocate').length,1);
 const child=await f.owner.bindingFor(authority,'child');assert.notEqual(parent,child);
 assert.deepEqual(await f.owner.applyThreadLifecycle({hostId:authority.hostId,threadId:'thread',state:'archived',generation:1}),{managed:true});
 assert.equal(parent.isCurrent?.(),false);assert.equal(child.isCurrent?.(),true);
 assert.equal(f.store.read(authority,started.workspaceId).phase,'live');assert.equal(f.events.filter(x=>x==='kill').length,0);
 await f.owner.bindingFor(authority,'child');
 assert.deepEqual(await f.owner.applyThreadLifecycle({hostId:authority.hostId,threadId:'child',state:'archived',generation:1}),{managed:true});
 assert.equal(f.events.filter(x=>x==='kill').length,1);assert.equal(f.store.read(authority,started.workspaceId).phase,'idle');
});


test('private volume deletion waits for every archived member and survives a failed receipt', async t => {
 const f=fixture(t),first=await f.owner.start(f.options),fork=f.store.beginThreadFork(authority,'thread','side');
 f.store.confirmThreadForked(authority,fork.lease,'side','child');await f.owner.close();
 let calls=0,fail=true;
 const owner=new OrdinaryConversationOwner(f.store,async input=>{
  assert.equal(input.deletePrivateVolume,true);assert.equal(input.binding.workspaceId,first.workspaceId);
  await input.authorize();calls++;if(fail)throw Error('synthetic unknown');
 });
 t.after(()=>owner.close());
 for(const id of ['thread','child'])await owner.applyThreadLifecycle({hostId:authority.hostId,threadId:id,state:'archived',generation:1});
 await owner.applyThreadLifecycle({hostId:authority.hostId,threadId:'thread',state:'deleted',generation:2});
 assert.equal(calls,0);
 await assert.rejects(owner.applyThreadLifecycle({hostId:authority.hostId,threadId:'child',state:'deleted',generation:2}),/synthetic unknown/);
 assert.equal(calls,1);assert.throws(()=>f.store.beginCreate(authority,first.workspaceId),/reconciliation/);
 const restarted=new OrdinaryConversationOwner(f.store,async input=>{assert.equal(input.deletePrivateVolume,true);await input.authorize();calls++;});
 t.after(()=>restarted.close());fail=false;
 await restarted.applyThreadLifecycle({hostId:authority.hostId,threadId:'child',state:'deleted',generation:2});
 assert.equal(calls,2);assert.equal(f.store.beginPrivateVolumeDeletion(authority,first.workspaceId).state,'deleted');
});


test('the same lifecycle generation can reconcile an uncertain private deletion', async t => {
 const f=fixture(t),first=await f.owner.start(f.options);await f.owner.close();
 let calls=0;
 const owner=new OrdinaryConversationOwner(f.store,async input=>{await input.authorize();if(++calls===1)throw Error('synthetic unknown');});
 t.after(()=>owner.close());
 await owner.applyThreadLifecycle({hostId:authority.hostId,threadId:'thread',state:'archived',generation:1});
 const deletion={hostId:authority.hostId,threadId:'thread',state:'deleted' as const,generation:2};
 await assert.rejects(owner.applyThreadLifecycle(deletion),/synthetic unknown/);
 await owner.applyThreadLifecycle(deletion);
 assert.equal(calls,2);assert.equal(f.store.beginPrivateVolumeDeletion(authority,first.workspaceId).state,'deleted');
});
