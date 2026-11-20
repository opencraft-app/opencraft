import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { createConversationKey } from '@opencraft/chat-core';
import { SideChatService, ConversationTerminalSessionRegistry } from '@opencraft/workbench-runtime';
import { ResourceDirectoryReconciler } from '@opencraft/workbench-runtime/resource-directory-reconciler';
import { parseResourceDirectorySignals } from '@opencraft/workbench-runtime/resource-directory-signals';
import { RemoteBrowserService } from '../../scripts/remote-browser-service.mjs';
import { RemoteBrowserStorage } from '../../apps/workbench-web/src/browser/remote-browser-storage';
import { WorkbenchResourceSync } from '../../apps/workbench-web/src/runtime/workbench-resource-sync';
import { createSynchronizedSideChatPersistence } from '../../apps/workbench-web/src/runtime/side-chat-persistence';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const disk = () => ({ length: 0, key: () => null, getItem: () => null, setItem() {}, removeItem() {} }) as unknown as Storage;
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'resource-sync-'));
  const server = new RemoteBrowserService({ root: directory, dataDirectory: directory, ownerConnector: null });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  async function client(owner = 'one') {
    const state = await server.metadata(owner, undefined, () => {}), storage: any = new RemoteBrowserStorage();
    Object.assign(storage, { initialized: true, fresh: true, scope: state.scope, values: { ...state.values }, base: { ...state.values }, keyRevisions: { ...state.keyRevisions }, revision: state.revision, root: state.root });
    storage.connect = async () => {};
    const socket = { readyState: 1, bufferedAmount: 0, send: (message: string) => { void storage.pushed(JSON.parse(message)); }, close() {} };
    storage.socket = socket; // This fixture already obtained the current server snapshot.
    const observer = { ownerId: owner, authorize() {} }; server.metadataObservers.set(socket, observer);
    storage.call = async (input: any, method = 'state') => method === 'metadata-digest' ? server.metadataDigest(owner, input, () => {}) : server.metadata(owner, input, () => {}, socket);
    const sync = new WorkbenchResourceSync(storage);
    t.after(() => { sync.dispose(); storage.dispose(); server.metadataObservers.delete(socket); });
    return { storage, sync, socket, observer };
  }
  return { server, client };
}

test('one account-wide Merkle/broadcast channel refreshes independent kinds and isolates accounts', async t => {
  const f = await fixture(t), a = await f.client(), b = await f.client(), other = await f.client('other');
  const authoritative = { terminal: [] as string[], browser: [] as string[], sidechat: [] as string[] };
  const copies = { terminal: [] as string[], browser: [] as string[], sidechat: [] as string[] }, otherCopy: string[] = [];
  for (const kind of ['terminal', 'browser', 'sidechat'] as const) b.sync.register(kind, async () => { copies[kind] = [...authoritative[kind]]; });
  other.sync.register('terminal', async () => { otherCopy.push('read'); });
  await tick(); const otherCount = otherCopy.length;
  const before = await f.server.metadataDigest('one', undefined, () => {});
  for (const kind of ['terminal', 'browser', 'sidechat'] as const) {
    authoritative[kind] = [kind + '-original']; await a.sync.notify(kind, 'host'); await tick(); await tick(); assert.deepEqual(copies[kind], authoritative[kind]);
  }
  const after = await f.server.metadataDigest('one', undefined, () => {});
  assert.notEqual(after.root, before.root); assert.notEqual(after.leaves.resourceSignals.hash, before.leaves.resourceSignals.hash);
  assert.equal(otherCopy.length, otherCount);
  f.server.metadataObservers.delete(b.socket); authoritative.terminal.push('created-during-disconnect');
  await a.sync.notify('terminal', 'host'); await tick(); assert.equal(copies.terminal.length, 1);
  f.server.metadataObservers.set(b.socket, b.observer); await b.storage.reconcile(); await tick(); await tick();
  assert.deepEqual(copies.terminal, authoritative.terminal);
  // External owner changed with no emitted notification at all. Even an equal
  // metadata root triggers the external directory's authorized read.
  authoritative.terminal.push('created-without-client-hint'); await b.storage.reconcile(); await tick();
  assert.deepEqual(copies.terminal, authoritative.terminal);
});

test('invalidation during an authoritative read drains another pass; failure does not erase a directory', async () => {
  const reconciler = new ResourceDirectoryReconciler(); let release!: () => void, reads = 0, revision = 0, visible = 0;
  const gate = new Promise<void>(r => { release = r; });
  const first = reconciler.invalidate('terminal', async () => { reads++; const captured = revision; await gate; visible = captured; });
  await tick(); revision = 2;
  const second = reconciler.invalidate('terminal', async () => { reads++; visible = revision; });
  release(); await Promise.all([first, second]); assert.equal(visible, 2); assert.equal(reads, 2);
  await assert.rejects(reconciler.invalidate('terminal', async () => { throw Error('offline'); })); assert.equal(visible, 2);
  await reconciler.invalidate('terminal', async () => { visible = 3; }); assert.equal(visible, 3);
  const queued = reconciler.invalidate('other', async () => { visible = 99; });
  reconciler.dispose(); await queued; assert.equal(visible, 3); await reconciler.invalidate('terminal', async () => { visible = 4; }); assert.equal(visible, 3);
});

test('a failed shared metadata write can be retried without reload and does not poison other fields', async t => {
  const f = await fixture(t), a = await f.client(); const persistence = createSynchronizedSideChatPersistence(a.storage, disk());
  const parent = createConversationKey('host', 'parent'), row = { id: 'one', parent, key: createConversationKey('host', 'child') };
  await persistence.put(row); const call = a.storage.call; let attempts = 0;
  a.storage.call = async (...args: any[]) => { if (++attempts === 1) throw Error('temporary write failure'); return call(...args); };
  await assert.rejects(persistence.remove('one'), /temporary/); assert.deepEqual(persistence.list(parent), [row]);
  assert.equal(a.storage.isReady, true); await a.sync.notify('terminal', 'host'); assert.deepEqual(persistence.list(parent), [row]);
  await persistence.remove('one'); assert.deepEqual(persistence.list(parent), []);
  await a.sync.notify('terminal', 'host'); assert.ok(attempts >= 3);
});

test('a second side chat arriving during recovery is eventually acquired without re-entry', async () => {
  const parent = createConversationKey('host', 'parent'), row = (id: string) => ({ id, parent, key: createConversationKey('host', 'child-' + id) });
  let rows = [row('a')], changed = () => {}, release!: () => void; const gate = new Promise<void>(r => { release = r; }), calls: string[] = [];
  const ctx = new Context(), fiber = ctx.plugin(SideChatService, { persistence: { list: () => rows, put() {}, remove() {}, subscribe(fn) { changed = fn; return () => {}; } }, resolveHost: async () => ({ acquireThread: async (id: string) => { calls.push(id); if (id === 'child-a') await gate; return { release() {} }; } }) as any }); await fiber;
  const restoring = ctx.sideChats.restore(parent); await tick(); rows = [row('a'), row('b')]; changed(); release(); await restoring;
  assert.ok(ctx.sideChats.get('b')); assert.deepEqual(calls, ['child-a', 'child-b']); await fiber.dispose();
});

test('terminal hints announce only native acceptance/explicit close, not output, attach or app teardown', async () => {
  const listeners = new Set<() => void>(); let phase = 'starting', signals = 0, kills = 0, listed = 0;
  const snapshot = () => ({ phase, exitCode: null, output: [], processId: 'p', connectionGeneration: 1, error: null });
  const session = { processId: 'p', getSnapshot: snapshot, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, terminate: async () => { kills++; phase = 'exited'; }, dispose: async () => {} };
  const processes: any[] = [];
  const runtime: any = { resources: { terminal: { open: () => session, attach: () => session, list: async () => { listed++; return { processes }; } } } };
  const registry = new ConversationTerminalSessionRegistry(() => runtime, undefined, () => { signals++; });
  const stop = registry.subscribe('owner', () => {}); await registry.restore('host', 'owner', { threadId: 'thread' });
  const id = registry.open({ hostId: 'host', resourceOwnerId: 'owner', threadId: 'thread', cwd: '/' }); assert.equal(signals, 0);
  phase = 'running'; for (const fn of listeners) fn(); assert.equal(signals, 1);
  for (const fn of listeners) fn(); assert.equal(signals, 1);
  processes.push({ processHandle: 'p', phase: 'running', context: { resourceOwnerId: 'owner', threadId: 'thread', cwd: '/', shell: 'bash' } });
  processes.push({ processHandle: 'other', phase: 'running', context: { resourceOwnerId: 'owner', threadId: 'thread', cwd: '/', shell: 'bash' } });
  await registry.refreshDirectories(); assert.equal(listed, 4); assert.equal(signals, 1); assert.equal(kills, 0);
  registry.release(id); await tick(); assert.equal(signals, 2); assert.equal(kills, 1);
  stop(); await registry.refreshDirectories(); assert.equal(listed, 4); await registry.dispose(); assert.equal(kills, 1);
});

test('resource hints have bounded canonical identities and never carry authority or tab view state', () => {
  const row = { id: JSON.stringify(['terminal', 'host']), kind: 'terminal', hostId: 'host', token: crypto.randomUUID() };
  assert.deepEqual(parseResourceDirectorySignals([row]), [row]);
  for (const invalid of [[row, row], [{ ...row, id: 'other' }], [{ ...row, selected: true }], Array(257).fill(row)]) assert.throws(() => parseResourceDirectorySignals(invalid));
});

test('terminal repair keeps resources on failed reads, refreshes a missed exit, and detaches pruned native entries without kill', async () => {
  let phase = 'running', nativePhase = 'running', fail = false, gone = false, refreshes = 0, kills = 0, disposed = 0;
  const session: any = { processId: 'original', getSnapshot: () => ({ phase, exitCode: null }), subscribe: () => () => {},
    refresh: async () => { refreshes++; phase = nativePhase; }, terminate: async () => { kills++; }, dispose: async () => { disposed++; } };
  const runtime: any = { resources: { terminal: { open: () => session, attach: () => session, list: async () => {
    if (fail) throw Error('Host offline');
    return { processes: gone ? [] : [{ processHandle: 'original', phase: nativePhase, context: { resourceOwnerId: 'owner', threadId: 'thread', cwd: '/', shell: 'bash' } }] };
  } } } };
  const registry = new ConversationTerminalSessionRegistry(() => runtime), stop = registry.subscribe('owner', () => {});
  await registry.restore('host', 'owner', { threadId: 'thread' }); const [id] = registry.listForOwner('owner');
  fail = true; await assert.rejects(registry.refreshDirectories()); assert.equal(registry.get(id), session);
  fail = false; nativePhase = 'exited'; await registry.refreshDirectories(); assert.equal(refreshes, 1); assert.equal(phase, 'exited'); assert.equal(kills, 0);
  gone = true; await registry.refreshDirectories(); assert.deepEqual(registry.listForOwner('owner'), []); assert.equal(disposed, 1); assert.equal(kills, 0);
  stop(); await registry.dispose();
});

test('a failed broad Draft alias read cannot prune a previously adopted terminal', async () => {
  let broadFails = false, disposed = 0;
  const session: any = { processId: 'draft', getSnapshot: () => ({ phase: 'running', exitCode: null }), subscribe: () => () => {}, dispose: async () => { disposed++; } };
  const runtime: any = { resources: { terminal: { attach: () => session, list: async (scope?: any) => {
    if (scope?.threadId) return { processes: [] };
    if (broadFails) throw Error('Broad query unavailable');
    return { processes: [{ processHandle: 'draft', phase: 'running', context: { resourceOwnerId: 'old-draft', threadId: null, cwd: '/', shell: 'bash' } }] };
  } } } };
  const registry = new ConversationTerminalSessionRegistry(() => runtime), stop = registry.subscribe('owner', () => {});
  await registry.restore('host', 'owner', { threadId: 'promoted' }, ['old-draft']);
  broadFails = true; await registry.refreshDirectories(); assert.equal(registry.listForOwner('owner').length, 1); assert.equal(disposed, 0);
  stop(); await registry.dispose();
});

test('independent owners survive a failing peer and report recovery without losing a projection', async t => {
  const f = await fixture(t), client = await f.client();
  let fail = true, healthyReads = 0;
  client.sync.register('terminal', async () => { if (fail) throw new Error('offline'); });
  client.sync.register('terminal', async () => { healthyReads++; });
  await tick(); await tick();
  assert.ok(healthyReads > 0);
  assert.deepEqual(client.sync.getStatus('terminal'), { pending: false, failed: true, lastSuccessAt: null });
  fail = false; client.sync.refresh(); await tick(); await tick();
  assert.equal(client.sync.getStatus('terminal')?.failed, false);
  assert.equal(typeof client.sync.getStatus('terminal')?.lastSuccessAt, 'number');
});

test('unregister and disposal fence owners waiting behind an active refresh', async t => {
  const f = await fixture(t), client = await f.client();
  let release!: () => void, lateCalls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stopFirst = client.sync.register('terminal', () => gate);
  const stopSecond = client.sync.register('terminal', async () => { lateCalls++; });
  await tick(); stopSecond(); stopFirst();
  const stopNew = client.sync.register('terminal', async () => { lateCalls++; });
  client.sync.dispose(); release(); await tick(); await tick(); stopNew();
  assert.equal(lateCalls, 0);
  assert.equal(client.sync.getStatus('terminal'), undefined);
  client.sync.register('terminal', async () => { lateCalls++; });
  await tick(); assert.equal(lateCalls, 0);
});

test('committed absence never consumes an unacknowledged resource signal', async () => {
  let changed: (field: string) => void = () => {}, reads = 0;
  let optimistic: string | null = null;
  const sync = new WorkbenchResourceSync({
    whenReady: async () => {}, getItem: () => optimistic, setItem() {},
    getCommittedItem: () => null,
    onCommittedMetadataChanged(fn) { changed = fn; return () => {}; },
  });
  sync.register('terminal', async () => { reads++; });
  await tick(); const before = reads;
  optimistic = JSON.stringify([{ id: '["terminal","host"]', kind: 'terminal', hostId: 'host', token: crypto.randomUUID() }]);
  changed('resourceSignals'); await tick();
  assert.equal(reads, before); sync.dispose();
});

test('reconciler preserves even an undefined rejection and retries on the next invalidation', async () => {
  const reads = new ResourceDirectoryReconciler();
  let rejected = false;
  await reads.invalidate('owner', async () => { throw undefined; }).catch(error => { rejected = true; assert.equal(error, undefined); });
  assert.equal(rejected, true);
  await reads.invalidate('owner', async () => {});
  reads.dispose();
});
