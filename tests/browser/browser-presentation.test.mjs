import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { RemoteBrowserService } from '../../apps/headless-server/src/remote-browser-service.mjs';
import { acknowledgePresentation } from '../../apps/headless-server/src/remote-browser/tab-presentation.mjs';

class Native extends RemoteBrowserService {
  native = new Map();
  async start() { await this.load(); }
  async request(id, method, input) {
    if (method === 'create') this.native.set(id, { document: randomUUID(), width: 800, height: 600, deviceProfile: 'desktop', navigation: { url: 'about:blank' } });
    if (method === 'navigate') this.native.get(id).navigation.url = input.url;
    if (method === 'close') this.native.delete(id);
    return this.native.get(id);
  }
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'browser-presentation-'));
  const service = new Native({ root, dataDirectory: root, ownerConnector: null });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const binding = { ownerId: 'owner', hostId: 'host', threadId: 'thread', turnId: 'turn', callId: 'create', authorize() {} };
  const tab = await service.createTab(binding, { url: 'https://presentation.example/' });
  const socket = { readyState: 1, send() {}, close() {} };
  service.metadataPeers.set(socket, { ownerId: 'owner', authorize() {} });
  return { service, binding: { ...binding, callId: 'present' }, tab };
}
async function pending(service) {
  for (let index = 0; index < 300; index++) {
    const request = service.store.account('owner').states[0]?.[1].presentationRequests?.find(row => row.status === 'pending');
    if (request) return request;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('presentation request did not commit');
}
const client = 'client-' + randomUUID();
const ack = (f, id, action, clientId = client) => acknowledgePresentation(f.service, 'owner', { id, action, clientId }, () => {});

test('foreground presentation returns visible only after durable exclusive client acknowledgement', async t => {
  const f = await fixture(t); let settled = false;
  const presenting = f.service.presentTab(f.binding, { tabId: f.tab.tabId }); presenting.then(() => { settled = true; });
  const request = await pending(f.service); assert.equal(settled, false);
  await assert.rejects(acknowledgePresentation(f.service, 'foreign', { id: request.id, action: 'claim', clientId: client }, () => {}), /Unknown/);
  await ack(f, request.id, 'claim');
  await assert.rejects(ack(f, request.id, 'claim', 'other-' + randomUUID()), { code: 'PRESENTATION_CLAIMED' });
  assert.equal(settled, false);
  await ack(f, request.id, 'visible');
  assert.equal((await presenting).visible, true);
  assert.equal((await f.service.store.readPresentation('owner', request.id)).status, 'visible');
  await f.service.commit(draft => { draft.states[0][1].presentationRequests = []; }, { ownerId: 'owner' });
  assert.equal((await f.service.presentTab(f.binding, { tabId: f.tab.tabId })).visible, true, 'compacted queue cannot replay focus');
});

test('cancellation retires an unclaimed presentation and late client acknowledgement cannot display it', async t => {
  const f = await fixture(t), controller = new AbortController();
  const presenting = f.service.presentTab(f.binding, { tabId: f.tab.tabId }, { signal: controller.signal });
  const rejected = assert.rejects(presenting, { code: 'BROWSER_ABORTED', outcome: 'not-dispatched' });
  const request = await pending(f.service); controller.abort(); await rejected;
  assert.equal((await ack(f, request.id, 'claim')).status, 'cancelled');
  assert.equal((await f.service.store.readPresentation('owner', request.id)).status, 'cancelled');
});

test('claimed presentation timeout stays unknown and is never reassigned or redispatched', async t => {
  const f = await fixture(t);
  const presenting = f.service.presentTab(f.binding, { tabId: f.tab.tabId }, { timeoutMs: 150 });
  const rejected = assert.rejects(presenting, { code: 'PRESENTATION_UNAVAILABLE', outcome: 'unknown' });
  const request = await pending(f.service); await ack(f, request.id, 'claim'); await rejected;
  assert.equal((await f.service.store.readPresentation('owner', request.id)).status, 'expired');
  await assert.rejects(f.service.presentTab(f.binding, { tabId: f.tab.tabId }), { code: 'PRESENTATION_UNAVAILABLE', outcome: 'unknown' });
  assert.equal(f.service.store.account('owner').states[0][1].presentationRequests.length, 1);
});

test('durable browser effect receipts suppress completed, concurrent and uncertain native replay', async t => {
  const { invokeWithReceipt } = await import('../../apps/headless-server/src/remote-browser/operation-receipts.mjs');
  const f = await fixture(t), [tab] = await f.service.conversationTabs('owner', 'host', 'thread', () => {});
  const binding = { ...f.binding, ...tab, callId: 'effect' }, input = { ref: 'ref-1', value: 'synthetic-private-input', expectedRevision: 1 };
  let release, entered, calls = 0;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const dispatch = async () => { calls++; entered(); await gate; return { completed: true }; };
  const first = invokeWithReceipt(f.service, binding, 'fill', input, {}, dispatch); await started;
  await assert.rejects(invokeWithReceipt(f.service, binding, 'fill', input, {}, dispatch), { code: 'BROWSER_OUTCOME_UNKNOWN', outcome: 'unknown' });
  release(); await first;
  assert.equal((await invokeWithReceipt(f.service, binding, 'fill', input, {}, dispatch)).completed, true);
  assert.equal(calls, 1);
  await assert.rejects(invokeWithReceipt(f.service, binding, 'fill', { ...input, value: 'different' }, {}, dispatch), { code: 'OPERATION_CONFLICT' });
  const uncertain = { ...binding, callId: 'uncertain' };
  const timeout = async () => { calls++; throw Object.assign(Error('lost native acknowledgement'), { code: 'CDP_TIMEOUT', outcome: 'unknown' }); };
  await assert.rejects(invokeWithReceipt(f.service, uncertain, 'click', { ref: 'ref-1' }, {}, timeout), { code: 'CDP_TIMEOUT' });
  await assert.rejects(invokeWithReceipt(f.service, uncertain, 'click', { ref: 'ref-1' }, {}, timeout), { code: 'CDP_TIMEOUT', outcome: 'unknown' });
  assert.equal(calls, 2);
});

test('every browser write has a permanent receipt while observations stay ledger-free', async t => {
  const { invokeWithReceipt } = await import('../../apps/headless-server/src/remote-browser/operation-receipts.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const f = await fixture(t), [tab] = await f.service.conversationTabs('owner', 'host', 'thread', () => {});
  let calls = 0;
  for (const method of ['navigate', 'back', 'forward', 'reload', 'stop', 'click', 'fill', 'press', 'scroll']) {
    const binding = { ...f.binding, ...tab, callId: method }, dispatch = async () => { calls++; return {}; };
    await invokeWithReceipt(f.service, binding, method, { value: 'synthetic-private-input' }, {}, dispatch);
    await invokeWithReceipt(f.service, binding, method, { value: 'synthetic-private-input' }, {}, dispatch);
  }
  assert.equal(calls, 9);
  const db = new DatabaseSync(join(f.service.dataDirectory, 'state.sqlite'), { readOnly: true });
  try {
    const rows = db.prepare('SELECT value FROM browser_operations').all();
    assert.equal(rows.length, 9);
    assert(!JSON.stringify(rows).includes('synthetic-private-input'));
    for (const method of ['inspect', 'readContext', 'wait', 'capture', 'activate'])
      await invokeWithReceipt(f.service, { ...f.binding, ...tab, callId: method }, method, {}, {}, async () => ({}));
    assert.equal(db.prepare('SELECT count(*) AS n FROM browser_operations').get().n, 9);
  } finally { db.close(); }
});

test('closing a tab atomically cancels its pending presentation and prevents a late client claim', async t => {
  const f = await fixture(t);
  const presenting = f.service.presentTab(f.binding, { tabId: f.tab.tabId });
  const rejected = assert.rejects(presenting, { code: 'PRESENTATION_UNAVAILABLE', outcome: 'not-dispatched' });
  const request = await pending(f.service);
  await f.service.closeTab(f.binding, { tabId: f.tab.tabId }); await rejected;
  assert.equal((await f.service.store.readPresentation('owner', request.id)).status, 'cancelled');
  assert.equal((await ack(f, request.id, 'claim')).status, 'cancelled');
  assert.equal(f.service.store.account('owner').pages.length, 0);
});

test('operation receipts survive service restart without replaying completed or uncertain input', async t => {
  const { invokeWithReceipt } = await import('../../apps/headless-server/src/remote-browser/operation-receipts.mjs');
  const f = await fixture(t), [tab] = await f.service.conversationTabs('owner', 'host', 'thread', () => {});
  const binding = { ...f.binding, ...tab, callId: 'restart-completed' };
  let calls = 0;
  await invokeWithReceipt(f.service, binding, 'click', {}, {}, async () => { calls++; return { completed: true }; });
  const uncertain = { ...binding, callId: 'restart-unknown' };
  await assert.rejects(invokeWithReceipt(f.service, uncertain, 'press', {}, {}, async () => {
    calls++; throw Object.assign(Error('synthetic lost result'), { outcome: 'unknown' });
  }));
  await f.service.close();
  const root = join(f.service.dataDirectory, '..');
  const reopened = new Native({ root, dataDirectory: root, ownerConnector: null });
  t.after(() => reopened.close());
  await reopened.load();
  const dispatch = async () => { calls++; assert.fail('persisted effect must not dispatch again'); };
  assert.equal((await invokeWithReceipt(reopened, binding, 'click', {}, {}, dispatch)).completed, true);
  await assert.rejects(invokeWithReceipt(reopened, uncertain, 'press', {}, {}, dispatch), { outcome: 'unknown' });
  assert.equal(calls, 2);
});

test('cancellation after receipt admission but before dispatch is durably not-dispatched', async t => {
  const { invokeWithReceipt } = await import('../../apps/headless-server/src/remote-browser/operation-receipts.mjs');
  const f = await fixture(t), [tab] = await f.service.conversationTabs('owner', 'host', 'thread', () => {});
  const binding = { ...f.binding, ...tab, callId: 'cancel-before-dispatch' }, controller = new AbortController();
  const transact = f.service.store.transactOperation.bind(f.service.store);
  f.service.store.transactOperation = async (...args) => {
    const result = await transact(...args);
    if (result?.admitted) controller.abort();
    return result;
  };
  let calls = 0;
  const dispatch = async () => { calls++; };
  await assert.rejects(invokeWithReceipt(f.service, binding, 'fill', {}, { signal: controller.signal }, dispatch),
    { code: 'BROWSER_ABORTED', outcome: 'not-dispatched' });
  await assert.rejects(invokeWithReceipt(f.service, binding, 'fill', {}, {}, dispatch), { outcome: 'not-dispatched' });
  assert.equal(calls, 0);
});

test('visible presentation receipt survives restart and disconnected clients without a new delivery', async t => {
  const f = await fixture(t);
  const presenting = f.service.presentTab(f.binding, { tabId: f.tab.tabId });
  const request = await pending(f.service);
  await ack(f, request.id, 'claim'); await ack(f, request.id, 'visible'); await presenting;
  await f.service.commit(draft => { draft.states[0][1].presentationRequests = []; }, { ownerId: 'owner' });
  await f.service.close();
  const root = join(f.service.dataDirectory, '..');
  const reopened = new Native({ root, dataDirectory: root, ownerConnector: null });
  t.after(() => reopened.close());
  const result = await reopened.presentTab(f.binding, { tabId: f.tab.tabId });
  assert.equal(result.visible, true);
  assert.equal(result.presentationId, request.id);
  assert.deepEqual(reopened.store.account('owner').states[0][1].presentationRequests, []);
  assert.equal(reopened.native.size, 0);
});

test('persisted operation success cannot bypass current authority or conversation ownership', async t => {
  const { invokeWithReceipt } = await import('../../apps/headless-server/src/remote-browser/operation-receipts.mjs');
  const f = await fixture(t), [tab] = await f.service.conversationTabs('owner', 'host', 'thread', () => {});
  const binding = { ...f.binding, ...tab, callId: 'authority-replay' };
  let calls = 0;
  const dispatch = async () => { calls++; return { completed: true }; };
  await invokeWithReceipt(f.service, binding, 'click', {}, {}, dispatch);
  await assert.rejects(invokeWithReceipt(f.service, { ...binding, authorize() { throw Error('revoked'); } }, 'click', {}, {}, dispatch), /revoked/);
  await assert.rejects(invokeWithReceipt(f.service, { ...binding, threadId: 'foreign' }, 'click', {}, {}, dispatch), { code: 'TAB_ACCESS_DENIED' });
  await assert.rejects(invokeWithReceipt(f.service, { ...binding, scopeId: 'foreign' }, 'click', {}, {}, dispatch), { code: 'TAB_ACCESS_DENIED' });
  const transact = f.service.store.transactOperation.bind(f.service.store);
  let revoked = false;
  f.service.store.transactOperation = async (...args) => {
    const result = await transact(...args);
    revoked = true;
    return result;
  };
  await assert.rejects(invokeWithReceipt(f.service, { ...binding, authorize() {
    if (revoked) throw Error('revoked while receipt was loading');
  } }, 'click', {}, {}, dispatch), /revoked while receipt/);
  assert.equal(calls, 1);
});
