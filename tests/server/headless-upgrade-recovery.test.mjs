import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { createHeadlessBackendProxy } from '../../scripts/web-deployment/headless-backend.mjs';

const upgrade = 'GET /apphost HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n';
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(10); }
  assert.fail('fixture did not reach expected state');
}
async function fixture(t) {
  const backend = createServer();
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const port = backend.address().port;
  await new Promise(resolve => backend.close(resolve));
  const proxy = createHeadlessBackendProxy(`http://127.0.0.1:${port}`);
  const tunnels = new Set(), sockets = new Set();
  let released = 0, upgrades = 0;
  const front = createServer();
  front.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  front.on('upgrade', (req, socket, head) => { upgrades++; proxy.upgrade(req, socket, head, () => released++, tunnels); });
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const socket of backendSockets) socket.destroy();
    for (const server of [front, backend]) await new Promise(resolve => server.close(resolve));
  });
  const backendSockets = new Set();
  backend.on('connection', socket => { backendSockets.add(socket); socket.once('close', () => backendSockets.delete(socket)); });
  return { backend, tunnels, port: front.address().port, url: `ws://127.0.0.1:${front.address().port}/apphost`,
    released: () => released, upgrades: () => upgrades,
    start: () => new Promise(resolve => backend.listen(port, '127.0.0.1', resolve)) };
}

test('one WebSocket attempt waits across refused backend startup, then delivers once with original admission', { timeout: 5000 }, async t => {
  const f = await fixture(t), headers = [], messages = [], errors = [];
  const server = new WebSocketServer({ noServer: true });
  t.after(() => server.close());
  f.backend.on('upgrade', (req, socket, head) => {
    headers.push(req.headers.cookie);
    server.handleUpgrade(req, socket, head, ws => ws.on('message', message => { messages.push(String(message)); ws.send('ack'); }));
  });
  const client = new WebSocket(f.url, { headers: { cookie: 'session=synthetic' } });
  client.on('error', error => errors.push(error.message));
  t.after(() => client.terminate());
  const opened = once(client, 'open');
  await delay(250);
  assert.equal(client.readyState, WebSocket.CONNECTING);
  const readyAt = performance.now(); await f.start(); await opened;
  assert.ok(performance.now() - readyAt < 750, 'no client backoff after backend returns');
  const received = once(client, 'message'); client.send('synthetic input'); await received;
  assert.deepEqual(errors, []); assert.deepEqual(headers, ['session=synthetic']);
  assert.deepEqual(messages, ['synthetic input']); assert.equal(f.upgrades(), 1);
  const closed = once(client, 'close'); client.close(); await closed;
  await until(() => f.released() === 1); assert.equal(f.tunnels.size, 0);
});

test('early upgrade bytes wait for the single connected backend and are never replayed after reset', { timeout: 5000 }, async t => {
  const f = await fixture(t), received = []; let accepted = 0;
  f.backend.on('upgrade', (_req, socket, head) => {
    accepted++; received.push(head.toString()); socket.destroy();
  });
  const client = connect(f.port, '127.0.0.1'); client.on('error', () => {});
  t.after(() => client.destroy());
  const closed = once(client, 'close'); client.write(upgrade + 'early-frame');
  await until(() => f.upgrades() === 1); await delay(150); await f.start(); await closed;
  await delay(200);
  assert.equal(accepted, 1); assert.deepEqual(received, ['early-frame']); assert.equal(f.released(), 1);
});

test('backend authorization denial ends the attempt without retry', async t => {
  const f = await fixture(t); let accepted = 0;
  f.backend.on('upgrade', (_req, socket) => { accepted++; socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  await f.start();
  const client = new WebSocket(f.url); client.on('error', () => {});
  await new Promise(resolve => client.once('close', resolve)); await delay(200);
  assert.equal(accepted, 1); assert.equal(f.released(), 1);
});

test('abandoning a waiting upgrade cancels reconnect and releases its lease once', async t => {
  const f = await fixture(t); let accepted = 0;
  f.backend.on('upgrade', (_req, socket) => { accepted++; socket.destroy(); });
  const client = connect(f.port, '127.0.0.1'); client.on('error', () => {}); client.write(upgrade);
  await until(() => f.upgrades() === 1); client.destroy();
  await until(() => f.released() === 1); await f.start(); await delay(250);
  assert.equal(accepted, 0); assert.equal(f.released(), 1); assert.equal(f.tunnels.size, 0);
});

test('unavailable backend has a five second deadline, then releases all state', { timeout: 8000 }, async t => {
  const f = await fixture(t), started = performance.now();
  const client = connect(f.port, '127.0.0.1'); client.on('error', () => {});
  t.after(() => client.destroy());
  const closed = once(client, 'close'); client.write(upgrade); await closed;
  assert.ok(performance.now() - started >= 4800);
  assert.ok(performance.now() - started < 6500);
  await until(() => f.released() === 1); assert.equal(f.tunnels.size, 0);
});

test('pending upgrades are bounded and each rejected or cancelled lease releases once', { timeout: 5000 }, async t => {
  const f = await fixture(t), clients = [];
  t.after(() => { for (const client of clients) client.destroy(); });
  for (let i = 0; i < 129; i++) {
    const client = connect(f.port, '127.0.0.1'); client.on('error', () => {}); client.write(upgrade); clients.push(client);
  }
  await until(() => f.upgrades() === 129 && f.released() >= 1);
  assert.equal(f.tunnels.size, 128);
  for (const client of clients) client.destroy();
  await until(() => f.released() === 129); assert.equal(f.tunnels.size, 0);
});
