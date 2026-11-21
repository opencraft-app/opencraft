import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SideChatService } from '@opencraft/workbench-runtime';
import { createConversationKey } from '@opencraft/chat-core';
import { parseSideChatDirectory, validateSideChatDirectoryTransition } from '@opencraft/workbench-runtime/side-chat-records';
import { mergeMetadataValue } from '@opencraft/browser-core/metadata-sync';
import { RemoteBrowserService } from '../../apps/headless-server/src/remote-browser-service.mjs';
import { RemoteBrowserStorage } from '../../apps/workbench-web/src/browser/remote-browser-storage';
import { createSynchronizedSideChatPersistence, createSideChatPersistence } from '../../apps/workbench-web/src/runtime/side-chat-persistence';

const parent = createConversationKey('host', 'parent');
const row = (id: string) => ({ id, parent, key: createConversationKey('host', 'child-' + id) });
function localStorage() {
  const m = new Map<string, string>();
  return { get length() { return m.size; }, key: (i: number) => [...m.keys()][i] ?? null, getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear() };
}
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'sidechat-sync-'));
  const server = new RemoteBrowserService({ root: directory, dataDirectory: directory, ownerConnector: null });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const clients: any[] = [];
  async function client(owner = 'actor-one') {
    const initial = await server.metadata(owner, undefined, () => {});
    const storage: any = new RemoteBrowserStorage();
    Object.assign(storage, { initialized: true, fresh: true, scope: initial.scope, values: { ...initial.values }, base: { ...initial.values }, revision: initial.revision, keyRevisions: { ...initial.keyRevisions } });
    storage.acceptSideChatDirectory(initial.sideChatDirectory);
    const pushes: Promise<void>[] = [];
    const socket = { readyState: 1, bufferedAmount: 0, send: (message: string) => { pushes.push(storage.pushed(JSON.parse(message))); }, close() {} };
    storage.socket = socket; storage.snapshotRevision = initial.revision; storage.committedSnapshot(initial);
    server.metadataObservers.set(socket, { ownerId: owner, authorize: () => {} });
    storage.connect = async () => {};
    storage.call = async (input: any, method: string = 'state') => ['digest', 'metadata-digest'].includes(method) ? server.metadataDigest(owner, input, () => {}) : server.metadata(owner, input, () => {}, socket);
    const disk = localStorage();
    const persistence = createSynchronizedSideChatPersistence(storage, disk);
    const result = { storage, persistence, disk, pushes, socket, async settled() { await storage.flush(); await Promise.all(pushes); } };
    clients.push(result);
    t.after(() => { storage.dispose(); server.metadataObservers.delete(socket); });
    return result;
  }
  async function settle() {
    for (let i = 0; i < 5; i++) { for (const c of clients) await c.settled(); await new Promise(r => setTimeout(r, 0)); }
  }
  return { server, client, settle };
}

test('two independent clients discover original references and isolate another account', async t => {
  const f = await fixture(t), a = await f.client(), b = await f.client(), other = await f.client('other-account');
  await a.persistence.put(row('one')); await f.settle();
  assert.deepEqual(b.persistence.list(parent), [row('one')]);
  assert.deepEqual(other.persistence.list(parent), []);
  await b.persistence.put(row('two')); await f.settle();
  assert.deepEqual(a.persistence.list(parent).map(r => r.id).sort(), ['one', 'two']);
  await b.persistence.remove('one'); await f.settle();
  assert.deepEqual(a.persistence.list(parent).map(r => r.id), ['two']);
  const fresh = await f.client(); assert.deepEqual(fresh.persistence.list(parent).map(r => r.id), ['two']);
  await assert.rejects(a.persistence.put(row('one')), /closed/);
});

test('durable tombstones beat stale initial imports and concurrent close/edit conflicts', () => {
  const open = JSON.stringify([row('one')]), closed = JSON.stringify([{ id: 'one', closed: true }]);
  for (const [base, local, remote] of [['[]', open, closed], [open, closed, open], [open, open, closed]]) {
    const merged = JSON.parse(mergeMetadataValue('sideChats', base, local, remote)!);
    assert.deepEqual(merged, [{ id: 'one', closed: true }]);
  }
  assert.throws(() => validateSideChatDirectoryTransition(parseSideChatDirectory(JSON.parse(closed)), [row('one')]), /cannot be reopened/);
  assert.throws(() => parseSideChatDirectory([row('one'), row('one')]), /identity/);
  assert.throws(() => parseSideChatDirectory([{ ...row('one'), key: createConversationKey('other-host', 'child') }]), /record/);
});

test('Server rejects reopening, identity rebinding and account-scope spoofing even with fresh revisions', async t => {
  const f = await fixture(t), a = await f.client();
  await a.persistence.put(row('one')); await a.persistence.remove('one');
  const current = await f.server.metadata('actor-one', undefined, () => {});
  const input = { key: 'sideChats', value: JSON.stringify([row('one')]), mutationId: crypto.randomUUID(), scope: current.scope, expectedKeyRevision: current.keyRevisions.sideChats };
  await assert.rejects(f.server.metadata('actor-one', input, () => {}), /cannot be reopened/);
  await assert.rejects(f.server.metadata('different', input, () => {}), /account changed/);
  await assert.rejects(f.server.metadata('actor-one', undefined, () => { throw Error('revoked'); }), /revoked/);
});

test('a remote close detaches a live reader and fences a delayed acquisition without duplicate interrupt', async t => {
  const f = await fixture(t), a = await f.client(), b = await f.client();
  await a.persistence.put(row('one')); await f.settle();
  let release = 0, resolve!: (value: any) => void;
  const ctx = new Context();
  const fiber = ctx.plugin(SideChatService, { persistence: a.persistence, resolveHost: async () => ({ acquireThread: () => new Promise(r => { resolve = r; }) }) as any }); await fiber;
  const restoring = ctx.sideChats.restore(parent); await new Promise(r => setTimeout(r, 0));
  await b.persistence.remove('one'); await f.settle();
  resolve({ release() { release++; } }); await restoring;
  assert.equal(ctx.sideChats.get('one'), null); assert.deepEqual(ctx.sideChats.records(parent), []); assert.equal(release, 1);
  await fiber.dispose();
});

test('legacy references are uploaded only after a successful authorized history read', async t => {
  const f = await fixture(t), a = await f.client();
  createSideChatPersistence(a.disk).put(row('one'));
  let reads = 0, authorized = false;
  const ctx = new Context(), fiber = ctx.plugin(SideChatService, { persistence: a.persistence, resolveHost: async () => ({ acquireThread: async () => ({
    release() {}, retryRestore: async () => { reads++; authorized = true; }, getSnapshot: () => ({ authoritative: authorized, error: null }),
  }) }) as any }); await fiber;
  await ctx.sideChats.restore(parent); await f.settle();
  assert.equal(reads, 1); assert.deepEqual(a.persistence.list(parent), [row('one')]);
  assert.deepEqual(createSideChatPersistence(a.disk).list(parent), []);
  await fiber.dispose();
});

test('a denied legacy history read never uploads a reference into the new account', async t => {
  const f = await fixture(t), a = await f.client();
  createSideChatPersistence(a.disk).put(row('one'));
  let released = 0;
  const ctx = new Context(), fiber = ctx.plugin(SideChatService, { persistence: a.persistence, resolveHost: async () => ({ acquireThread: async () => ({
    release() { released++; }, retryRestore: async () => { throw Error('denied'); },
  }) }) as any }); await fiber;
  await ctx.sideChats.restore(parent);
  assert.deepEqual(a.persistence.list(parent), []); assert.deepEqual(ctx.sideChats.records(parent), []);
  assert.equal(released, 1); assert.match(ctx.sideChats.getRecoveryError('one')!.message, /denied/);
  await fiber.dispose();
});

test('remote closing a live view releases its lease without interrupt or another unsubscribe', async t => {
  const f = await fixture(t), a = await f.client(), b = await f.client();
  await a.persistence.put(row('one')); await f.settle();
  let released = 0;
  const ctx = new Context(), fiber = ctx.plugin(SideChatService, { persistence: a.persistence, resolveHost: async () => ({ acquireThread: async () => ({
    release() { released++; }, getSnapshot: () => ({ activeTurn: { turnId: 'running' } }), interrupt() { throw Error('must not interrupt remotely'); },
  }) }) as any }); await fiber;
  await ctx.sideChats.restore(parent); assert.ok(ctx.sideChats.get('one'));
  await b.persistence.remove('one'); await f.settle();
  assert.equal(ctx.sideChats.get('one'), null); assert.equal(released, 1);
  await fiber.dispose();
});

test('a Server restart retains close tombstones and original directory references', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sidechat-sync-restart-'));
  let server = new RemoteBrowserService({ root: directory, dataDirectory: directory, ownerConnector: null });
  const initial = await server.metadata('account', undefined, () => {});
  await server.metadata('account', { key: 'sideChats', value: JSON.stringify([{ id: 'gone', closed: true }, row('live')]), scope: initial.scope, expectedKeyRevision: 0, mutationId: crypto.randomUUID() }, () => {});
  await server.close(); server = new RemoteBrowserService({ root: directory, dataDirectory: directory, ownerConnector: null });
  try {
    const restored = await server.metadata('account', undefined, () => {});
    assert.deepEqual(JSON.parse(restored.values.sideChats), [{ id: 'gone', closed: true }, row('live')]);
    assert.deepEqual((await server.metadata('other', undefined, () => {})).values, {});
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('unacknowledged or failed metadata writes cannot become authoritative resource closes', async t => {
  const f = await fixture(t), a = await f.client();
  await a.persistence.put(row('one'));
  a.storage.call = async () => { throw Error('fixture write rejected'); };
  const removed = a.persistence.remove('one');
  assert.deepEqual(a.persistence.list(parent), [row('one')]);
  await assert.rejects(removed, /rejected/);
  assert.deepEqual(a.persistence.list(parent), [row('one')]);
});

test('own acknowledgement neither duplicates a pending acquisition nor steals its explicit close', async t => {
  const f = await fixture(t), a = await f.client();
  let acquired = 0, interrupted = 0, released = 0, unsubscribed = 0;
  const ctx = new Context(), fiber = ctx.plugin(SideChatService, { persistence: a.persistence, resolveHost: async () => ({
    resources: { threads: { fork: async () => ({ id: 'child-one' }), injectItems: async () => {}, unsubscribe: async () => { unsubscribed++; } } },
    acquireThread: async () => { acquired++; return { getSnapshot: () => ({ activeTurn: { turnId: 'active' } }), release() { released++; }, interrupt: async () => { interrupted++; } }; },
  }) as any }); await fiber;
  await ctx.sideChats.open('one', parent, null); await f.settle();
  assert.equal(acquired, 1);
  await ctx.sideChats.close('one'); await f.settle();
  assert.equal(interrupted, 1); assert.equal(released, 1); assert.equal(unsubscribed, 1);
  await fiber.dispose();
});

test('application disposal after Server acceptance detaches without broadcasting an implicit close', async () => {
  let finish!: () => void, accepted: any, released = 0, removed = 0, unsubscribed = 0;
  const ctx = new Context();
  const fiber = ctx.plugin(SideChatService, { persistence: {
    list: () => accepted ? [accepted] : [],
    put: async record => { accepted = record; await new Promise<void>(resolve => { finish = resolve; }); },
    remove: () => { removed++; },
  }, resolveHost: async () => ({ resources: { threads: { fork: async () => ({ id: 'child-one' }), injectItems: async () => {}, unsubscribe: async () => { unsubscribed++; } } },
    acquireThread: async () => ({ release() { released++; } }),
  }) as any }); await fiber;
  const opening = ctx.sideChats.open('one', parent, null);
  await new Promise(resolve => setTimeout(resolve, 0)); assert.ok(accepted);
  await fiber.dispose(); finish();
  await assert.rejects(opening, /cancelled/);
  assert.equal(accepted.id, 'one'); assert.equal(released, 1); assert.equal(removed, 0); assert.equal(unsubscribed, 0);
});

test('closed side chats retain ownership across a fresh client without reading or starting an engine', async t => {
  const f = await fixture(t), a = await f.client();
  await a.persistence.put(row('one')); await a.persistence.remove('one');
  const fresh = await f.client(), other = await f.client('other-account');
  assert.deepEqual(fresh.persistence.directory?.(), [{ ...row('one'), closed: true }]);
  for (const [client, expected] of [[fresh, 'side-chat'], [other, 'independent']] as const) {
    const ctx = new Context(), fiber = ctx.plugin(SideChatService, { persistence: client.persistence,
      resolveHost: async () => { throw Error('Catalog classification must not connect to an engine'); } });
    await fiber;
    try {
      assert.equal(ctx.sideChats.ownershipOf(row('one').key).kind, expected);
      assert.equal(ctx.sideChats.ownershipOf(createConversationKey('other-host', 'child-one')).kind, 'independent');
      assert.equal(ctx.sideChats.ownershipOf(createConversationKey('host', 'ordinary-fork')).kind, 'independent');
      assert.deepEqual(ctx.sideChats.records(parent), []);
    } finally { await fiber.dispose(); }
  }
});

test('legacy close writes are canonicalized with existing ownership and keep exact-input receipts', async t => {
  const f = await fixture(t), a = await f.client(); await a.persistence.put(row('one'));
  const previous = await f.server.metadata('actor-one', undefined, () => {});
  const input = { key: 'sideChats', value: JSON.stringify([{ id: 'one', closed: true }]), scope: previous.scope,
    expectedKeyRevision: previous.keyRevisions.sideChats, mutationId: crypto.randomUUID() };
  const receipt = await f.server.metadata('actor-one', input, () => {});
  assert.equal((await f.server.metadata('actor-one', input, () => {})).keyRevision, receipt.keyRevision);
  const next = await f.server.metadata('actor-one', undefined, () => {});
  assert.deepEqual(JSON.parse(next.values.sideChats), [{ id: 'one', closed: true }], 'Strict v1 clients retain the original leaf schema');
  assert.deepEqual(JSON.parse(next.sideChatDirectory.value), [{ ...row('one'), closed: true }]);
  await assert.rejects(f.server.metadata('actor-one', { ...input, expectedKeyRevision: next.keyRevisions.sideChats,
    mutationId: crypto.randomUUID(), value: JSON.stringify([{ ...row('one'), key: createConversationKey('host', 'rebound'), closed: true }]) }, () => {}), /immutable/);
});

test('close-winning merge preserves known bindings regardless of writer order', () => {
  const open = JSON.stringify([row('one')]);
  const bound = JSON.stringify([{ ...row('one'), closed: true }]);
  const legacy = JSON.stringify([{ id: 'one', closed: true }]);
  for (const [local, remote] of [[open, bound], [bound, open], [bound, legacy], [legacy, bound]]) {
    assert.deepEqual(JSON.parse(mergeMetadataValue('sideChats', open, local, remote)!), JSON.parse(bound));
  }
  assert.deepEqual(validateSideChatDirectoryTransition(parseSideChatDirectory(JSON.parse(open)), parseSideChatDirectory(JSON.parse(legacy))), JSON.parse(bound));
  assert.throws(() => validateSideChatDirectoryTransition(parseSideChatDirectory(JSON.parse(legacy)), parseSideChatDirectory(JSON.parse(bound))), /immutable/,
    'An old identity-only tombstone cannot be rebound by guessing its source');
});

test('a close for a different native child cannot retire an existing side-chat identity', async t => {
  const f = await fixture(t), a = await f.client(); await a.persistence.put(row('one'));
  await assert.rejects(a.persistence.remove('one', { ...row('one'), key: createConversationKey('host', 'different-child') }), /immutable/);
  assert.deepEqual(a.persistence.list(parent), [row('one')]);
});

test('old-client closes retain bindings through live pushes and congestion digest recovery', async t => {
  const f = await fixture(t), a = await f.client(), b = await f.client();
  await a.persistence.put(row('one')); await f.settle();
  b.socket.bufferedAmount = 300_000; // Force fingerprint-only push.
  const previous = await f.server.metadata('actor-one', undefined, () => {});
  await f.server.metadata('actor-one', { key: 'sideChats', value: JSON.stringify([{ id: 'one', closed: true }]),
    scope: previous.scope, expectedKeyRevision: previous.keyRevisions.sideChats, mutationId: crypto.randomUUID() }, () => {});
  await Promise.all(b.pushes); await b.storage.reconcile(['sideChats']);
  assert.deepEqual(b.persistence.list(parent), []);
  assert.deepEqual(b.persistence.directory?.(), [{ ...row('one'), closed: true }]);
  assert.deepEqual(JSON.parse(b.storage.getItem('opencraft.side-chats.v1')!), [{ id: 'one', closed: true }]);
});

test('binding intents for a failed creation are atomic, v1-compatible and part of receipt identity', async t => {
  const f = await fixture(t), a = await f.client();
  await a.persistence.remove('one', row('one'));
  assert.deepEqual(a.persistence.directory?.(), [{ ...row('one'), closed: true }]);
  const previous = await f.server.metadata('actor-one', undefined, () => {});
  assert.deepEqual(JSON.parse(previous.values.sideChats), [{ id: 'one', closed: true }]);
  const value = JSON.stringify([{ id: 'one', closed: true }, { id: 'two', closed: true }]);
  const input = { key: 'sideChats', value, sideChatDirectory: JSON.stringify([{ ...row('one'), closed: true }, { ...row('two'), closed: true }]),
    scope: previous.scope, expectedKeyRevision: previous.keyRevisions.sideChats, mutationId: crypto.randomUUID() };
  await f.server.metadata('actor-one', input, () => {});
  await assert.rejects(f.server.metadata('actor-one', { ...input, sideChatDirectory: JSON.stringify([{ ...row('one'), closed: true },
    { ...row('two'), key: createConversationKey('host', 'different'), closed: true }]) }, () => {}), /reused/);
  const fresh = await f.client(); assert.deepEqual(fresh.persistence.directory?.(), [{ ...row('one'), closed: true }, { ...row('two'), closed: true }]);
});
