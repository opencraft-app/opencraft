import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createAppServerWorkbenchRuntime } from '@opencraft/workbench-runtime';
import { APP_HOST_PROTOCOL_VERSION } from '@opencraft/app-host-protocol/version';
import { createAppHostAdmission, AppHostAdmissionError } from '../../apps/workbench-web/src/runtime/app-host-admission';
import { connectWebSocketAppHost } from '../../apps/workbench-web/src/runtime/websocket-app-host';
import { selectorFixture } from '../fixtures/server-selector';

for (const status of [204, 401, 403, 404, 500, 200]) test(`HTTP admission: status ${status} is classified without inventing login authority`, async () => {
  const requests: RequestInit[] = [];
  const admission = createAppHostAdmission(async (path, init) => {
    assert.equal(path, '/__opencraft_access/admission'); requests.push(init!);
    return new Response(null, { status });
  });
  try {
    if (status === 401 || status === 403) await assert.rejects(admission.prepare(), error => error instanceof AppHostAdmissionError
      && error.failure.code === (status === 401 ? 'APP_HOST_AUTH_REQUIRED' : 'APP_HOST_ACCESS_DENIED') && error.failure.recovery === 'manual');
    else if (status === 204 || status === 404) await admission.prepare();
    else await assert.rejects(admission.prepare(), error => !(error instanceof AppHostAdmissionError));
    assert.equal(requests[0]!.credentials, 'same-origin'); assert.equal(requests[0]!.redirect, 'error');
    assert.equal(requests[0]!.cache, 'no-store');
  } finally { admission.dispose(); }
});

test('HTTP admission: checks are coalesced only in flight, never cached as a session grant', async () => {
  let resolve!: (value: Response) => void, calls = 0;
  const admission = createAppHostAdmission(() => { calls++; return new Promise(done => { resolve = done; }); });
  try {
    const first = admission.prepare(), second = admission.prepare();
    assert.equal(first, second); assert.equal(calls, 1);
    resolve(new Response(null, { status: 204 })); await first;
    const next = admission.prepare(); assert.equal(calls, 2);
    resolve(new Response(null, { status: 401 })); await assert.rejects(next, AppHostAdmissionError);
  } finally { admission.dispose(); }
});

test('HTTP admission: deadline and shutdown abort the owned read, not a new socket', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal!: AbortSignal;
  const admission = createAppHostAdmission((_path, init) => {
    signal = init!.signal!;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  });
  const expired = assert.rejects(admission.prepare(), error => error instanceof Error && error.name === 'TimeoutError');
  t.mock.timers.tick(5_000); await expired; assert.equal(signal.aborted, true);
  const disposed = assert.rejects(admission.prepare()); admission.dispose(); await disposed;
  await assert.rejects(admission.prepare(), /closed/);
});

/** Actual RelayAuthentication cookie issuance/expiry, Relay HTTP/WS gate and
 * relay-connect tunnel, actual browser Port and Workbench lifecycle. Only the
 * enterprise identity provider and native engine are synthetic. */
test('expired Relay login stops reconnect churn; a fresh login and explicit retry recover the same client', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let nativeInitializations = 0;
  const f = await selectorFixture({ appHost: () => ({
    accept(port: { postMessage(frame: unknown): void; subscribe(fn: (frame: any) => void): () => void }) {
      port.subscribe(frame => {
        if (frame.requestId) port.postMessage({ type: 'response', requestId: frame.requestId, ok: true, result: frame.type === 'host/connect' ? { hostId: frame.hostId, generation: 1 } : null });
        if (frame.type === 'host/send') {
          const rpc = JSON.parse(frame.frame); if (rpc.id === undefined) return;
          const result = rpc.method === 'initialize' ? (nativeInitializations++, { codexHome: '/synthetic', platformFamily: 'unix', platformOs: 'linux', userAgent: 'auth-expiry' }) : rpc.method.endsWith('/list') ? { data: [], nextCursor: null } : null;
          port.postMessage({ type: 'host/frame', hostId: frame.hostId, generation: frame.generation, frame: JSON.stringify({ id: rpc.id, result }) });
        }
      });
      port.postMessage({ type: 'ready', protocolVersion: APP_HOST_PROTOCOL_VERSION, services: ['appserver'] });
      return { close() {} };
    }, close() {},
  }) });
  let cookie = await f.login('alice');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { href: f.base + '/servers/join/local/thread' } } });
  // The real browser's serverFetch would apply the selected-server prefix.
  const admission = createAppHostAdmission(async () => f.get('/servers/join/__opencraft_access/admission', { cookie }));
  const sockets: WebSocket[] = [], hints = new Set<(reason?: string) => void>();
  const factory = connectWebSocketAppHost(url => {
    const scoped = new URL(url); scoped.pathname = '/servers/join' + scoped.pathname;
    const socket = new WebSocket(scoped, { headers: { host: f.host, cookie } }); sockets.push(socket);
    return socket as unknown as globalThis.WebSocket;
  }, { path: '/apphost', beforeConnect: () => admission.prepare(), retryDelaysMs: [500], reportFailure() {},
    recoveryEvents: { isVisible: () => true, subscribe(fn) { hints.add(fn); return () => { hints.delete(fn); }; } },
  });
  const runtime = createAppServerWorkbenchRuntime({ hostId: 'fixture', autoReconnect: true, reconnectDelaysMs: [500],
    createTransport: () => factory.createTransport('fixture'), onRecoveryEvent() {},
    clock: { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>) },
  });
  t.after(async () => {
    const disposed = runtime.dispose(); factory.close(); admission.dispose(); for (const socket of sockets) socket.terminate();
    await disposed;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
    try { await f.close(); } finally { t.mock.timers.reset(); }
  });
  await runtime.connect(); assert.equal(runtime.getSnapshot().phase, 'ready');
  const originalInitializations = nativeInitializations;
  t.mock.timers.setTime(Date.now() + 3_600_001);
  sockets.at(-1)!.terminate();
  await delay(50); t.mock.timers.setTime(Date.now() + 31_000);
  for (let i = 0; i < 400 && runtime.getSnapshot().phase !== 'error'; i++) await delay(10);
  assert.equal(runtime.getSnapshot().phase, 'error');
  assert.equal(runtime.getSnapshot().transport.failure?.code, 'APP_HOST_AUTH_REQUIRED');
  const allocations = sockets.length;
  for (let i = 0; i < 60; i++) { for (const hint of hints) hint('pageshow'); t.mock.timers.setTime(Date.now() + 1_000); await delay(1); }
  assert.equal(sockets.length, allocations, 'foreground hints must not bypass an expired login');
  assert.equal(nativeInitializations, originalInitializations, 'authentication failure cannot reinitialize native execution');
  f.principals.alice!.expiresAt = Date.now() + 3_600_000;
  cookie = await f.login('alice');
  await admission.prepare();
  let retryFailure: unknown;
  const retry = runtime.reconnect().catch(error => { retryFailure = error; });
  for (let i = 0; i < 400 && runtime.getSnapshot().phase !== 'ready'; i++) await delay(10);
  await retry; assert.equal(retryFailure, undefined, JSON.stringify(runtime.getSnapshot())); assert.equal(runtime.getSnapshot().phase, 'ready');
});
