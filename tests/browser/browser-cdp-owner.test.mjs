import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { createElectronCdpOwner } = createRequire(import.meta.url)('../../packages/browser-cdp/src/electron/owner.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

function fixture(options = {}) {
  const wc = new EventEmitter(), debuggerPort = new EventEmitter(), calls = [], failures = [];
  let attached = options.attached ?? false, destroys = false, implementation = async () => ({}), detaches = 0;
  Object.assign(debuggerPort, {
    isAttached: () => attached,
    attach() { attached = true; },
    detach() { attached = false; detaches++; debuggerPort.emit('detach', {}, 'disposed'); },
    async sendCommand(method, params, sessionId) {
      calls.push({ method, params, sessionId }); return implementation(method, params, sessionId);
    },
  });
  Object.assign(wc, { debugger: debuggerPort, isDestroyed: () => destroys });
  const owner = createElectronCdpOwner(wc, {
    onFailure: error => failures.push(error),
    initializeTarget: send => send('Emulation.setFocusEmulationEnabled', { enabled: true }),
    ...options,
  });
  return { wc, owner, calls, failures, get detaches() { return detaches; },
    implement(fn) { implementation = fn; },
    attach(sessionId, targetId = sessionId, parentSessionId) {
      debuggerPort.emit('message', {}, 'Target.attachedToTarget', { sessionId, targetInfo: { type: 'iframe', targetId } }, parentSessionId);
    },
    detach(sessionId) { debuggerPort.emit('message', {}, 'Target.detachedFromTarget', { sessionId }); },
    event(method, params, sessionId) { debuggerPort.emit('message', {}, method, params, sessionId); },
    destroyed() { destroys = true; wc.emit('destroyed'); },
  };
}

test('one owner per page; connection cleanup preserves a borrowed attachment', async () => {
  for (const attached of [false, true]) {
    const f = fixture({ attached }); await f.owner.ready;
    assert.throws(() => createElectronCdpOwner(f.wc), { code: 'CDP_OWNER_EXISTS' });
    f.owner.dispose(); f.owner.dispose();
    assert.equal(f.detaches, attached ? 0 : 1);
    assert.equal(f.wc.debugger.listenerCount('message'), 0);
    assert.equal(f.wc.listenerCount('destroyed'), 0);
  }
});

test('nested frame setup resumes scripts and routes commands and events by session', async t => {
  const f = fixture(); t.after(() => f.owner.dispose()); await f.owner.ready;
  const events = [], unsubscribe = f.owner.subscribe(event => events.push(event));
  f.implement(async (method, _params, session) => {
    if (method === 'Target.setAutoAttach' && session === 'child') f.attach('nested', 'nested-target');
    return {};
  });
  f.attach('child', 'child-target'); await tick();
  for (const session of ['child', 'nested']) assert.deepEqual(f.calls.filter(c => c.sessionId === session).map(c => c.method),
    ['Emulation.setFocusEmulationEnabled', 'Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger']);
  await f.owner.send('DOM.getDocument', {}, 'nested');
  assert.equal(f.calls.at(-1).sessionId, 'nested');
  f.event('Runtime.executionContextCreated', { context: { id: 4 } }, 'nested');
  assert.equal(events.at(-1).targetId, 'nested-target');
  unsubscribe(); const count = events.length;
  f.event('Runtime.executionContextDestroyed', { executionContextId: 4 }, 'nested');
  assert.equal(events.length, count);
  f.detach('nested');
  await assert.rejects(f.owner.send('DOM.getDocument', {}, 'nested'), { code: 'STALE_TARGET', outcome: 'not-dispatched' });
});

test('frame detach during initialization retires queued input and still resumes scripts', async t => {
  const f = fixture(); t.after(() => f.owner.dispose()); await f.owner.ready;
  const held = deferred();
  f.implement(async (method, _params, session) => {
    if (method === 'Emulation.setFocusEmulationEnabled' && session === 'child') await held.promise;
    return {};
  });
  f.attach('child'); await tick();
  const input = f.owner.send('Input.insertText', { text: 'stale' }, 'child');
  const rejected = assert.rejects(input, { code: 'STALE_TARGET', outcome: 'not-dispatched' });
  f.detach('child'); await rejected;
  assert(f.calls.some(c => c.method === 'Runtime.runIfWaitingForDebugger' && c.sessionId === 'child'));
  held.resolve(); await tick();
  assert(!f.calls.some(c => c.method === 'Input.insertText'));
  assert.equal(f.failures.length, 0);
});

test('parent target retirement also invalidates nested sessions without individual detach events', async t => {
  const f = fixture(); t.after(() => f.owner.dispose()); await f.owner.ready;
  f.attach('parent'); await tick();
  f.attach('nested', 'nested-target', 'parent'); await tick();
  assert.equal(f.owner.targetSessions().length, 2);
  f.detach('parent');
  assert.deepEqual(f.owner.targetSessions(), []);
  await assert.rejects(f.owner.send('DOM.getDocument', {}, 'nested'), { code: 'STALE_TARGET', outcome: 'not-dispatched' });
});

test('input waits for every configuration queued while it is waiting', async t => {
  const f = fixture(); t.after(() => f.owner.dispose()); await f.owner.ready;
  const first = deferred(), second = deferred();
  const c1 = f.owner.configure(async send => { await first.promise; await send('Emulation.setDeviceMetricsOverride', { width: 400 }); });
  const input = f.owner.send('Input.dispatchMouseEvent', { type: 'mousePressed' });
  await tick();
  const c2 = f.owner.configure(async send => { await second.promise; await send('Emulation.setDeviceMetricsOverride', { width: 800 }); });
  first.resolve(); await c1; await tick();
  assert(!f.calls.some(c => c.method.startsWith('Input.')));
  second.resolve(); await Promise.all([c2, input]);
  assert.deepEqual(f.calls.slice(-3).map(c => c.params.width ?? c.method), [400, 800, 'Input.dispatchMouseEvent']);
});

test('timeout does not detach or replay native input, and late ACK stays local', async t => {
  const f = fixture(); t.after(() => f.owner.dispose()); await f.owner.ready;
  const held = deferred();
  f.implement(async method => method.startsWith('Input.') ? held.promise : {});
  await assert.rejects(f.owner.send('Input.insertText', { text: 'once' }, undefined, { timeoutMs: 10 }),
    { code: 'CDP_TIMEOUT', outcome: 'unknown', retryable: false });
  assert.equal(f.detaches, 0);
  assert.equal(f.calls.filter(c => c.method === 'Input.insertText').length, 1);
  held.resolve({ late: true }); await tick();
  await f.owner.send('DOM.getDocument');
  assert.equal(f.calls.filter(c => c.method === 'Input.insertText').length, 1);
});

test('aborted work waiting for configuration never dispatches input', async t => {
  const f = fixture(); t.after(() => f.owner.dispose()); await f.owner.ready;
  const held = deferred(), controller = new AbortController();
  const config = f.owner.configure(async () => held.promise);
  const input = f.owner.send('Input.insertText', { text: 'cancelled' }, undefined, { signal: controller.signal });
  const rejected = assert.rejects(input, { code: 'CDP_ABORTED', outcome: 'not-dispatched' });
  controller.abort(); await rejected;
  held.resolve(); await config; await tick();
  assert(!f.calls.some(c => c.method.startsWith('Input.')));
});

test('timed-out configuration retains its native barrier until ACK and requires repair', async t => {
  const f = fixture(); t.after(() => f.owner.dispose()); await f.owner.ready;
  const held = deferred();
  f.implement(async method => method === 'Emulation.setDeviceMetricsOverride' ? held.promise : {});
  await assert.rejects(f.owner.configure(send => send('Emulation.setDeviceMetricsOverride', { width: 400 }), { timeoutMs: 10 }),
    { code: 'CDP_TIMEOUT', outcome: 'unknown' });
  const input = f.owner.send('Input.insertText', { text: 'unsafe' });
  const rejected = assert.rejects(input, { outcome: 'not-dispatched' });
  await tick(); assert(!f.calls.some(c => c.method.startsWith('Input.')));
  held.resolve({}); await rejected;
  await f.owner.configure(async () => {});
  await f.owner.send('DOM.getDocument');
});

test('host identity is revalidated after configuration before any native input', async t => {
  const f = fixture(); t.after(() => f.owner.dispose()); await f.owner.ready;
  const held = deferred(); let document = 'original';
  const config = f.owner.configure(async () => held.promise);
  const input = f.owner.send('Input.insertText', { text: 'old document' }, undefined, {
    validate() { if (document !== 'original') throw Object.assign(new Error('Document changed'), { code: 'DOCUMENT_CHANGED' }); },
  });
  const rejected = assert.rejects(input, { code: 'DOCUMENT_CHANGED', outcome: 'not-dispatched' });
  document = 'replacement'; held.resolve(); await config; await rejected;
  assert(!f.calls.some(c => c.method.startsWith('Input.')));
});

test('disconnect retires pending calls without transparently reconnecting', async t => {
  const f = fixture(); t.after(() => f.owner.dispose()); await f.owner.ready;
  const held = deferred(); f.implement(async () => held.promise);
  const input = f.owner.send('Input.insertText', { text: 'unknown' }); await tick();
  const rejected = assert.rejects(input, { code: 'CDP_DISCONNECTED', outcome: 'unknown' });
  f.wc.debugger.emit('detach', {}, 'replaced'); await rejected;
  await assert.rejects(f.owner.send('DOM.getDocument'), { code: 'CDP_DISCONNECTED', outcome: 'not-dispatched' });
  held.resolve({});
});

test('replacement owner cannot adopt a page while disposed native work is unresolved', async () => {
  const f = fixture(); await f.owner.ready;
  const held = deferred(); f.implement(async () => held.promise);
  const input = f.owner.send('Input.insertText', { text: 'once' }); await tick();
  const rejected = assert.rejects(input, { code: 'PAGE_CLOSED', outcome: 'unknown' });
  f.owner.dispose(); await rejected;
  assert.throws(() => createElectronCdpOwner(f.wc), { code: 'CDP_OWNER_EXISTS' });
  held.resolve({}); await tick();
  const next = createElectronCdpOwner(f.wc); await next.ready; next.dispose();
});

test('owner disposal resumes a paused child and rejects held input', async () => {
  const f = fixture(); await f.owner.ready;
  const held = deferred();
  f.implement(async (method, _params, session) => session === 'child' && method.startsWith('Emulation.') ? held.promise : {});
  f.attach('child'); await tick();
  const input = f.owner.send('Input.insertText', { text: 'late' }, 'child');
  const rejected = assert.rejects(input, { code: 'PAGE_CLOSED', outcome: 'not-dispatched' });
  f.owner.dispose(); await rejected; await tick();
  assert(f.calls.some(c => c.method === 'Runtime.runIfWaitingForDebugger' && c.sessionId === 'child'));
  held.resolve(); await tick();
  assert(!f.calls.some(c => c.method.startsWith('Input.')));
});
