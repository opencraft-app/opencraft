import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { initializeNativeFocus } = createRequire(import.meta.url)('../../scripts/remote-browser/focus.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const debuggerPort = new EventEmitter(), calls = [], failures = [];
  let attached = false, send = async () => {};
  Object.assign(debuggerPort, { isAttached: () => attached, attach() { attached = true; },
    async sendCommand(method, input, session) { calls.push({ method, input, session }); return send(method, input, session); } });
  return { wc: { debugger: debuggerPort, isDestroyed: () => false }, calls, failures,
    fail: () => failures.push('failed'), send(value) { send = value; },
    attach(session) { debuggerPort.emit('message', {}, 'Target.attachedToTarget', { sessionId: session, targetInfo: { type: 'iframe' } }); },
    detach(session) { debuggerPort.emit('message', {}, 'Target.detachedFromTarget', { sessionId: session }); } };
}
test('iframe and nested renderer scripts resume only after their own focus initialization', async () => {
  const f = fixture(), dispose = await initializeNativeFocus(f.wc, f.fail);
  f.send(async (method, _input, session) => {
    if (method === 'Target.setAutoAttach' && session === 'child') f.attach('nested');
  });
  f.attach('child'); await tick();
  for (const session of ['child', 'nested']) {
    const own = f.calls.filter(c => c.session === session).map(c => c.method);
    assert.deepEqual(own, ['Emulation.setFocusEmulationEnabled', 'Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger']);
  }
  assert.deepEqual(f.failures, []); dispose(); assert.equal(f.wc.debugger.listenerCount('message'), 0);
});
test('failed iframe focus resumes its script, while detach suppresses obsolete failure', async () => {
  const f = fixture(), dispose = await initializeNativeFocus(f.wc, f.fail);
  f.send(async (method, _input, session) => {
    if (method === 'Emulation.setFocusEmulationEnabled' && session) throw Error('target failed');
  });
  f.attach('live'); await tick(); assert.deepEqual(f.failures, ['failed']);
  assert(f.calls.some(c => c.session === 'live' && c.method === 'Runtime.runIfWaitingForDebugger'));
  f.attach('gone'); f.detach('gone'); await tick(); assert.deepEqual(f.failures, ['failed']);
  assert(f.calls.some(c => c.session === 'gone' && c.method === 'Runtime.runIfWaitingForDebugger')); dispose();
});
test('disposed in-flight attachment still resumes and startup failure removes its listener', async () => {
  const f = fixture(), dispose = await initializeNativeFocus(f.wc, f.fail);
  let release; const pending = new Promise(resolve => { release = resolve; });
  f.send(async (_method, _input, session) => { if (session === 'child') await pending; });
  f.attach('child'); dispose(); release(); await tick();
  assert(f.calls.some(c => c.session === 'child' && c.method === 'Runtime.runIfWaitingForDebugger'));
  assert.deepEqual(f.failures, []);
  const broken = fixture(); broken.send(async () => { throw Error('unavailable'); });
  await assert.rejects(initializeNativeFocus(broken.wc, broken.fail), /unavailable/);
  assert.equal(broken.wc.debugger.listenerCount('message'), 0);
});
