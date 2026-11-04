import assert from 'node:assert/strict';
import test from 'node:test';
import { rpcWorkClass, rpcLatencySummary, backgroundRefreshLog } from '../../packages/observability-query/index.mjs';
const foreground = { kind: 'rpc', component: 'gateway', measurementScope: 'rpc', traceRole: 'gateway-rpc', caller: 'thread-catalog', method: 'thread/list', outcome: 'ok', durationMs: 3.567 };
const background = { ...foreground, kind: 'dependency', traceRole: 'background-refresh', caller: 'server-refresh', durationMs: 8939.435,
  refreshReason: 'cached-head', traceId: '1'.repeat(32), spanId: '2'.repeat(16), linkedTraceId: '3'.repeat(32), linkedSpanId: '4'.repeat(16), directoryPages: 9 };
test('the observed 8.94s refresh stays separate from its 3.57ms foreground and child layers', () => {
  const native = { ...background, traceRole: 'native-rpc', stage: 'history', durationMs: 1748.261 };
  const storage = { ...background, traceRole: 'storage-work', stage: 'storage', durationMs: 19.596 };
  const summary = rpcLatencySummary([foreground, background, native, storage]);
  assert.equal(summary.length, 4);
  assert.equal(summary.find(x => x.workClass === 'foreground').maxMs, 3.567);
  assert.equal(summary.find(x => x.traceRole === 'background-refresh').maxMs, 8939.435);
  assert.equal(summary.find(x => x.stage === 'history').workClass, 'background');
  assert.equal(summary.find(x => x.stage === 'storage').workClass, 'background');
  assert.equal(rpcWorkClass({ kind: 'dependency', component: 'gateway' }), 'unknown');
  assert.equal(rpcWorkClass({ ...background, component: 'web', kind: 'rpc' }), 'foreground');
});
test('only slow or unsuccessful background completions log, with causal links and no payload', () => {
  const log = backgroundRefreshLog({ ...background, params: 'private', error: 'private', cursor: 'private', hostId: 'private' });
  assert.equal(log.workClass, 'background'); assert.equal(log.linkedTraceId, background.linkedTraceId);
  assert.equal(log.traceId, background.traceId); assert(!JSON.stringify(log).includes('private'));
  assert.equal(backgroundRefreshLog(foreground), null);
  assert.equal(backgroundRefreshLog({ ...background, traceRole: 'native-rpc' }), null);
  assert.equal(backgroundRefreshLog({ ...background, durationMs: 1 }), null);
  assert.equal(backgroundRefreshLog({ ...background, durationMs: 1, outcome: 'failed' }).outcome, 'failed');
  assert.equal(backgroundRefreshLog({ ...background, durationMs: NaN }), null);
  const safe = backgroundRefreshLog({ ...background, method: 'private', refreshReason: 'private', traceId: 'private' });
  assert(!JSON.stringify(safe).includes('private'));
});

test('ingress wires the label once and logging failure does not reject telemetry', async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { createObservabilityIngress } = await import('../../scripts/observability-ingress.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'refresh-log-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'ingress.json');
  await writeFile(config, JSON.stringify({ socketPath: join(directory, 'observe.sock'), grafanaSocket: join(directory, 'grafana.sock'), pseudonymKey: '1'.repeat(64) }), { mode: 0o600 });
  const ingress = await createObservabilityIngress(config); t.after(() => ingress.close());
  const logs = []; const spy = t.mock.method(console, 'info', (...args) => logs.push(args));
  assert.equal(ingress.readTiming(background), true);
  assert.equal(ingress.readTiming({ ...background, traceRole: 'native-rpc' }), true);
  assert.equal(ingress.readTiming(foreground), true);
  assert.equal(logs.length, 1); assert.equal(logs[0][0], '[opencraft background-refresh]');
  assert.equal(JSON.parse(logs[0][1]).workClass, 'background');
  spy.mock.mockImplementation(() => { throw new Error('log unavailable'); });
  assert.equal(ingress.readTiming(background), true, 'original telemetry admission survives logger failure');
});

test('optional native work metadata and causal links survive event sanitization', async () => {
  const { sanitizeEvent } = await import('../../packages/observability-contract/index.mjs');
  const input = { ...background, schemaVersion: 1, producerId: 'fixture', eventId: 'fixture', at: 100 };
  const saved = sanitizeEvent(input, 100);
  assert.equal(rpcWorkClass(saved), 'background');
  assert.equal(saved.linkedTraceId, input.linkedTraceId);
  assert.equal(saved.directoryPages, 9);
  for (const stage of ['history', 'storage']) assert.equal(rpcWorkClass(sanitizeEvent({ ...input, stage, traceRole: stage === 'history' ? 'native-rpc' : 'storage-work' }, 100)), 'background');
  for (const change of [{ caller: 'private' }, { traceId: 'invalid' }, { linkedSpanId: undefined }, { gatewayPairId: 'invalid' }])
    assert.equal(sanitizeEvent({ ...input, ...change }, 100), null);
});
