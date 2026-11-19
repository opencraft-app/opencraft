import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { AssertionSigner } from '../packages/identity-core/src/node';
import { createRelayServer } from '../apps/relay-server/src/server';
import { connectRelay } from '../plugins/relay-connect/src/server';
import { CONTROL_PATH, RELAY_PROTOCOL, MAX_RELAY_STREAMS } from '../packages/relay-protocol/src';
async function waitFor(check: () => boolean) {
  const until = Date.now() + 8000;
  while (!check()) { if (Date.now() > until) throw Error('Relay capacity fixture timed out'); await new Promise(r => setTimeout(r, 5)); }
}
function routes(count: number) {
  const key = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  return Array.from({ length: count }, (_, i) => {
    const scope = { issuer: 'fixture', instanceId: `fixture-${i}`, origin: `http://fixture-${i}.test` };
    return { ...scope, credential: randomBytes(32).toString('base64url'), signer: new AssertionSigner(scope, key),
      identityProvider: { authenticate: () => ({ provider: 'fixture', subject: 'fixture', displayName: 'Fixture', expiresAt: Date.now() + 60000 }) } };
  });
}
async function listen(server: ReturnType<typeof createServer>) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
}
test('owner counts active HTTP streams and releases them without losing short peaks', async t => {
  const target = createServer((_req, res) => { res.writeHead(200); res.write('holding'); });
  const targetBase = await listen(target), route = routes(1)[0]!;
  const relay = createRelayServer([route]), base = await listen(relay.server);
  const client = connectRelay({ relay: base, credential: route.credential, targetPort: Number(new URL(targetBase).port), allowLoopbackInsecure: true });
  const requests: ReturnType<typeof request>[] = [];
  t.after(async () => { requests.forEach(r => r.destroy()); client.close(); await relay.close(); target.closeAllConnections(); await new Promise<void>(r => target.close(() => r())); });
  await waitFor(() => relay.connected(route.instanceId));
  assert.equal(relay.capacity().relayControlConnections, 1);
  const req = request(base + '/api/hold', { headers: { host: new URL(route.origin).host } }); requests.push(req);
  req.on('error', () => {}); req.end(); await once(req, 'response');
  await waitFor(() => relay.capacity().relayActiveStreams === 1);
  assert.equal(relay.capacity().relayPendingStreams, 0);
  req.destroy(); await waitFor(() => relay.capacity().relayActiveStreams === 0);
  assert.equal(relay.capacity().relayPeakSlots, 1); assert.equal(relay.capacity().relayPeakInstanceSlots, 1);
  assert.equal(relay.capacity().relayRejectedInstance, 0); assert.equal(relay.capacity().relayOpenTimeouts, 0);
});
test('pending reservations enforce instance/global limits and release on cancellation', async t => {
  const all = routes(9), relay = createRelayServer(all), base = await listen(relay.server);
  const controls: WebSocket[] = [], requests: ReturnType<typeof request>[] = [];
  t.after(async () => { requests.forEach(r => r.destroy()); controls.forEach(c => c.terminate()); await relay.close(); });
  const start = (index: number) => {
    const req = request(base + '/api/hold', { agent: false, headers: { host: new URL(all[index]!.origin).host } });
    requests.push(req); req.on('error', () => {}); req.end(); return req;
  };
  const [offline] = await once(start(0), 'response'); offline.resume();
  assert.equal(offline.statusCode, 503); assert.equal(relay.capacity().relayRejectedInstance, 0);
  for (const route of all) {
    const c = new WebSocket(base.replace('http:', 'ws:') + CONTROL_PATH, RELAY_PROTOCOL, { headers: { authorization: `Bearer ${route.credential}` } });
    controls.push(c); await once(c, 'open');
  }
  for (let i = 0; i < 8; i++) {
    for (let n = 0; n < MAX_RELAY_STREAMS; n++) start(i);
    await waitFor(() => relay.capacity().relayPendingStreams === (i + 1) * MAX_RELAY_STREAMS);
    if (i === 0) {
      const [response] = await once(start(0), 'response'); response.resume();
      assert.equal(response.statusCode, 503); assert.equal(relay.capacity().relayRejectedInstance, 1);
    }
  }
  const [response] = await once(start(8), 'response'); response.resume(); assert.equal(response.statusCode, 503);
  const full = relay.capacity();
  assert.equal(full.relayRejectedGlobal, 1); assert.equal(full.relayPendingStreams, 4096);
  assert.equal(full.relayActiveStreams, 0); assert.equal(full.relayMaxInstanceSlots, MAX_RELAY_STREAMS);
  assert.equal(full.relayPeakSlots, 4096); assert.equal(full.relayControlConnections, 9);
  assert(controls.every(c => c.readyState === WebSocket.OPEN));
  requests.forEach(r => r.destroy()); await waitFor(() => relay.capacity().relayPendingStreams === 0);
  assert.equal(relay.capacity().relayOpenTimeouts, 0, 'cancellation is not a timeout');
  assert.equal(relay.capacity().relayPeakSlots, 4096);
  controls.forEach(c => c.terminate()); await waitFor(() => relay.capacity().relayControlConnections === 0);
});

test('expired data-open reservation increments timeout, frees its slot, and keeps control', async t => {
  const route = routes(1)[0]!, relay = createRelayServer([route]), base = await listen(relay.server);
  const control = new WebSocket(base.replace('http:', 'ws:') + CONTROL_PATH, RELAY_PROTOCOL, { headers: { authorization: `Bearer ${route.credential}` } });
  await once(control, 'open');
  const req = request(base + '/api/hold', { headers: { host: new URL(route.origin).host } });
  t.after(async () => { req.destroy(); control.terminate(); await relay.close(); });
  req.on('error', () => {}); req.end();
  await waitFor(() => relay.capacity().relayPendingStreams === 1);
  const [response] = await once(req, 'response'); response.resume();
  assert.equal(response.statusCode, 503);
  assert.equal(relay.capacity().relayPendingStreams, 0); assert.equal(relay.capacity().relayOpenTimeouts, 1);
  assert.equal(relay.capacity().relayRejectedInstance, 0); assert.equal(control.readyState, WebSocket.OPEN);
});
