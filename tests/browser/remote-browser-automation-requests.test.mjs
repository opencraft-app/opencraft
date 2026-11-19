import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { RemoteBrowserService } from '../../scripts/remote-browser-service.mjs';
const { createAutomationRequests } = createRequire(import.meta.url)('../../scripts/remote-browser/automation-requests.cjs');
const { createControls } = createRequire(import.meta.url)('../../scripts/remote-browser/controls.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('private cancellation stops queued automation without dispatch or affecting another page', async () => {
  const requests = createAutomationRequests(), seen = []; let release;
  const dispatch = createControls(async message => {
    seen.push(message);
    if (message.method === 'control') await new Promise(resolve => { release = resolve; });
  });
  const hold = requests.run({ page: 'one', method: 'control' }, dispatch); await tick();
  const pending = requests.run({ id: 'call', page: 'one', method: 'automation', control: 'grant' }, dispatch);
  const rejection = assert.rejects(pending, { code: 'CDP_ABORTED', outcome: 'not-dispatched' });
  requests.cancel('other', 'call');
  requests.cancel('one', 'call');
  await requests.run({ id: 'other', page: 'two', method: 'automation', control: 'grant' }, dispatch);
  release(); await Promise.all([hold, rejection]);
  assert.deepEqual(seen.map(message => [message.page, message.method]), [['one', 'control'], ['two', 'automation']]);
});

test('control retirement aborts admitted writes promptly and preserves unrelated reads', async () => {
  const requests = createAutomationRequests(), signals = new Map();
  const dispatch = message => new Promise(resolve => { signals.set(message.id, message.signal); message.signal.addEventListener('abort', resolve, { once: true }); });
  const write = requests.run({ id: 'write', page: 'one', method: 'automation', control: 'old' }, dispatch);
  const read = requests.run({ id: 'read', page: 'one', method: 'automation' }, dispatch); await tick();
  requests.retire('one', control => control !== undefined && control !== 'new'); await write;
  assert.equal(signals.get('write').aborted, true); assert.equal(signals.get('read').aborted, false);
  requests.retire('one'); await read;
});

test('automation admission is bounded and duplicate identities never dispatch twice', async () => {
  const requests = createAutomationRequests(), pending = []; let calls = 0;
  const dispatch = message => new Promise(resolve => { calls++; message.signal.addEventListener('abort', resolve, { once: true }); });
  for (let index = 0; index < 32; index++) pending.push(requests.run({ id: `call-${index}`, page: 'one', method: 'automation' }, dispatch));
  await tick();
  await assert.rejects(requests.run({ id: 'call-0', page: 'one', method: 'automation' }, dispatch), /identity/);
  await assert.rejects(requests.run({ id: 'excess', page: 'one', method: 'automation' }, dispatch), { code: 'BROWSER_BUSY', outcome: 'not-dispatched' });
  assert.equal(calls, 32); requests.retire('one'); await Promise.all(pending);
  await requests.run({ id: 'after', page: 'one', method: 'automation' }, () => { calls++; });
  assert.equal(calls, 33);
});

test('only admitted navigation survives its document change; control loss still cancels it', async () => {
  const requests = createAutomationRequests(), signals = new Map(); let navigate;
  const dispatched = new Promise(resolve => { navigate = resolve; });
  const native = requests.run({ id: 'navigation', page: 'one', method: 'automation', control: 'grant' }, message => {
    signals.set(message.id, message.signal);
    return requests.navigating(message.id, () => { navigate(); return new Promise(resolve => message.signal.addEventListener('abort', resolve, { once: true })); });
  });
  const queued = requests.run({ id: 'queued-navigation', page: 'one', method: 'automation', control: 'grant' }, message => {
    signals.set(message.id, message.signal);
    return new Promise(resolve => message.signal.addEventListener('abort', resolve, { once: true }));
  });
  await dispatched; await tick(); requests.documentChanged('one'); await queued;
  assert.equal(signals.get('navigation').aborted, false); assert.equal(signals.get('queued-navigation').aborted, true);
  requests.retire('one', token => token === 'grant'); await native;
  assert.equal(signals.get('navigation').aborted, true);
  assert.throws(() => requests.navigating('navigation', () => assert.fail('retired request dispatched')), { outcome: 'not-dispatched' });
});

test('gateway cancellation uses the original private request identity and never replays work', async () => {
  const service = new RemoteBrowserService({ root: '/unused', dataDirectory: '/unused', ownerConnector: null });
  const messages = []; service.child = { connected: true, send(message) { messages.push(message); }, kill() {} };
  const controller = new AbortController();
  const pending = service.request('page', 'automation', { method: 'wait', input: { text: 'never', timeoutMs: 60000 } }, 'grant', 'document', { signal: controller.signal });
  let settled = false; void pending.finally(() => { settled = true; }).catch(() => {});
  const rejection = assert.rejects(pending, { code: 'CDP_ABORTED', retryable: false, outcome: 'unknown' });
  controller.abort(); await tick();
  assert.equal(messages.length, 2); assert.equal(messages[1].method, 'cancelAutomation');
  assert.equal(messages[1].input.requestId, messages[0].id); assert.equal(service.requests.size, 1);
  assert.equal(settled, false, 'logical cancellation cannot release physical reply custody');
  service.receive({ type: 'result', id: messages[1].id, value: { cancelled: true } });
  assert.equal(service.requests.size, 1); assert.equal(settled, false, 'a cancellation command ACK is not the original operation reply');
  service.receive({ type: 'result', id: messages[0].id, value: 'late' });
  await rejection; assert.equal(settled, true); assert.equal(service.requests.size, 0);
  await assert.rejects(service.request('page', 'automation', {}, undefined, undefined, { signal: controller.signal }), { outcome: 'not-dispatched' });
  assert.equal(messages.length, 2); service.close();
});

test('renderer loss keeps an admitted automation outcome unknown and does not suggest replay', async () => {
  const service = new RemoteBrowserService({ root: '/unused', dataDirectory: '/unused', ownerConnector: null });
  service.child = { connected: true, send() {}, kill() {} }; service.runtimeState = async () => {};
  service.pages.set('page', { id: 'page', live: true });
  const pending = service.request('page', 'automation', { method: 'fill' });
  const rejection = assert.rejects(pending, { code: 'BROWSER_UNAVAILABLE', retryable: false, outcome: 'unknown' });
  service.receive({ type: 'renderer-gone', page: 'page' }); await rejection;
  assert.equal(service.requests.size, 0); service.pages.clear(); service.close();
});

test('cancelling an uninterruptible native capture retains custody until its original reply', async () => {
  const service = new RemoteBrowserService({ root: '/unused', dataDirectory: '/unused', ownerConnector: null });
  const messages = []; service.child = { connected: true, send(message) { messages.push(message); }, kill() {} };
  const controller = new AbortController(); let settled = false;
  const pending = service.request('page', 'capture', {}, undefined, undefined, { signal: controller.signal });
  void pending.finally(() => { settled = true; }).catch(() => {});
  const rejection = assert.rejects(pending, { code: 'CDP_ABORTED', outcome: 'unknown' });
  controller.abort(); await tick();
  assert.equal(messages.length, 1, 'there is no fake native capture cancellation command');
  assert.equal(service.requests.size, 1); assert.equal(settled, false);
  service.receive({ type: 'result', id: messages[0].id, value: 'private native image must not escape after cancellation' });
  await rejection; assert.equal(service.requests.size, 0); service.close();
});

test('a native cancellation deadline remains unknown and never fabricates completion', async t => {
  const nativeTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => nativeTimeout(callback, delay >= 35000 ? 5 : delay, ...args));
  const service = new RemoteBrowserService({ root: '/unused', dataDirectory: '/unused', ownerConnector: null });
  const messages = []; service.child = { connected: true, send(message) { messages.push(message); }, kill() {} };
  const controller = new AbortController();
  const pending = service.request('page', 'automation', { method: 'wait', input: { timeoutMs: 60000 } }, undefined, undefined, { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'CDP_ABORTED', retryable: false, outcome: 'unknown' });
  controller.abort(); assert.equal(service.requests.size, 1);
  await new Promise(resolve => nativeTimeout(resolve, 20)); await rejected;
  assert.equal(service.requests.size, 0); assert.equal(messages.length, 2);
  service.receive({ type: 'result', id: messages[0].id, value: 'late result cannot change the unknown outcome' });
  service.close();
});
