import { readBrowserState, makeLegacyBrowserState } from './browser-state-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { RemoteBrowserService } from '../../apps/headless-server/src/remote-browser-service.mjs';
import { RemoteBrowserStorage } from '../../apps/workbench-web/src/browser/remote-browser-storage';
import { WebBrowserPageRuntime } from '../../apps/workbench-web/src/browser/web-browser-runtime';
import { BrowserWorkbenchCoordinator } from '../../apps/workbench-web/src/browser/browser-workbench-coordinator';
import { subscribeBrowserMetadata } from '../../apps/workbench-web/src/browser/browser-metadata-sync';
import { createConversationBindingStore } from '@opencraft/workbench-runtime';

class Native extends RemoteBrowserService {
  commands: any[] = []; native = new Map<string, any>();
  async start() { await this.load(); }
  async request(id: string, method: string, input: any) {
    this.commands.push({ id, method, input });
    if (method === 'create') this.native.set(id, { document: randomUUID(), width: 1280, height: 720, deviceProfile: 'desktop', navigation: { url: 'about:blank' } });
    if (method === 'navigate') this.native.get(id).navigation.url = input.url;
    if (method === 'create' || method === 'snapshot') return this.native.get(id);
    if (method === 'close') this.native.delete(id);
  }
}
const grant = (callId: string) => ({ ownerId: 'owner', hostId: 'host', threadId: 'thread', turnId: 'turn', callId, authorize() {} });
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'browser-metadata-sync-'));
  const service = new Native({ root: directory, dataDirectory: directory, ownerConnector: null });
  const server = createServer(); server.on('upgrade', (request, socket, head) => service.upgrade(request, socket, head, { ownerId: 'owner', authorize() {} }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const saved = new Map(['WebSocket', 'location', 'localStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: WebSocket });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: `http://127.0.0.1:${(server.address() as any).port}/` } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem() { return null; } } });
  const clients: RemoteBrowserStorage[] = [];
  t.after(async () => {
    for (const client of clients) client.dispose(); service.close(); await service.persistence;
    await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true });
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key];
  });
  return { service, directory, async client() { const client = await RemoteBrowserStorage.create(); clients.push(client); return client; } };
}
async function eventually(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() > deadline) assert.fail('metadata projection did not converge'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('creation invalidation merges queued edits and imports the same page/tab identity without presentation', async t => {
  const f = await fixture(t), original = await f.service.createTab(grant('original'), { url: 'https://example.test/one' });
  const storage = await f.client();
  const bindings = createConversationBindingStore({ persistence: { load: () => JSON.parse(storage.getItem('opencraft.conversation-bindings.v1') ?? '[]') } });
  const surfaces: any = { restoreStorage() {}, close() {}, navigate() { assert.fail('metadata import opened a native surface'); } };
  const pages = new WebBrowserPageRuntime(surfaces, null, () => null, storage);
  const panels: any = { open() { assert.fail('background creation stole presentation'); }, close() {}, dispatch() {} };
  const workbench = new BrowserWorkbenchCoordinator(pages, panels, bindings, storage);
  const unsubscribe = subscribeBrowserMetadata(storage, bindings, surfaces, pages, workbench);
  t.after(() => { unsubscribe(); workbench.dispose(); pages.dispose(); bindings.dispose(); });
  const before = pages.getSnapshot(original.pageId), metadata = f.service.metadata.bind(f.service);
  let admitted!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { admitted = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release?.()); let held = false;
  f.service.metadata = async (owner: string, input: any, authorize: () => void) => {
    if (input?.key === 'tabs' && !held) { held = true; admitted(); await gate; }
    return metadata(owner, input, authorize);
  };
  workbench.setViewportMode(original.tabId, { type: 'fit', width: 600, height: 400 }); await started;
  workbench.setViewportMode(original.tabId, { type: 'fit', width: 700, height: 500 });
  const created = await f.service.createTab(grant('new'), { url: 'https://example.test/two' });
  release(); await storage.flush();
  await eventually(() => workbench.getConversationTabs('host', 'thread').length === 2);
  assert.equal(workbench.getTabSnapshot(created.tabId)?.pageId, created.pageId);
  assert.equal(pages.getSnapshot(original.pageId), before, 'existing native/page state remains in place');
  assert.equal(storage.isReady, true);
  const state = await metadata('owner', undefined, () => {}), tabs = JSON.parse(state.values.tabs);
  assert.equal(tabs.length, 2); assert.equal(tabs.find((row: any) => row.id === original.tabId).viewportMode.width, 700);
  assert.equal(f.service.commands.filter(call => call.method === 'create').length, 2);
  assert([...f.service.pages.values()].every(page => f.service.viewers(page).size === 0));
  assert.equal(f.service.metadataPeers.size, 1);
});

test('concurrent viewport observations converge to the committed record without disabling the browser', async t => {
  const f = await fixture(t); await f.service.createTab(grant('original'), { url: 'https://example.test/one' });
  const storage = await f.client(), key = 'opencraft.browser-tabs.v1';
  const base = storage.getItem(key)!, remote = JSON.parse(base), local = JSON.parse(base);
  remote[0].viewportMode = { type: 'fit', width: 600, height: 400 }; local[0].viewportMode = { type: 'fit', width: 700, height: 500 };
  const current = await f.service.metadata('owner', undefined, () => {});
  await f.service.metadata('owner', { scope: current.scope, key: 'tabs', value: JSON.stringify(remote), expectedKeyRevision: current.keyRevisions.tabs, mutationId: randomUUID() }, () => {});
  storage.setItem(key, JSON.stringify(local)); await storage.flush();
  assert.equal(storage.getItem(key), JSON.stringify(remote)); assert.equal(storage.isReady, true);
  const attached = JSON.parse(storage.getItem(key)!); attached[0].panelAttached = true;
  storage.setItem(key, JSON.stringify(attached)); await storage.flush();
  assert.equal(storage.isReady, true); remote[0].panelAttached = true;
  assert.equal((await f.service.metadata('owner', undefined, () => {})).values.tabs, JSON.stringify(remote));
});

test('creation failure cannot publish a partial metadata graph and lost native ACK retains one identity', async t => {
  const f = await fixture(t), commit = f.service.commit.bind(f.service);
  f.service.commit = (reduce: any, selection: any) => commit((draft: any) => { reduce(draft); throw new Error('storage rejected draft'); }, selection);
  await assert.rejects(f.service.createTab(grant('once'), { url: 'https://example.test/' }), /storage rejected/);
  assert.equal(f.service.store.current.pages.length, 0); assert.equal(f.service.store.current.states.length, 0); assert.equal(f.service.commands.length, 0);
  f.service.commit = commit;
  const request = f.service.request.bind(f.service); let lost = true;
  f.service.request = async (...args: any[]) => {
    const result = await (request as any)(...args);
    if (args[1] === 'create' && lost) { lost = false; throw Object.assign(new Error('lost native ACK'), { code: 'BROWSER_UNAVAILABLE', outcome: 'unknown' }); }
    return result;
  };
  await assert.rejects(f.service.createTab(grant('once'), { url: 'https://example.test/' }), { outcome: 'unknown' });
  const original = (await f.service.conversationTabs('owner', 'host', 'thread', () => {}))[0];
  const recovered = await f.service.createTab(grant('once'), { url: 'https://example.test/' });
  assert.equal(recovered.tabId, original.tabId); assert.equal(f.service.commands.filter(call => call.method === 'create').length, 1);
  assert.equal(f.service.store.current.pages.length, 1);
  const revision = f.service.store.current.states[0][1].revision;
  f.service.close(); await f.service.persistence;
  const restarted = new Native({ root: f.directory, dataDirectory: f.directory, ownerConnector: null });
  try {
    const again = await restarted.createTab(grant('once'), { url: 'https://example.test/' });
    assert.equal(again.tabId, original.tabId); assert.equal(restarted.store.current.pages.length, 1);
    assert.equal(restarted.store.current.states[0][1].revision, revision);
  } finally { restarted.close(); await restarted.persistence; }
});

test('creation published before a reported storage error remains discoverable and immediately closeable', async t => {
  const f = await fixture(t), commit = f.service.commit.bind(f.service), binding = grant('published-create');
  let failed = false, notifications = 0;
  f.service.metadataChanged = () => { notifications++; };
  f.service.commit = (reduce: any, selection: any) => commit(reduce, selection).then((result: any) => {
    if (!failed) { failed = true; throw Object.assign(Error('directory sync failed after publish'), { code: 'EIO' }); } return result;
  });
  let tabId: string | undefined;
  await assert.rejects(f.service.createTab(binding, { url: 'https://example.test/' }), (error: any) => {
    assert.equal(error.code, 'EIO'); assert.equal(error.outcome, 'unknown'); assert.equal(error.retryable, false);
    assert.equal(typeof error.tabId, 'string'); tabId = error.tabId; return true;
  });
  assert.equal(notifications, 1); assert.equal(f.service.pages.size, 1); assert.equal(f.service.commands.length, 0);
  const listed = await f.service.conversationTabs('owner', 'host', 'thread', () => {}); assert.equal(listed[0].tabId, tabId);
  assert.deepEqual([...f.service.states], f.service.store.current.states);
  assert.deepEqual(await f.service.closeTab(binding, { tabId }), { tabId, closed: true });
  assert.equal(f.service.pages.size, 0); assert.equal(f.service.store.current.pages.length, 0);
  assert.equal(f.service.commands.some(command => command.method === 'create'), false);
});

test('a published creation recovers the same identity after storage error without duplicate metadata', async t => {
  const f = await fixture(t), commit = f.service.commit.bind(f.service), binding = grant('published-recover'); let failed = false;
  f.service.commit = (reduce: any, selection: any) => commit(reduce, selection).then((result: any) => {
    if (!failed) { failed = true; throw Object.assign(Error('directory sync failed after publish'), { code: 'EIO' }); } return result;
  });
  await assert.rejects(f.service.createTab(binding, { url: 'https://example.test/' }), { outcome: 'unknown' });
  const original = (await f.service.conversationTabs('owner', 'host', 'thread', () => {}))[0];
  const recovered = await f.service.createTab(binding, { url: 'https://example.test/' });
  assert.equal(recovered.tabId, original.tabId); assert.equal(f.service.store.current.pages.length, 1);
  assert.equal(f.service.commands.filter(command => command.method === 'create').length, 1);
});

test('permanent retirement facts survive receipt compaction, stale edits and restart', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  const first = await f.service.createTab(grant('compacted-first'), { url: 'https://example.test/first' });
  const stale = await f.service.metadata('owner', undefined, () => {});
  await f.service.closeTab(grant('compacted-first'), { tabId: first.tabId });
  for (let i = 0; i < 256; i++) {
    const binding = grant('compact-' + i), tab = await f.service.createTab(binding, { url: 'https://example.test/' + i });
    await f.service.closeTab(binding, { tabId: tab.tabId });
  }
  assert.equal(f.service.store.current.closedTabs.length, 256);
  assert.equal(f.service.store.current.closedTabs.some(receipt => receipt.tabId === first.tabId), false);
  await assert.rejects(f.service.closeTab(grant('old-receipt'), { tabId: first.tabId }), { code: 'TAB_ACCESS_DENIED' });
  const survivor = await f.service.createTab(grant('survivor'), { url: 'https://example.test/survivor' });
  let current = await f.service.metadata('owner', undefined, () => {});
  assert(current.retiredTabs.some(fact => fact.pageIds.includes(first.pageId)));
  for (const key of ['pages', 'tabs', 'storage']) {
    await f.service.metadata('owner', { scope: current.scope, key, value: stale.values[key], baseValue: null,
      expectedKeyRevision: 0, mutationId: randomUUID() }, () => {});
  }
  current = await f.service.metadata('owner', undefined, () => {});
  assert.deepEqual(JSON.parse(current.values.pages).map((page: any) => page.id), [survivor.pageId]);
  assert.deepEqual(JSON.parse(current.values.tabs).map((tab: any) => tab.id), [survivor.tabId]);
  assert.equal(JSON.parse(current.values.storage)[first.pageId], undefined);
  const storage = await f.client(), pageKey = 'opencraft.browser-pages.v1';
  const local = JSON.parse(storage.getItem(pageKey)!); local.push(JSON.parse(stale.values.pages)[0]); storage.setItem(pageKey, JSON.stringify(local));
  assert.deepEqual(JSON.parse(storage.getItem(pageKey)!).map((page: any) => page.id), [survivor.pageId], 'closed identities disappear without changing surviving rows');
  await storage.flush(); storage.dispose();
  f.service.close(); await f.service.persistence;
  const restarted = new Native({ root: f.directory, dataDirectory: f.directory, ownerConnector: null });
  try {
    const restored = await restarted.metadata('owner', undefined, () => {});
    assert(restored.retiredTabs.some(fact => fact.pageIds.includes(first.pageId)));
    assert.equal((await readBrowserState(f.directory)).retiredResources.length, 257);
    assert.equal((await restarted.conversationTabs('owner', 'host', 'thread', () => {})).length, 1);
  } finally { restarted.close(); await restarted.persistence; }
});

test('old compacted service leases restore retirement facts and metadata reads stay pure', async t => {
  const f = await fixture(t), binding = grant('old-compacted');
  const tab = await f.service.createTab(binding, { url: 'https://example.test/' });
  const stale = await f.service.metadata('owner', undefined, () => {});
  await f.service.closeTab(binding, { tabId: tab.tabId });
  f.service.close(); await f.service.persistence;
  await makeLegacyBrowserState(f.directory, (draft: any) => {
    delete draft.retiredResources; draft.closedTabs = [];
    const state = draft.states.find(([owner]: any) => owner === 'owner')[1];
    state.values = structuredClone(stale.values);
  });
  const restarted = new Native({ root: f.directory, dataDirectory: f.directory, ownerConnector: null });
  try {
    await restarted.load(); const before = JSON.stringify(restarted.store.current);
    const state = await restarted.metadata('owner', undefined, () => {});
    assert.equal(state.values.pages, '[]'); assert.equal(state.values.tabs, '[]'); assert.equal(state.values.storage, '{}');
    assert(state.retiredTabs.some(fact => fact.pageIds.includes(tab.pageId) && fact.tabIds.includes(tab.tabId)));
    assert.equal(JSON.stringify(restarted.store.current), before, 'projection reads must not mutate durable state');
    assert.equal(restarted.commands.length, 0);
  } finally { restarted.close(); await restarted.persistence; }
});

test('concurrent creation reserves native capacity in the same transaction as metadata', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled(Array.from({ length: 17 }, (_, index) => f.service.createTab(grant(String(index)), { url: 'https://example.test/' })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 16);
  assert.equal((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code, 'ACCOUNT_CAPACITY');
  const state = await f.service.metadata('owner', undefined, () => {});
  assert.equal(JSON.parse(state.values.pages).length, 16); assert.equal(JSON.parse(state.values.tabs).length, 16);
  assert.equal(Object.keys(JSON.parse(state.values.storage)).length, 16); assert.equal(f.service.native.size, 16);
});

test('snapshot on reconnect discovers missed creation and disposal removes metadata subscriptions', async t => {
  const f = await fixture(t); await f.service.createTab(grant('first'), { url: 'https://example.test/' });
  const storage = await f.client(), socket = (storage as any).socket;
  socket.close(); await once(socket, 'close');
  const created = await f.service.createTab(grant('missed'), { url: 'https://example.test/missed' });
  assert.equal(storage.isReady, false);
  await eventually(() => storage.isReady && JSON.parse(storage.getItem('opencraft.browser-tabs.v1')!).some((tab: any) => tab.id === created.tabId));
  await storage.flush();
  const live = (storage as any).socket; storage.dispose(); await once(live, 'close');
  await eventually(() => f.service.metadataPeers.size === 0);
});

test('an invalidation arriving during a read schedules a newer snapshot', async t => {
  const f = await fixture(t); await f.service.createTab(grant('first'), { url: 'https://example.test/' });
  const storage = await f.client(); await storage.flush();
  const metadata = f.service.metadataDigest.bind(f.service); let admitted!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { admitted = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release?.()); let hold = true;
  f.service.metadataDigest = async (...args: any[]) => {
    const value = await (metadata as any)(...args);
    if (hold) { hold = false; admitted(); await gate; }
    return value;
  };
  await f.service.createTab(grant('second'), { url: 'https://example.test/second' }); await started;
  const third = await f.service.createTab(grant('third'), { url: 'https://example.test/third' }); release();
  await eventually(() => JSON.parse(storage.getItem('opencraft.browser-tabs.v1')!).some((tab: any) => tab.id === third.tabId));
  assert.equal(storage.isReady, true);
});

test('creation notifications do not cross account ownership', async t => {
  const f = await fixture(t); await f.service.createTab(grant('first'), { url: 'https://example.test/' });
  const storage = await f.client(); await storage.flush(); const before = storage.getItem('opencraft.browser-tabs.v1');
  let changed = 0; const unsubscribe = storage.subscribe(() => changed++); t.after(unsubscribe);
  await f.service.createTab({ ...grant('foreign'), ownerId: 'another-owner' }, { url: 'https://foreign.test/' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(storage.getItem('opencraft.browser-tabs.v1'), before); assert.equal(changed, 0);
});

test('service close atomically retires metadata, acknowledges native destruction and reuses its durable receipt', async t => {
  const f = await fixture(t), binding = grant('once'), tab = await f.service.createTab(binding, { url: 'https://example.test/' });
  const before = await f.service.metadata('owner', undefined, () => {});
  assert.deepEqual(await f.service.closeTab(binding, { tabId: tab.tabId }), { tabId: tab.tabId, closed: true });
  const state = await f.service.metadata('owner', undefined, () => {});
  assert.equal(state.revision, before.revision + 1); assert.equal(state.keyRevisions.bindings, before.keyRevisions.bindings);
  for (const key of ['pages', 'tabs', 'storage']) assert.equal(state.keyRevisions[key], before.keyRevisions[key] + 1);
  assert.equal(JSON.parse(state.values.pages).length, 0); assert.equal(JSON.parse(state.values.tabs).length, 0); assert.deepEqual(JSON.parse(state.values.storage), {});
  assert.equal(f.service.native.size, 0); assert.equal(f.service.store.current.pages.length, 0); assert.equal(f.service.store.current.closedTabs[0].status, 'closed');
  const calls = f.service.commands.length;
  assert.equal((await f.service.closeTab(binding, { tabId: tab.tabId })).closed, true); assert.equal(f.service.commands.length, calls);
  for (const change of [{ ownerId: 'foreign' }, { hostId: 'foreign' }, { threadId: 'foreign' }])
    await assert.rejects(f.service.closeTab({ ...binding, ...change }, { tabId: tab.tabId }), { code: 'TAB_ACCESS_DENIED' });
  f.service.close(); await f.service.persistence;
  const restarted = new Native({ root: f.directory, dataDirectory: f.directory, ownerConnector: null });
  try { assert.equal((await restarted.closeTab(binding, { tabId: tab.tabId })).closed, true); assert.equal(restarted.commands.length, 0); }
  finally { restarted.close(); await restarted.persistence; }
});

test('cancelled close keeps its accepted intent and capacity until the native acknowledgement', async t => {
  const f = await fixture(t), binding = grant('cancelled-close'), tab = await f.service.createTab(binding, { url: 'https://example.test/' });
  const request = f.service.request.bind(f.service); let started!: () => void, release!: () => void;
  const admitted = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release?.());
  f.service.request = async (...args: any[]) => { if (args[1] === 'close') { started(); await gate; } return (request as any)(...args); };
  const controller = new AbortController();
  const closing = f.service.closeTab(binding, { tabId: tab.tabId }, { signal: controller.signal });
  const rejected = assert.rejects(closing, { code: 'BROWSER_ABORTED', outcome: 'unknown' }); await admitted; controller.abort(); await rejected;
  assert.equal((await f.service.catalog('owner', () => {})).capacity.accountUsed, 1);
  assert.equal(f.service.store.current.closedTabs[0].status, 'closing'); assert.equal(f.service.native.size, 1);
  assert.deepEqual(await f.service.conversationTabs('owner', 'host', 'thread', () => {}), []);
  binding.authorize = () => { throw new Error('revoked'); };
  await assert.rejects(f.service.closeTab(binding, { tabId: tab.tabId }), /revoked/);
  const duplicate = f.service.closeTab(grant('fresh-close'), { tabId: tab.tabId }); release(); await duplicate;
  assert.equal((await f.service.catalog('owner', () => {})).capacity.accountUsed, 0);
  assert.equal(f.service.commands.filter(call => call.method === 'close').length, 1);
});

test('a rejected close draft neither retires the page nor schedules unauthorized cleanup', async t => {
  const f = await fixture(t), binding = grant('rejected-close'), tab = await f.service.createTab(binding, { url: 'https://example.test/' });
  const state = await f.service.metadata('owner', undefined, () => {}), commit = f.service.commit.bind(f.service);
  f.service.commit = (reduce: any, selection: any) => commit((draft: any) => { reduce(draft); throw Error('close commit failed'); }, selection);
  await assert.rejects(f.service.closeTab(binding, { tabId: tab.tabId }), /close commit failed/); f.service.commit = commit;
  assert.deepEqual(await f.service.metadata('owner', undefined, () => {}), state);
  const page = [...f.service.pages.values()][0]; assert.equal(page.closing, undefined); assert.equal(page.controller, null); assert.equal(page.retirementTimer, undefined);
  assert.equal(f.service.commands.some(call => call.method === 'close'), false); assert.equal(await f.service.store.hasRetirement(page.key), false);
});

test('revocation while the intent waits for the writer cannot authorize a later close', async t => {
  const f = await fixture(t), binding = grant('revoked-close'), tab = await f.service.createTab(binding, { url: 'https://example.test/' });
  const commit = f.service.commit.bind(f.service); let admitted!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { admitted = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release?.());
  let held = false;
  f.service.commit = (reduce: any, selection: any) => {
    if (!held) { held = true; f.service.store.tail = gate; admitted(); }
    return commit(reduce, selection);
  };
  const closing = f.service.closeTab(binding, { tabId: tab.tabId }), denied = assert.rejects(closing, { message: 'revoked before commit', outcome: 'not-dispatched' });
  await started; binding.authorize = () => { throw Error('revoked before commit'); }; release(); await denied;
  const page = [...f.service.pages.values()][0];
  assert.equal(page.closing, undefined); assert.equal(page.retirementTimer, undefined); assert.equal(page.controller, null);
  assert.equal(await f.service.store.hasRetirement(page.key), false); assert.equal(f.service.commands.some(call => call.method === 'close'), false);
});

test('a close intent published before a reported storage error still owns cleanup', async t => {
  const f = await fixture(t), binding = grant('published-close'), tab = await f.service.createTab(binding, { url: 'https://example.test/' });
  const commit = f.service.commit.bind(f.service); let failed = false;
  f.service.commit = (reduce: any, selection: any) => commit(reduce, selection).then((result: any) => {
    if (!failed && f.service.store.current.pages.some(page => page.lifecycle === 'closing')) {
      failed = true; throw Object.assign(Error('directory sync failed after publish'), { code: 'EIO' });
    }
    return result;
  });
  await assert.rejects(f.service.closeTab(binding, { tabId: tab.tabId }), { code: 'EIO', outcome: 'unknown' });
  assert.equal([...f.service.pages.values()][0].closing, true);
  await eventually(() => f.service.pages.size === 0);
  assert.equal(f.service.native.size, 0); assert.equal(f.service.store.current.closedTabs[0].status, 'closed');
});

test('unknown native close keeps its reservation and restart finishes the same resource without creation', async t => {
  const f = await fixture(t), binding = grant('unknown-close'), tab = await f.service.createTab(binding, { url: 'https://example.test/' });
  const request = f.service.request.bind(f.service);
  f.service.request = async (...args: any[]) => {
    const result = await (request as any)(...args);
    if (args[1] === 'close') throw Object.assign(new Error('lost close ACK'), { code: 'BROWSER_UNAVAILABLE', outcome: 'unknown' }); return result;
  };
  await assert.rejects(f.service.closeTab(binding, { tabId: tab.tabId }), { outcome: 'unknown' });
  assert.equal((await f.service.catalog('owner', () => {})).capacity.accountUsed, 1);
  f.service.close(); await f.service.persistence;
  const restarted = new Native({ root: f.directory, dataDirectory: f.directory, ownerConnector: null });
  try {
    assert.equal((await restarted.closeTab(binding, { tabId: tab.tabId })).closed, true);
    assert.equal(restarted.commands.some(call => call.method === 'create'), false);
    assert.equal((await restarted.catalog('owner', () => {})).capacity.accountUsed, 0);
  } finally { restarted.close(); await restarted.persistence; }
});

test('retirement defeats pending edits to its rows and preserves unrelated drafts and page objects', async t => {
  const f = await fixture(t), closed = await f.service.createTab(grant('close'), { url: 'https://example.test/closed' });
  const kept = await f.service.createTab(grant('keep'), { url: 'https://example.test/kept' }), storage = await f.client();
  const bindings = createConversationBindingStore({ persistence: { load: () => JSON.parse(storage.getItem('opencraft.conversation-bindings.v1') ?? '[]') } });
  const retired: string[] = [], panelsClosed: string[] = [];
  const surfaces: any = { restoreStorage() {}, retire(id: string) { retired.push(id); }, close() { assert.fail('retirement replayed a remote close'); }, navigate() { assert.fail('retirement created a surface'); } };
  const pages = new WebBrowserPageRuntime(surfaces, null, () => null, storage);
  const panels: any = { open() { return { id: 'panel' }; }, close(_owner: string, _region: string, id: string) { panelsClosed.push(id); }, dispatch() {}, ensureOwner() {} };
  const workbench = new BrowserWorkbenchCoordinator(pages, panels, bindings, storage), unsubscribe = subscribeBrowserMetadata(storage, bindings, surfaces, pages, workbench);
  t.after(() => { unsubscribe(); workbench.dispose(); pages.dispose(); bindings.dispose(); });
  workbench.open('conversation:' + JSON.stringify(['host', 'thread']), { tabId: closed.tabId });
  const survivor = pages.getSnapshot(kept.pageId), metadata = f.service.metadata.bind(f.service);
  let started!: () => void, release!: () => void, held = false;
  const admitted = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release?.());
  f.service.metadata = async (...args: any[]) => { if (args[1]?.key === 'tabs' && !held) { held = true; started(); await gate; } return (metadata as any)(...args); };
  workbench.setViewportMode(closed.tabId, { type: 'fit', width: 600, height: 400 }); await admitted;
  workbench.setViewportMode(kept.tabId, { type: 'fit', width: 800, height: 600 });
  await f.service.closeTab(grant('close'), { tabId: closed.tabId }); release(); await storage.flush();
  await eventually(() => workbench.getTabSnapshot(closed.tabId) === null);
  assert.equal(pages.getSnapshot(closed.pageId), null); assert.equal(pages.getSnapshot(kept.pageId), survivor);
  assert.deepEqual(retired, [closed.pageId]); assert(panelsClosed.includes('browser:' + closed.tabId)); assert.equal(storage.isReady, true);
  const rows = JSON.parse((await metadata('owner', undefined, () => {})).values.tabs);
  assert.equal(rows.length, 1); assert.equal(rows[0].id, kept.tabId); assert.equal(rows[0].viewportMode.width, 800);
});

test('close racing native bootstrap retires a late create and leaves no orphan', async t => {
  const f = await fixture(t), binding = grant('late-create'), request = f.service.request.bind(f.service);
  let started!: () => void, release!: () => void;
  const admitted = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release?.());
  f.service.request = async (...args: any[]) => { if (args[1] === 'create') { started(); await gate; } return (request as any)(...args); };
  const creating = f.service.createTab(binding, { url: 'https://example.test/' }), rejected = assert.rejects(creating, { outcome: 'unknown' }); await admitted;
  const tab = (await f.service.conversationTabs('owner', 'host', 'thread', () => {}))[0];
  const closing = f.service.closeTab(binding, { tabId: tab.tabId });
  await eventually(() => f.service.pages.get(JSON.stringify(['owner', tab.lease]))?.closing === true); release(); await closing; await rejected;
  assert.equal(f.service.native.size, 0); assert.equal(f.service.pages.size, 0); assert.equal(f.service.commands.filter(call => call.method === 'create').length, 1);
});

test('lost metadata ACK reconnects with the original mutation and commits once', async t => {
  const f = await fixture(t);
  await f.service.createTab(grant('original'), { url: 'https://example.test/' });
  const storage = await f.client(); await storage.flush();
  const metadata = f.service.metadata.bind(f.service), inputs: any[] = [];
  let committedRevision = 0, dropped = false;
  f.service.metadata = async (owner: string, input: any, authorize: () => void) => {
    const result = await metadata(owner, input, authorize);
    if (input) {
      inputs.push(input);
      if (!dropped) {
        dropped = true; committedRevision = result.revision;
        for (const ws of f.service.metadataPeers.keys()) ws.terminate();
      }
    }
    return result;
  };
  const tabs = JSON.parse(storage.getItem('opencraft.browser-tabs.v1')!);
  tabs[0].viewportMode = { type: 'fit', width: 640, height: 480 };
  storage.setItem('opencraft.browser-tabs.v1', JSON.stringify(tabs));
  await storage.flush();
  assert.equal(storage.isReady, true); assert.equal(inputs.length, 2);
  assert.deepEqual(inputs[0], inputs[1]);
  const state = await metadata('owner', undefined, () => {});
  assert.equal(state.revision, committedRevision);
  assert.deepEqual(JSON.parse(state.values.tabs)[0].viewportMode, tabs[0].viewportMode);
});

test('compacted merge receipt cannot resurrect a deleted binding after restart', async t => {
  const f = await fixture(t);
  let state = await f.service.metadata('owner', undefined, () => {});
  const original = { scope: state.scope, key: 'bindings', baseValue: null,
    value: JSON.stringify([{ scopeId: 'deleted', hostId: 'host', threadId: 'thread' }]),
    mutationId: randomUUID(), expectedRevision: state.revision, expectedKeyRevision: 0 };
  await f.service.metadata('owner', original, () => {});
  for (let index = 0; index < 256; index++) {
    state = await f.service.metadata('owner', undefined, () => {});
    await f.service.metadata('owner', { scope: state.scope, key: 'bindings',
      baseValue: state.values.bindings, value: JSON.stringify([{ scopeId: 'survivor', hostId: 'host', threadId: String(index) }]),
      mutationId: randomUUID(), expectedRevision: state.revision, expectedKeyRevision: state.keyRevisions.bindings }, () => {});
  }
  const before = await f.service.metadata('owner', undefined, () => {});
  assert(!before.receipts.some((receipt: any) => receipt.id === original.mutationId));
  await assert.rejects(f.service.metadata('owner', original, () => {}), { code: 'STATE_CONFLICT' });
  f.service.close(); await f.service.persistence;
  const restarted = new Native({ root: f.directory, dataDirectory: f.directory, ownerConnector: null });
  t.after(async () => { restarted.close(); await restarted.persistence; });
  await assert.rejects(restarted.metadata('owner', original, () => {}), { code: 'STATE_CONFLICT' });
  const after = await restarted.metadata('owner', undefined, () => {});
  assert.equal(after.revision, before.revision); assert.equal(after.values.bindings, before.values.bindings);
  // Fresh clients can still merge at the retained history boundary.
  await restarted.metadata('owner', { ...original, mutationId: randomUUID(), baseValue: after.values.bindings,
    expectedRevision: after.revision, expectedKeyRevision: after.keyRevisions.bindings,
    value: JSON.stringify([{ scopeId: 'fresh', hostId: 'host', threadId: 'fresh' }]) }, () => {});
});

test('application storage shutdown saves an accepted edit and closes its real subscription', async t => {
  const f = await fixture(t);
  await f.service.createTab(grant('shutdown'), { url: 'https://example.test/' });
  const storage = await f.client(); await storage.flush();
  const tabs = JSON.parse(storage.getItem('opencraft.browser-tabs.v1')!);
  tabs[0].viewportMode = { type: 'fit', width: 700, height: 500 };
  storage.setItem('opencraft.browser-tabs.v1', JSON.stringify(tabs));
  await storage.flushAndDispose();
  await eventually(() => f.service.metadataPeers.size === 0);
  const state = await f.service.metadata('owner', undefined, () => {});
  assert.deepEqual(JSON.parse(state.values.tabs)[0].viewportMode, tabs[0].viewportMode);
  assert.equal(storage.isReady, false);
});

test('ordinary metadata commits invalidate other clients once and receipt replays stay quiet', async t => {
  const f = await fixture(t);
  const writer = await f.client(), reader = await f.client();
  await writer.flush(); await reader.flush();
  const key = 'opencraft.conversation-bindings.v1';
  const value = JSON.stringify([{ scopeId: 'shared', hostId: 'host', threadId: 'thread' }]);
  const peer = [...f.service.metadataPeers.keys()][1], messages: any[] = [];
  const send = peer.send.bind(peer);
  peer.send = ((bytes: any, ...args: any[]) => { messages.push(JSON.parse(String(bytes))); return send(bytes, ...args); }) as any;
  const metadata = f.service.metadata.bind(f.service); let written: any;
  f.service.metadata = async (owner: string, input: any, authorize: () => void) => {
    if (input) written = structuredClone(input);
    return metadata(owner, input, authorize);
  };
  writer.setItem(key, value); await writer.flush();
  await eventually(() => reader.getItem(key) === value); await reader.flush();
  assert.equal(reader.isReady, true);
  const invalidations = () => messages.filter(message => message.type === 'metadata-changed').length;
  assert.equal(invalidations(), 1);
  const before = await metadata('owner', undefined, () => {});
  await metadata('owner', written, () => {});
  await metadata('owner', undefined, () => {});
  await assert.rejects(metadata('owner', { ...written, value: '[]' }, () => {}), { code: 'OPERATION_CONFLICT' });
  assert.equal(invalidations(), 1);
  const after = await metadata('owner', undefined, () => {});
  assert.equal(after.revision, before.revision); assert.equal(after.values.bindings, value);
  await metadata('other-owner', { scope: (await metadata('other-owner', undefined, () => {})).scope,
    key: 'bindings', value: '[]', mutationId: randomUUID(), expectedRevision: 0 }, () => {});
  assert.equal(invalidations(), 1);
});

test('metadata published before a storage error invalidates peers while rejected drafts stay quiet', async t => {
  const f = await fixture(t), reader = await f.client(); await reader.flush();
  const commit = f.service.commit.bind(f.service), notify = f.service.metadataChanged.bind(f.service);
  let notifications = 0; f.service.metadataChanged = (owner: string) => { notifications++; notify(owner); };
  const before = await f.service.metadata('owner', undefined, () => {});
  const input = { scope: before.scope, key: 'bindings', value: JSON.stringify([{ scopeId: 'published', hostId: 'host', threadId: 'thread' }]),
    baseValue: null, expectedRevision: 0, expectedKeyRevision: 0, mutationId: randomUUID() };
  f.service.commit = (reduce: any, selection: any) => commit(reduce, selection).then(() => { throw Object.assign(Error('directory sync failed after publish'), { code: 'EIO' }); });
  await assert.rejects(f.service.metadata('owner', input, () => {}), { code: 'EIO', outcome: 'unknown', retryable: false });
  await eventually(() => reader.getItem('opencraft.conversation-bindings.v1') === input.value);
  assert.equal(notifications, 1); assert.deepEqual([...f.service.states], f.service.store.current.states);
  f.service.commit = commit;
  const replay = await f.service.metadata('owner', input, () => {});
  assert.equal(replay.revision, 1); assert.equal(notifications, 1);
  f.service.commit = (reduce: any) => commit((draft: any) => { reduce(draft); throw Error('rejected before publish'); });
  await assert.rejects(f.service.metadata('owner', { ...input, value: '[]', baseValue: input.value,
    expectedRevision: 1, expectedKeyRevision: 1, mutationId: randomUUID() }, () => {}), /rejected before publish/);
  assert.equal(notifications, 1);
  assert.equal((await f.service.metadata('owner', undefined, () => {})).values.bindings, input.value);
});

test('published legacy metadata removal still schedules native retirement after storage error', async t => {
  const f = await fixture(t), created = await f.service.createTab(grant('metadata-retire-error'), { url: 'https://example.test/' });
  const reader = await f.client(); await reader.flush();
  const before = await f.service.metadata('owner', undefined, () => {}), commit = f.service.commit.bind(f.service);
  let fail = true;
  f.service.commit = (reduce: any, selection: any) => commit(reduce, selection).then((result: any) => {
    if (fail) { fail = false; throw Object.assign(Error('metadata published before error'), { code: 'EIO' }); }
    return result;
  });
  await assert.rejects(f.service.metadata('owner', { scope: before.scope, key: 'storage', value: '{}',
    baseValue: before.values.storage, expectedRevision: before.revision, expectedKeyRevision: before.keyRevisions.storage,
    mutationId: randomUUID() }, () => {}), { code: 'EIO', outcome: 'unknown' });
  await eventually(() => f.service.native.size === 0 && f.service.pages.size === 0
    && !JSON.parse(reader.getItem('opencraft.browser-tabs.v1')!).some((tab: any) => tab.id === created.tabId));
  assert(f.service.commands.some(command => command.method === 'close'));
});

test('a retryable writer-handover error does not permanently disable a connected metadata writer', async t => {
  const f = await fixture(t), writer = await f.client(), reader = await f.client();
  await writer.flush(); await reader.flush();
  const metadata = f.service.metadata.bind(f.service); let busy = true;
  const inputs: any[] = [];
  f.service.metadata = async (owner: string, input: any, authorize: () => void) => {
    if (input) {
      inputs.push(input);
      if (busy) { busy = false; throw Object.assign(Error('previous writer is releasing'), { code: 'BROWSER_UNAVAILABLE', retryable: true }); }
    }
    return metadata(owner, input, authorize);
  };
  const value = JSON.stringify([{ scopeId: 'recovered', hostId: 'host', threadId: 'thread' }]);
  writer.setItem('opencraft.conversation-bindings.v1', value); await writer.flush();
  await eventually(() => reader.getItem('opencraft.conversation-bindings.v1') === value);
  assert.equal(writer.isReady, true); assert.equal(inputs.length, 2); assert.deepEqual(inputs[0], inputs[1]);
  assert.equal((await metadata('owner', undefined, () => {})).revision, 1);
});

test('retirement cursors send only additions and recover from changed prefixes or other scopes', async () => {
  const { initializeRetirementFacts, retirementSnapshot } = await import('../../apps/headless-server/src/remote-browser/retirement-facts.mjs');
  const state: any = { retired: Array.from({ length: 10000 }, (_, index) => JSON.stringify(['owner', `browser-${index.toString(16).padStart(64, '0')}`])) };
  initializeRetirementFacts(state);
  assert.equal(state.retiredResources.length, 10000);
  const initial = retirementSnapshot(state, 'owner', 'scope');
  assert.equal(initial.retiredTabsMode, 'replace'); assert.equal(initial.retiredTabs.length, 10000);
  const repeated = retirementSnapshot(state, 'owner', 'scope', initial.retirementCursor);
  assert.equal(repeated.retiredTabsMode, 'append'); assert.deepEqual(repeated.retiredTabs, []);
  assert(JSON.stringify({ ...repeated, facts: undefined }).length < 300);
  const next = structuredClone(state);
  next.retired.push(JSON.stringify(['owner', 'browser-' + 'f'.repeat(64)])); initializeRetirementFacts(next);
  const update = retirementSnapshot(next, 'owner', 'scope', initial.retirementCursor);
  assert.equal(update.retiredTabsMode, 'append'); assert.equal(update.retiredTabs.length, 1);
  const amended = structuredClone(next); amended.retiredResources[0].pageIds.push('legacy-page');
  assert.equal(retirementSnapshot(amended, 'owner', 'scope', update.retirementCursor).retiredTabsMode, 'replace');
  assert.equal(retirementSnapshot(next, 'owner', 'other-scope', update.retirementCursor).retiredTabsMode, 'replace');
  assert.equal(retirementSnapshot(next, 'owner', 'scope', { ...update.retirementCursor, count: -1 }).retiredTabsMode, 'replace');
});

test('incremental retirement synchronization preserves earlier fences across successive closes', async t => {
  const f = await fixture(t);
  const first = await f.service.createTab(grant('delta-first'), { url: 'https://example.test/first' });
  const storage = await f.client();
  await f.service.closeTab(grant('delta-close-first'), { tabId: first.tabId });
  await eventually(() => storage.retiredResources().some(fact => fact.tabIds.includes(first.tabId)));
  const second = await f.service.createTab(grant('delta-second'), { url: 'https://example.test/second' });
  await f.service.closeTab(grant('delta-close-second'), { tabId: second.tabId });
  await eventually(() => storage.retiredResources().some(fact => fact.tabIds.includes(second.tabId)));
  const stale = JSON.parse(storage.getItem('opencraft.browser-pages.v1') ?? '[]'); stale.push({ id: first.pageId });
  storage.setItem('opencraft.browser-pages.v1', JSON.stringify(stale));
  assert.equal(JSON.parse(storage.getItem('opencraft.browser-pages.v1')!).some((row: any) => row.id === first.pageId), false);
  assert(storage.retiredResources().some(fact => fact.tabIds.includes(second.tabId)));
});

test('cold clients receive referenced retirement facts and hold unknown offline rows until server admission', async t => {
  const f = await fixture(t);
  const first = await f.service.createTab(grant('reference-old'), { url: 'https://example.test/' });
  await f.service.closeTab(grant('reference-close'), { tabId: first.tabId });
  const client = await f.client();
  assert.equal(client.retiredResources().length, 0, 'fresh client must not download unrelated closed resources');
  const key = 'opencraft.browser-pages.v1';
  client.setItem(key, JSON.stringify([{ id: first.pageId, ownerId: 'stale', entries: [], index: 0 }]));
  assert.equal(client.getItem(key), '[]', 'unknown old identities cannot become visible optimistically');
  await client.flush(); assert.equal(client.getItem(key), '[]');
  const fresh = { id: 'new-local-page', ownerId: 'local', entries: [], index: 0 };
  client.setItem(key, JSON.stringify([fresh])); assert.equal(client.getItem(key), '[]');
  await client.flush(); assert.equal(JSON.parse(client.getItem(key)!)[0].id, fresh.id, 'new IDs become visible after authoritative admission');
});


test('a cold client with twenty thousand retired resources imports only relevant legacy drafts', async t => {
  const f = await fixture(t), directory = join(f.directory, 'remote-browser'); await mkdir(directory, { recursive: true });
  const identity = (index: number) => index.toString(16).padStart(64, '0');
  await writeFile(join(directory, 'tabs.json'), JSON.stringify({ schemaVersion: 1, pages: [], states: [],
    retired: Array.from({ length: 20000 }, (_, index) => JSON.stringify(['owner', 'browser-' + identity(index)])) }));
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem(key: string) { return key === 'opencraft.browser-pages.v1' ? JSON.stringify([{ id: 'page-' + identity(1), ownerId: 'offline', entries: [], index: 0 }]) : null; },
  } });
  const responses: any[] = [], metadata = f.service.metadata.bind(f.service);
  f.service.metadata = async (...args: any[]) => { const result = await metadata(...args); if (args[1] === undefined) responses.push(result); return result; };
  const client = await f.client(); await client.flush();
  assert.equal(client.getItem('opencraft.browser-pages.v1'), '[]');
  assert(responses.some(result => result.retiredTabs.some((fact: any) => fact.pageIds.includes('page-' + identity(1)))));
  assert(responses.every(result => JSON.stringify(result).length < 2000));
  assert.equal(f.service.store.current.retiredResources.length, 0, 'historical facts are not retained as a main-thread archive');
  assert.equal((await readBrowserState(f.directory)).retiredResources.length, 20000);
});

for (const reportedFailure of [false, true]) test(`another account replacing retirement selection cannot break accepted close${reportedFailure ? ' error recovery' : ''}`, async t => {
  const f = await fixture(t), binding = grant('selection-race-' + reportedFailure);
  const tab = await f.service.createTab(binding, { url: 'https://example.test/close-race' });
  const commit = f.service.commit.bind(f.service); let replaced = false;
  f.service.commit = async (reduce: any, selection: any) => {
    const result = await commit(reduce, selection);
    if (!replaced && f.service.store.account('owner').pages.some(page => page.lifecycle === 'closing')) {
      replaced = true;
      await f.service.store.transact(() => {}, { ownerId: 'unrelated-account' });
      if (reportedFailure) throw Object.assign(Error('intent published before selection changed'), { code: 'EIO' });
    }
    return result;
  };
  const closing = f.service.closeTab(binding, { tabId: tab.tabId });
  if (reportedFailure) await assert.rejects(closing, { code: 'EIO', outcome: 'unknown' });
  else assert.equal((await closing).closed, true);
  await eventually(() => f.service.pages.size === 0);
  assert.equal(replaced, true);
  assert.equal(f.service.native.size, 0);
  assert.equal(f.service.store.account('owner').closedTabs[0].status, 'closed');
  assert.equal(f.service.commands.filter(call => call.method === 'close').length, 1);
});

test('creation failure recovery queries committed retirement after concurrent close and foreign selection', async t => {
  const f = await fixture(t), commit = f.service.commit.bind(f.service); let interrupted = false, key: string;
  f.service.commit = async (reduce: any, selection: any) => {
    const result = await commit(reduce, selection);
    const record = f.service.store.account('owner').pages.find(page => page.creationUrl === 'https://example.test/create-race');
    if (!interrupted && record) {
      interrupted = true; key = record.key;
      const page = { ...structuredClone(record), controller: null, live: false };
      f.service.pages.set(key, page);
      await f.service.retire(page);
      await f.service.store.transact(() => {}, { ownerId: 'unrelated-account' });
      throw Object.assign(Error('creation published then closed'), { code: 'EIO' });
    }
    return result;
  };
  await assert.rejects(f.service.createTab(grant('closed-before-create-return'), { url: 'https://example.test/create-race' }),
    (error: any) => error.code === 'EIO' && error.outcome === 'unknown' && typeof error.tabId === 'string');
  assert.equal(await f.service.store.hasRetirement(key!), true);
  assert.equal(f.service.pages.size, 0);
  assert.equal(f.service.store.account('owner').pages.length, 0);
  assert.equal(f.service.commands.some(call => call.method === 'create'), false, 'failure recovery cannot replay native creation');
});


test('fingerprint reads return all divergent fields and their versions from one snapshot', async t => {
  const f = await fixture(t), initial = await f.service.metadata('owner', undefined, () => {});
  const versions = { ...initial.keyRevisions };
  for (const [key, value] of [['bindings', '[]'], ['pages', '[]']]) {
    const current = await f.service.metadata('owner', undefined, () => {});
    await f.service.metadata('owner', { scope: current.scope, key, value, expectedKeyRevision: current.keyRevisions?.[key] ?? 0, mutationId: randomUUID() }, () => {});
  }
  const reply = await f.service.metadataDigest('owner', { root: initial.root, versions }, () => {}, { pages: [], tabs: [], leases: [] });
  assert.deepEqual(reply.values, { pages: '[]', bindings: '[]' });
  assert.equal(reply.leaves.bindings.keyRevision, 1); assert.equal(reply.leaves.pages.keyRevision, 1);
  const equal = await f.service.metadataDigest('owner', { root: reply.root, versions: Object.fromEntries(Object.entries(reply.leaves).map(([key, leaf]: [string, any]) => [key, leaf.keyRevision])) }, () => {});
  assert.equal(equal.equal, true); assert.equal(equal.values, undefined);
  await assert.rejects(f.service.metadataDigest('owner', { versions: { pages: -1 } }, () => {}), /versions/);
});

test('foreground receipts survive an equal metadata digest without shadowing thumbnail presentation', async t => {
  const f = await fixture(t), client = await f.client();
  const tab = await f.service.createTab(grant('compat-create'), { url: 'https://example.test/compat' });
  await eventually(() => client.getItem('opencraft.browser-tabs.v1') !== null);
  const shown = f.service.presentTab(grant('compat-present'), { tabId: tab.tabId });
  const failed = shown.catch(error => error);
  await eventually(() => client.presentationRequests().some(row => row.tabId === tab.tabId));
  const receipt = client.presentationRequests().find(row => row.tabId === tab.tabId)!;
  const snapshot = await f.service.metadata('owner', undefined, () => {});
  const digest = await f.service.metadataDigest('owner', { root: snapshot.root, versions: snapshot.keyRevisions }, () => {});
  assert.equal(digest.equal, true);
  assert.equal(digest.presentationRequests.some(row => row.id === receipt.id), true);
  const page = [...f.service.pages.values()].find(row => row.link?.tabId === tab.tabId)!;
  assert.equal(await client.readPresentation(JSON.parse(page.key)[1]), null, 'legacy thumbnail route remains readable');
  assert.equal((await client.acknowledgePresentation(receipt.id, 'claim')).status, 'claimed');
  assert.equal((await client.acknowledgePresentation(receipt.id, 'visible')).status, 'visible');
  const result = await failed;
  assert.equal(result.visible, true);
});


test('one browser client restores presentation and successive navigation without a metadata failure', async t => {
  const f = await fixture(t), tab = await f.service.createTab(grant('single-phone'), { url: 'https://example.test/' });
  const storage = await f.client(); await storage.flush();
  let failures = 0; storage.onError(() => failures++);
  const key = 'opencraft.browser-tabs.v1';
  const tabs = JSON.parse(storage.getItem(key)!); tabs[0].panelAttached = true;
  storage.setItem(key, JSON.stringify(tabs));
  tabs[0].viewportMode = { type: 'fit', width: 390, height: 844 };
  storage.setItem(key, JSON.stringify(tabs));
  const pageKey = 'opencraft.browser-pages.v1';
  const pages = JSON.parse(storage.getItem(pageKey)!);
  pages[0].entries = [{ url: 'https://example.test/', title: 'Loading' }];
  storage.setItem(pageKey, JSON.stringify(pages));
  pages[0].entries[0].title = 'Loaded'; storage.setItem(pageKey, JSON.stringify(pages));
  await storage.flush(); await storage.reconcile();
  assert.equal(f.service.metadataPeers.size, 1); assert.equal(storage.isReady, true); assert.equal(failures, 0);
  assert.equal(JSON.parse(storage.getItem(key)!)[0].viewportMode.height, 844);
  assert.equal(JSON.parse(storage.getItem(pageKey)!)[0].entries[0].title, 'Loaded');
  assert.equal(f.service.commands.filter(command => command.method === 'create').length, 1);
  assert.equal(JSON.parse(storage.getItem(key)!)[0].id, tab.tabId);
});


test('presentation observations are bounded evidence and never claim or settle a request', async t => {
  const f=await fixture(t),binding=grant('observe'),tab=await f.service.createTab(binding,{url:'https://example.test/'}),storage=await f.client();await storage.flush();
  const presenting=f.service.presentTab(binding,{tabId:tab.tabId},{timeoutMs:1500});const rejected=assert.rejects(presenting,/owner-mismatch/);
  await eventually(()=>f.service.store.account('owner').states[0][1].presentationRequests?.length===1);
  const request=f.service.store.account('owner').states[0][1].presentationRequests[0];
  await storage.acknowledgePresentation(request.id,'observe','owner-mismatch');
  const result=await storage.acknowledgePresentation(request.id,'observe','owner-mismatch');
  assert.equal(result.status,'pending');assert.equal(result.clientId,undefined);assert.equal((result as any).observations.length,1);
  await assert.rejects(storage.acknowledgePresentation(request.id,'observe','https://secret.test' as any),{code:'INVALID_ARGUMENT'});
  await rejected;
});


test('presentation observations explain nonclaims without owning focus or settling the request', async t => {
 const f=await fixture(t);const tab=await f.service.createTab(grant('observed'),{url:'https://example.test/'});
 const storage=await f.client();await storage.flush();
 const presenting=f.service.presentTab(grant('observed'),{tabId:tab.tabId},{timeoutMs:2000});
 await eventually(()=>storage.presentationRequests().some(row=>row.status==='pending'));
 const id=storage.presentationRequests().find(row=>row.status==='pending')!.id;
 const observed:any=await storage.acknowledgePresentation(id,'observe','view-inactive');
 assert.equal(observed.status,'pending');assert.equal(observed.clientId,undefined);assert.equal(observed.observations.length,1);
 const again:any=await storage.acknowledgePresentation(id,'observe','view-inactive');assert.equal(again.observations.length,1);
 await assert.rejects(storage.acknowledgePresentation(id,'observe','secret-url' as any),/Invalid browser presentation/);
 await storage.acknowledgePresentation(id,'claim');
 await storage.acknowledgePresentation(id,'failed','paint-timeout');
 await assert.rejects(presenting,/paint-timeout/);
});
