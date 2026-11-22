import assert from 'node:assert/strict';
import test from 'node:test';
import { readConversationPage, readConversationTail, readConversationProjectPage, readConversationModelPage, readConversationOptions, projectConversationMetadata } from '@opencraft/access-control/conversation-projections';
import { CollaborationClient } from '../../packages/appserver-client/src/collaboration';
import { MemoryTransport } from '@opencraft/appserver-transport-memory';
import { encodeJsonRpcMessage, isJsonRpcRequest } from '@opencraft/appserver-protocol';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActorStore } from '@opencraft/access-control/actors';
import { Collaboration, type ConversationExecutionPort } from '@opencraft/access-control/collaboration';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRoutedConversationExecution } from '../../apps/headless-server/src/conversation-execution.mjs';

test('metadata is an allowlisted server projection without title fallback or message content', () => {
  const result = projectConversationMetadata('server', { id: 'thread', name: 'sensitive-title', preview: 'sensitive-preview',
    turns: [{ items: [{ text: 'sensitive-message' }] }], status: { type: 'idle' }, cwd: '/repo', projectId: null });
  assert.equal(JSON.stringify(result).includes('sensitive'), false);
  assert.equal(result.cwd, '/repo'); assert.equal(result.runtime, 'idle');
  assert.equal(projectConversationMetadata('server', { id: 't', preview: 'body' }, true).title, undefined);
});

test('history pages bound native reads, preserve Unicode long-message tails and fence watermarks', async () => {
  const ref = { serverId: 's', threadId: 't' }, content = '🦉'.repeat(4501);
  let revision = 1;
  const calls: any[] = [];
  const invoke = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === 'thread/read') { assert.equal(params.includeTurns, false); return { thread: { id: 't', updatedAt: revision } }; }
    assert.equal(method, 'thread/items/list'); assert.equal(params.limit, 1);
    return { data: [{ turnId: 'turn', item: { type: 'agentMessage', id: 'item', text: content } }], nextCursor: null };
  };
  let cursor: string | null = null, text = '';
  do {
    const page = await readConversationPage(invoke, ref, cursor);
    assert.ok(Array.from(page.entries[0].text).length <= 2000);
    text += page.entries[0].text; cursor = page.nextCursor;
  } while (cursor);
  assert.equal(text, content);
  const page = await readConversationPage(invoke, ref, null);
  revision++;
  await assert.rejects(readConversationPage(invoke, ref, page.nextCursor), { code: 'history_changed' });
  assert.ok(calls.length > 0);
});

test('old Host capabilities fail before issuing content reads or mutations', async () => {
  const methods: string[] = [];
  const transport = new MemoryTransport({ server: { receive(frame, peer) {
    const message = JSON.parse(frame);
    if (!isJsonRpcRequest(message)) return;
    methods.push(message.method);
    if (message.method === 'initialize') peer.send(encodeJsonRpcMessage({ id: message.id, result: { codexHome: '/synthetic', platformFamily: 'unix', platformOs: 'linux', userAgent: 'fixture', capabilities: { extensions: { 'opencraft/collaboration': { version: 1, read: true } } } } }));
  } } });
  const client = new CollaborationClient(transport);
  try {
    await client.connect();
    await assert.rejects(client.metadata({ serverId: 's', threadId: 't' }), { code: 'UNSUPPORTED_CAPABILITY' });
    await assert.rejects(client.read({ serverId: 's', threadId: 't' }), { code: 'UNSUPPORTED_CAPABILITY' });
    await assert.rejects(client.projects('s'), { code: 'UNSUPPORTED_CAPABILITY' });
    await assert.rejects(client.models('s'), { code: 'UNSUPPORTED_CAPABILITY' });
    await assert.rejects(client.options({ serverId: 's', threadId: 't' }), { code: 'UNSUPPORTED_CAPABILITY' });
    assert.throws(() => client.discover('s', undefined, false, { projectId: 'p' }), { code: 'UNSUPPORTED_CAPABILITY' });
    assert.deepEqual(methods, ['initialize']);
  } finally { await client.close(); }
});

test('unsupported engines reject bounded logs before any native history read', () => {
  let opened = 0;
  const execution = createRoutedConversationExecution(() => ({hostState: () => 'idle', accept() { opened++; throw Error('must not open'); }}),
    {machineId:'fixture',engines:['dsh'],getInputs:async()=>undefined});
  const server = execution.directory().servers.find((row: any) => row.engine === 'dsh');
  assert.equal(server.capabilities.read, false); assert.equal(server.capabilities.boundedRead, false);
  assert.throws(() => execution.readBounded({serverId:server.serverId,threadId:'legacy-dsh'},null), {code:'unsupported_capability'});
  assert.equal(opened,0);
});

test('CLI help and invalid arguments return one versioned JSON value with stable exit codes', async () => {
  const invoke = (...args: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx',
    fileURLToPath(new URL('../../apps/opencraft-cli/src/main.ts', import.meta.url)), ...args, '--json']);
  const help = JSON.parse((await invoke('--help')).stdout);
  assert.equal(help.schemaVersion, 1); assert.equal(help.ok, true);
  for (const args of [['unknown'], ['thread','show'], ['thread','show','ref','--cursor','bad'], ['project','list','--include-title']]) {
    await assert.rejects(invoke(...args), (error: any) => {
      assert.equal(error.code, 2); const output = JSON.parse(error.stdout);
      assert.equal(output.ok, false); assert.equal(output.error.code, 'INVALID_ARGUMENTS');
      return true;
    });
  }
});


test('a 24 MiB conversation reads through bounded pages without requesting full turns',async()=>{
 const ref={serverId:'s',threadId:'large'}, body='x'.repeat(1024*1024), count=24;
 let itemReads=0;
 const invoke=async(method:string,params:any)=>{
  if(method==='thread/read'){assert.equal(params.includeTurns,false);return {thread:{id:ref.threadId,updatedAt:1}};}
  assert.equal(method,'thread/items/list');assert.equal(params.limit,1);itemReads++;
  const index=params.sortDirection==='desc'?count-1:Number(params.cursor??0);
  return {data:[{turnId:'turn',item:{id:String(index),type:index===0?'commandExecution':'agentMessage',text:body}}],nextCursor:index<count-1?String(index+1):null};
 };
 const first=await readConversationPage(invoke,ref,null);
 assert.deepEqual(first.entries,[]);assert.ok(first.nextCursor);
 const second=await readConversationPage(invoke,ref,first.nextCursor);
 assert.equal(second.entries[0].text.length,2000);assert.ok(second.nextCursor);
 assert.ok(Buffer.byteLength(JSON.stringify(second))<10000);assert.equal(itemReads,6);
});

test('tail reads only recent native turns and returns their bounded text in chronological order', async () => {
  const ref = { serverId: 's', threadId: 't' };
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const history = await readConversationTail(async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === 'thread/read') {
      assert.equal(params.includeTurns, false);
      return { thread: { id: ref.threadId } };
    }
    if (method === 'thread/turns/list') {
      assert.equal(params.limit, 2);
      assert.equal(params.sortDirection, 'desc');
      assert.equal(params.itemsView, 'notLoaded');
      return { data: [{ id: 'new' }, { id: 'previous' }], nextCursor: 'older' };
    }
    assert.equal(method, 'thread/items/list');
    assert.equal(params.sortDirection, 'desc');
    assert.equal(params.limit, 30);
    const turnId = params.turnId;
    return { data: [
      { turnId, item: { id: 'response', type: 'agentMessage', text: turnId === 'new' ? '🦉'.repeat(2001) : 'previous response' } },
      { turnId, item: { id: 'tool', type: 'commandExecution', aggregatedOutput: 'never returned' } },
      { turnId, item: { id: 'prompt', type: 'userMessage', content: [{ type: 'text', text: turnId + ' prompt' }] } },
    ], nextCursor: null };
  }, ref, 2);
  assert.deepEqual(calls.filter(c => c.method === 'thread/items/list').map(c => c.params.turnId), ['new', 'previous']);
  assert.deepEqual(history.entries.map(e => [e.turnId, e.role, e.text]), [
    ['previous', 'user', 'previous prompt'], ['previous', 'assistant', 'previous response'],
    ['new', 'user', 'new prompt'], ['new', 'assistant', '🦉'.repeat(2000)],
  ]);
  assert.equal(history.entries.at(-1).offset, 1);
  assert.equal(history.latestTurnId, 'new');
  assert.equal(history.nextCursor, null);
  assert.equal(history.truncated, true);
});

test('project discovery issues a bounded native page and exposes only stable project IDs, names and roots', async () => {
  const calls: unknown[] = [];
  const invoke = async (method: string, params: { limit: number; cursor: string | null }) => {
    calls.push([method, params]);
    return params.cursor ? { data: [], nextCursor: null } : {
      data: [{ id: 'project-id', name: 'Fixture project', roots: [{ path: '/workspace/example', internal: 'private' }], metadata: { value: 'not visible' } }],
      nextCursor: '30',
    };
  };
  const first = await readConversationProjectPage(invoke, 'server:one:codex', null);
  assert.deepEqual(first.projects, [{ id: 'project-id', name: 'Fixture project', roots: [{ path: '/workspace/example' }] }]);
  assert.ok(first.nextCursor);
  await assert.rejects(readConversationProjectPage(invoke, 'server:other:codex', first.nextCursor), { code: 'invalid_cursor' });
  await assert.rejects(readConversationProjectPage(invoke, 'server:one:codex', '30'), { code: 'invalid_cursor' });
  const last = await readConversationProjectPage(invoke, 'server:one:codex', first.nextCursor);
  assert.deepEqual(last, { serverId: 'server:one:codex', projects: [], nextCursor: null });
  assert.deepEqual(calls, [
    ['project/list', { limit: 30, cursor: null }],
    ['project/list', { limit: 30, cursor: '30' }],
  ]);
  await assert.rejects(readConversationProjectPage(async () => ({
    data: [{ id: 'project-id', name: 'Fixture project', roots: [{ path: '../relative' }] }],
  }), 'server:one:codex', null), { code: 'project_catalog_unavailable' });
});

test('model pages preserve bounded policy-filtered continuation and allowlist advertised options', async () => {
  const model = { id: 'id', model: 'engine-model', supportedReasoningEfforts: [{ reasoningEffort: 'medium', hidden: 'private' }],
    serviceTiers: [{ id: 'fast', description: 'private' }], providerCredentials: 'private' };
  const seen: (string | null)[] = [];
  const invoke = async (method: string, params: { limit: number; includeHidden: boolean; cursor: string | null }) => {
    assert.equal(method, 'model/list');
    assert.equal(params.limit, 30);
    assert.equal(params.includeHidden, false);
    seen.push(params.cursor);
    return params.cursor
      ? { data: [model, { ...model, model: 'unselectable', policySelectable: false }], nextCursor: null }
      : { data: [{ ...model, hidden: true }], nextCursor: 'native:30' };
  };
  const first = await readConversationModelPage(invoke, 'codex', null);
  assert.deepEqual(first.models, []);
  assert.ok(first.nextCursor);
  await assert.rejects(readConversationModelPage(invoke, 'other', first.nextCursor), { code: 'invalid_cursor' });
  await assert.rejects(readConversationProjectPage(invoke, 'codex', first.nextCursor), { code: 'invalid_cursor' });
  const second = await readConversationModelPage(invoke, 'codex', first.nextCursor);
  assert.deepEqual(second.models, [{ id: 'id', model: 'engine-model', reasoningEfforts: ['medium'], serviceTiers: ['fast'] }]);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(seen, [null, 'native:30']);
});

test('execution options are read-only observations of the exact thread and native requirements', async () => {
  const ref = { serverId: 'codex', threadId: 'target' };
  let optionalSupported = true;
  const invoke = async (method: string, params: Record<string, unknown>) => {
    if (method === 'thread/read') {
      assert.equal(params.includeTurns, false);
      return { thread: { id: ref.threadId, cwd: '/repo', model: 'engine-model', reasoningEffort: 'medium',
        preview: 'private', turns: [{ text: 'private' }] } };
    }
    if (method === 'model/list') return { data: [], nextCursor: null };
    if (method === 'configRequirements/read') {
      if (!optionalSupported) throw Object.assign(Error('unsupported'), { code: -32601 });
      return { requirements: { allowedApprovalPolicies: ['on-request'], allowedSandboxModes: ['read-only'],
        allowedPermissionProfiles: null, additionalDeveloperInstructions: 'private' } };
    }
    if (method === 'permissionProfile/list') {
      assert.equal(params.cwd, '/repo');
      return { data: [
        { id: 'opencraft:permission-mode:read-only', openCraftNativeProfileId: ':read-only', openCraftMode: 'read-only', allowed: true },
        { id: ':danger-full-access', allowed: true }, { id: 'unknown-private-profile', allowed: true },
      ], nextCursor: null };
    }
    if (method === 'collaborationMode/list') {
      if (!optionalSupported) throw Object.assign(Error('unsupported'), { code: -32601 });
      return { data: [{ mode: 'plan' }, { mode: 'default' }, { mode: 'private' }] };
    }
    throw Error('unexpected method: ' + method);
  };
  const options = await readConversationOptions(invoke, ref);
  assert.deepEqual(options.nativeConfirmedConfiguration, { model: 'engine-model', reasoningEffort: 'medium' });
  assert.deepEqual(options.optionCatalog.permissionModes?.map(({ mode, allowed }) => ({ mode, allowed })), [
    { mode: 'read-only', allowed: true }, { mode: 'full', allowed: false },
  ]);
  assert.deepEqual(options.optionCatalog.collaborationModes, ['plan', 'default']);
  assert.doesNotMatch(JSON.stringify(options), /private/);
  optionalSupported = false;
  const partial = await readConversationOptions(invoke, ref);
  assert.equal(partial.optionCatalog.requirementsConfigured, null);
  assert.equal(partial.optionCatalog.permissionModes?.[0].allowed, null);
  assert.equal(partial.optionCatalog.collaborationModes, null);
});

test('thread options require current conversation ownership both before and after native observations', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cli-options-access-'));
  const actors = new ActorStore(join(dir, 'actors.sqlite'), Date.now, { policy: () => true });
  const actor = actors.resolveHuman({ provider: 'local', subject: 'fixture', displayName: 'Viewer', expiresAt: Date.now() + 60_000 })!;
  const ref = { serverId: 'fixture', threadId: 'target' };
  let ownerActorId = actor.actorId, changeOwner = true, reads = 0, modelReads = 0;
  const foreign = 'foreign';
  const observedAt = Date.now();
  const port: ConversationExecutionPort = {
    serverId: ref.serverId, hostId: 'local-codex',
    directory: () => ({ instanceId: 'fixture', servers: [ref.serverId, foreign].map(serverId => ({ serverId, engine: 'codex',
      label: 'Codex', connectionState: 'ready', capabilities: {
        metadata: true, read: true, boundedRead: true, queue: true, steer: true, executionOptions: true, modelDiscovery: true,
      } })) }),
    async models(serverId) {
      modelReads++;
      return { serverId, models: [], nextCursor: null, observedAt };
    },
    async options(target, context) {
      reads++;
      assert.deepEqual(target, ref);
      assert.equal(context.actorContext?.actorId, actor.actorId);
      if (changeOwner) ownerActorId = 'other';
      return { ref, observedAt, nativeConfirmedConfiguration: { model: 'fixture-model', reasoningEffort: null },
        modelCatalog: { serverId: ref.serverId, models: [], nextCursor: null, observedAt },
        optionCatalog: { cwd: null, requirementsConfigured: null, permissionModes: null, collaborationModes: null } };
    },
    async validate() {}, async receipt() { return null; }, async add() { return null; }, async steer() {}, async cancel() { return false; },
  };
  const service = new Collaboration(join(dir,'collaboration.sqlite'), actors, port, Date.now, () => true, undefined,
    () => true, undefined, async threadId => {
      assert.equal(threadId, ref.threadId);
      return { serverId: ref.serverId, ownerActorId };
    });
  t.after(async () => {
    await service.close();
    actors.close();
    await rm(dir, { recursive: true, force: true });
  });
  assert.equal(service.capabilities.modelDiscovery, true);
  assert.equal((await service.command(actor, { action: 'models', serverId: ref.serverId })).serverId, ref.serverId);
  await assert.rejects(service.command(actor, { action: 'models', serverId: foreign }), { status: 404 });
  assert.equal(modelReads, 1);
  assert.equal(service.capabilities.executionOptions, true);
  await assert.rejects(service.command(actor, { action: 'options', reference: ref }), { status: 403 });
  await assert.rejects(service.command(actor, { action: 'options', reference: ref }), { status: 403 });
  assert.equal(reads, 1, 'after losing access, another read cannot reach native');
  ownerActorId = actor.actorId;
  changeOwner = false;
  const result = await service.command(actor, { action: 'options', reference: ref });
  assert.equal(result.nativeConfirmedConfiguration.model, 'fixture-model');
  assert.equal(reads, 2);
});
