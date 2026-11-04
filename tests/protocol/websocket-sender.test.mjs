import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { createWebSocketSender } from '../../packages/relay-protocol/src/websocket-sender.mjs';
const turn = () => new Promise(r => setImmediate(r));

test('fragmented UTF8 remains one text message; native Pong grants bounded credit', { timeout: 5000 }, async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const accepted = once(server, 'connection');
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`, { autoPong: false });
  await once(client, 'open'); const [peer] = await accepted;
  t.after(() => { client.terminate(); peer.terminate(); server.close(); });
  const messages = [], pings = []; client.on('message', (data, binary) => messages.push({ text: String(data), binary }));
  client.on('ping', data => pings.push(data));
  const send = createWebSocketSender(peer, { fragmentBytes: 5, windowBytes: 15 });
  const text = '中文🙂'.repeat(12); let completed = 0;
  send(text, error => { assert.ifError(error); completed++; });
  send('next', error => { assert.ifError(error); completed++; });
  for (let i = 0; pings.length === 0 && i < 100; i++) await new Promise(r => setTimeout(r, 2));
  assert.equal(pings.length, 1); assert.deepEqual(messages, []); assert.equal(completed, 0);
  client.pong('unrelated'); await turn(); assert.equal(completed, 0);
  let acknowledged = 0;
  while (completed < 2) {
    if (pings[acknowledged]) client.pong(pings[acknowledged++]);
    await new Promise(r => setTimeout(r, 2));
    assert.ok(acknowledged < 100);
  }
  for (let i = 0; messages.length < 2 && i < 100; i++) await new Promise(r => setTimeout(r, 2));
  assert.deepEqual(messages, [{ text, binary: false }, { text: 'next', binary: false }]);
});

test('missing Pong closes and settles queued callbacks exactly once', async t => {
  const socket = Object.assign(new EventEmitter(), { readyState: 1,
    send(_data, _options, callback) { callback(); }, ping() {},
    terminate() { this.readyState = 3; this.emit('close'); } });
  const outcomes = [];
  const send = createWebSocketSender(socket, { fragmentBytes: 4, windowBytes: 4, acknowledgementTimeoutMs: 15 });
  send('123456789', error => outcomes.push(error)); send('next', error => outcomes.push(error));
  await new Promise(r => setTimeout(r, 40));
  assert.equal(socket.readyState, 3); assert.equal(outcomes.length, 2); assert.ok(outcomes.every(x => x instanceof Error));
  assert.equal(socket.listenerCount('pong'), 0);
});

test('queue overflow is bounded and does not silently drop an RPC', () => {
  const socket = Object.assign(new EventEmitter(), { readyState: 1, terminate() { this.readyState = 3; this.emit('close'); } });
  const send = createWebSocketSender(socket, { maximumBytes: 4 }); const errors = [];
  send('1234', error => errors.push(error)); assert.equal(send('x', error => errors.push(error)), false);
  assert.equal(socket.readyState, 3); assert.equal(errors.length, 2); assert.ok(errors.every(Boolean));
});

test('close settles the in-flight message; late send completion cannot restart pumping', async () => {
  let completion, sends = 0;
  const socket = Object.assign(new EventEmitter(), { readyState: 1,
    send(_data, _options, callback) { sends++; completion = callback; },
    terminate() { this.readyState = 3; this.emit('close'); } });
  const results = []; const send = createWebSocketSender(socket, { fragmentBytes: 4 });
  send('123456789', error => results.push(error)); await turn();
  socket.terminate(); completion(); await turn();
  assert.equal(sends, 1); assert.equal(results.length, 1); assert.ok(results[0] instanceof Error);
});
