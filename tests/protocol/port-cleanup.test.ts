import assert from 'node:assert/strict';
import test from 'node:test';
import { MessagePortAppHostClient } from '../../packages/app-host-client/src/index';
import { AppHostServer } from '../../packages/app-host-server/src/index';
import { APP_HOST_PROTOCOL_VERSION } from '../../packages/app-host-protocol/src/index';
import { FaultPort, errorContains, flushPorts, simulatePortCleanup, type PortFault } from './fixtures/port-cleanup-chaos';

for (const side of ['client', 'connection', 'server'] as const)
  for (const fault of ['none', 'remove', 'close', 'both'] as PortFault[])
    for (const peer of [false, true])
      for (const lifetime of ['last-claim', 'server'] as const)
        test(`${side}/${fault}/peer=${peer}/${lifetime}: local retirement, independent cleanup and exact-handle retry`, async () => {
          await simulatePortCleanup([
            { type: 'setup', side, ready: false, peer, lifetime }, { type: 'reenter', enabled: true },
            { type: 'fault', value: fault }, { type: 'stop' }, { type: 'late' }, { type: 'stop' },
            { type: 'fault', value: 'none' }, { type: 'stop' }, { type: 'late' }, { type: 'stop' },
          ]);
        });
for (const side of ['client', 'connection', 'server'] as const) test(`${side}: already-ready lifetime remains retired after late messages`, async () => {
  await simulatePortCleanup([{ type: 'setup', side, ready: true, peer: true, lifetime: 'last-claim' }, { type: 'fault', value: 'both' }, { type: 'stop' }, { type: 'late' }, { type: 'fault', value: 'none' }, { type: 'stop' }]);
});
for (const side of ['client', 'server'] as const) for (const stage of ['start', 'hello'] as const) {
  if (side === 'server' && stage === 'hello') continue;
  test(`${side}: failed ${stage} rolls back setup and preserves the original error`, async () => {
    const port = new FaultPort(), primary = Error('synthetic setup failure');
    if (stage === 'start') port.startError = primary; else port.helloError = primary;
    const server = side === 'server' ? new AppHostServer({ createTransport() { throw Error('must not construct native'); } }) : undefined;
    assert.throws(() => server ? server.accept(port, 'page') : new MessagePortAppHostClient(port, 'page'), error => error === primary);
    assert.equal(port.removes, 1); assert.equal(port.closes, 1);
    assert.equal(port.listeners.size + port.domListeners.size, 0);
    await server?.close();
  });
}
for (const side of ['client', 'server'] as const) test(`${side}: constructor cleanup failure retains primary and both disposal errors`, async () => {
  const port = new FaultPort(), primary = Error('synthetic start failure'); port.startError = primary; port.fault = 'both';
  const server = side === 'server' ? new AppHostServer({ createTransport() { throw Error('must not create native'); } }) : undefined;
  assert.throws(() => server ? server.accept(port, 'page') : new MessagePortAppHostClient(port, 'page'), error =>
    error instanceof AggregateError && error.cause === primary && [primary, port.removeError, port.closeError].every(x => errorContains(error, x)));
  assert.equal(port.removes, 1); assert.equal(port.closes, 1);
  port.fault = 'none';
  if (server) { await server.close(); assert.equal(port.removes, 2); assert.equal(port.closes, 2); }
  else { port.close(); port.domListeners.clear(); }
});
test('global shutdown continues across two failing Ports and a healthy Port before reporting failure', async () => {
  const server = new AppHostServer({ createTransport() { throw Error('not requested'); } });
  const a = new FaultPort(), b = new FaultPort(), c = new FaultPort();
  a.fault = 'remove'; b.fault = 'close'; server.accept(a, 'a'); server.accept(b, 'b'); server.accept(c, 'c');
  const operation = server.close(); assert.equal(server.close(), operation);
  await assert.rejects(operation, error => errorContains(error, a.removeError) && errorContains(error, b.closeError));
  assert.equal(a.closes, 1); assert.equal(b.removes, 1); assert.equal(c.closes, 1);
  a.fault = b.fault = 'none'; await server.close();
  assert.deepEqual([a.removes, a.closes, b.removes, b.closes, c.removes, c.closes], [2, 1, 1, 2, 1, 1]);
  await flushPorts();
});
for (const fail of [true, false]) test(`server startup messages are admitted after registration and successful start: fail=${fail}`, async () => {
  let factories = 0; const primary = Error('synthetic start transaction failure');
  const server = new AppHostServer({ createTransport() { factories++; throw Error('native fixture deliberately unavailable'); } });
  class StartupPort extends FaultPort {
    start() {
      this.emit({ type: 'hello', rendererId: 'page', protocolVersion: APP_HOST_PROTOCOL_VERSION });
      this.emit({ type: 'host/connect', hostId: 'host', leaseId: 'early', requestId: 'early' });
      if (fail) throw primary;
    }
  }
  const port = new StartupPort();
  if (fail) assert.throws(() => server.accept(port, 'page'), e => e === primary);
  else server.accept(port, 'page');
  await flushPorts();
  assert.equal(factories, fail ? 0 : 1);
  await server.close();
});
for (const boundary of ['subscribe', 'start'] as const) test(`client synchronous ${boundary} fatal cannot continue startup`, async () => {
  class StartupPort extends FaultPort {
    fatal() { this.emit({ type: 'fatal', error: { code: 'APP_HOST_FAILURE', message: 'synthetic fatal', retryable: false } }); }
    addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void) { super.addEventListener(type, listener); if (boundary === 'subscribe') this.fatal(); }
    start() { if (boundary === 'start') this.fatal(); }
  }
  const port = new StartupPort(), client = new MessagePortAppHostClient(port, 'page');
  await assert.rejects(client.waitUntilReady(), /synthetic fatal/);
  assert.equal(port.sent.length, 0); assert.equal(port.closes, 1); client.close(); assert.equal(port.closes, 1);
});
test('global shutdown preserves both Port and physical failures and retries their original handles', async () => {
  const port = new FaultPort(), nativeError = Error('synthetic native close failure'); let nativeCloses = 0, factories = 0, fail = true;
  const physical = { status: { state: 'open' as const }, async connect() {}, async send(_frame: string) {},
    async close() { nativeCloses++; if (fail) throw nativeError; }, subscribeMessage(_l: (value: string) => void) { return () => {}; },
    subscribeStatus(_l: (value: any) => void) { return () => {}; } };
  const server = new AppHostServer({ createTransport() { factories++; return physical; } });
  server.accept(port, 'page'); port.emit({ type: 'hello', rendererId: 'page', protocolVersion: APP_HOST_PROTOCOL_VERSION });
  port.emit({ type: 'host/connect', hostId: 'host', leaseId: 'lease', requestId: 'open' }); await flushPorts();
  assert.ok(port.sent.some((m: any) => m.type === 'response' && m.ok));
  port.fault = 'close';
  await assert.rejects(server.close(), e => errorContains(e, nativeError) && errorContains(e, port.closeError));
  assert.equal(nativeCloses, 1); assert.equal(port.closes, 1);
  fail = false; port.fault = 'none'; await server.close();
  assert.equal(nativeCloses, 2); assert.equal(port.closes, 2); assert.equal(port.removes, 1); assert.equal(factories, 1);
});
