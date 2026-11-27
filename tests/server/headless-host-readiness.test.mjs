import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { initializeHeadlessCodexHost, maintainHeadlessCodexHost, maintainIndependentEngineHost } from '../../apps/headless-server/src/headless-host-readiness.mjs';
import { AppHostServer } from '@opencraft/app-host-server';
import { createRoutedConversationExecution } from '@opencraft/access-control/conversation-execution';
import { MemoryTransport } from '@opencraft/appserver-transport-memory';

function hostFixture() {
  let available = false, opens = 0, closes = 0, state = 'failed';
  const host = {
    hostState: () => state,
    accept(port) {
      opens++; let receive, closed = false;
      port.subscribe(frame => {
        if (frame.type === 'hello') queueMicrotask(() => port.postMessage({ type: 'ready' }));
        if (frame.type === 'host/connect') queueMicrotask(() => {
          state = available ? 'open' : 'failed';
          port.postMessage({ type: 'response', requestId: 'connect', ok: available, result: { generation: 1 } });
        });
        if (frame.type === 'host/send') queueMicrotask(() => port.postMessage({ type: 'host/frame', hostId: 'local-codex', generation: 1, frame: JSON.stringify({ id: 'init', result: {} }) }));
      });
      return { close() { if (!closed) { closes++; closed = true; } } };
    },
  };
  return { host, enable(value) { available = value; if (!value) state = 'failed'; }, counts: () => ({ opens, closes }) };
}

test('Host readiness backs off, recovers, monitors connection loss and retires on close', { timeout: 3000 }, async () => {
  const f = hostFixture(), reports = [];
  const worker = maintainHeadlessCodexHost(f.host, { retryMs: 30, maxRetryMs: 120, pollMs: 10, report: value => reports.push(value) });
  try {
    for (let n = 0; n < 100 && worker.snapshot().attempt < 3; n++) await delay(5);
    assert.equal(worker.snapshot().state, 'unavailable');
    assert.equal(reports.length, 1, 'same failure does not log every retry');
    assert.ok(f.counts().opens <= 4, 'failed dependency is not retried in a tight loop');
    f.enable(true);
    for (let n = 0; n < 100 && worker.snapshot().state !== 'ready'; n++) await delay(5);
    assert.equal(worker.snapshot().state, 'ready');
    assert.deepEqual(f.counts(), { opens: f.counts().opens, closes: f.counts().opens });
    f.enable(false);
    for (let n = 0; n < 100 && worker.snapshot().state === 'ready'; n++) await delay(5);
    assert.equal(worker.snapshot().state, 'unavailable');
  } finally { worker.close(); }
  const count = f.counts().opens; await delay(150); assert.equal(f.counts().opens, count);
});

test('readiness cancellation and timeout release transient clients without admitting late replies', async () => {
  let closes = 0;
  const host = { accept() { return { close() { closes++; } }; } };
  const abort = new AbortController();
  const pending = initializeHeadlessCodexHost(host, { signal: abort.signal });
  abort.abort(); await assert.rejects(pending); assert.equal(closes, 1);
  await assert.rejects(initializeHeadlessCodexHost(host, { timeoutMs: 10 }), /timed out/);
  assert.equal(closes, 2);
  await assert.rejects(initializeHeadlessCodexHost(host, { signal: abort.signal }));
  assert.equal(closes, 2, 'already cancelled attempt must not acquire a client');
});

test('an independent Host makes DSH and Pi ready without a CLI catalog read', async t => {
  const connections = [];
  const appHost = new AppHostServer({
    physicalHostLifetime: 'server',
    createTransport(hostId) {
      connections.push(hostId);
      return new MemoryTransport({ server: { receive() {} } });
    },
  });
  t.after(() => appHost.close());
  const execution = createRoutedConversationExecution(() => appHost, { machineId: 'fixture', engines: ['dsh', 'pi'] });
  const states = () => Object.fromEntries(execution.directory().servers.map(({ engine, connectionState }) => [engine, connectionState]));
  assert.deepEqual(states(), { codex: 'unknown', dsh: 'unknown', pi: 'unknown' });
  const ready = Promise.withResolvers();
  const worker = maintainIndependentEngineHost(appHost, { report: status => {
    if (status.state === 'ready') ready.resolve();
  } });
  t.after(() => worker.close());
  await ready.promise;
  assert.deepEqual(states(), { codex: 'unknown', dsh: 'ready', pi: 'ready' });
  assert.deepEqual(connections, ['opencraft-server']);
});
