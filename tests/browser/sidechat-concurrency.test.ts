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
import { RemoteBrowserService } from '../../scripts/remote-browser-service.mjs';
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

test('concurrent sidechat writers', async t => {
 const f=await fixture(t),a=await f.client(),b=await f.client();
 // Simulate a second device whose committed-change push has not arrived yet.
 f.server.metadataObservers.delete(b.socket);
 await a.persistence.put(row('concurrent-a'));
 await b.persistence.put(row('concurrent-b'));
 await f.settle();
 assert.deepEqual(b.persistence.list(parent).map(r=>r.id).sort(),['concurrent-a','concurrent-b']);
});


test('stale addition preserves another device close and its immutable binding', async t => {
 const f=await fixture(t), a=await f.client();
 await a.persistence.put(row('old')); await f.settle();
 const b=await f.client(); f.server.metadataObservers.delete(b.socket);
 await a.persistence.remove('old', row('old'));
 await b.persistence.put(row('new')); await f.settle();
 assert.deepEqual(b.persistence.list(parent).map(r=>r.id), ['new']);
 assert.deepEqual(b.persistence.directory?.().find(r=>r.id==='old'), {...row('old'),closed:true});
});


test('Sidechat remains writable after a browser resource was retired', async t => {
 const f = await fixture(t), a = await f.client();
 await f.server.commit(draft => {
   draft.retiredResources.push({ key: JSON.stringify(['actor-one', 'browser-closed']), ownerId: 'actor-one', lease: 'browser-closed', pageIds: ['closed'], tabIds: ['closed-tab'] });
 });
 await a.persistence.put(row('after-browser-close'));
 await f.settle();
 assert.deepEqual(a.persistence.list(parent), [row('after-browser-close')]);
 await a.persistence.remove('after-browser-close', row('after-browser-close'));
 await f.settle();
 assert.deepEqual(a.persistence.list(parent), []);
});
