import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import WebSocket, { WebSocketServer } from 'ws';
const { createDisplayFlow } = createRequire(import.meta.url)('../../scripts/remote-browser/display.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a short real WS backlog keeps the viewer and resumes only on a new keyframe', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  const joining = once(server, 'connection'), client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  const received = []; client.on('message', (data, binary) => received.push(binary ? data[1] : JSON.parse(data).type));
  await once(client, 'open'); const [socket] = await joining;
  let keys = 0; const diagnostics = [], flow = createDisplayFlow({ keyframe: () => keys++, diagnose: event => diagnostics.push(event) });
  const viewer = { visible: true }, page = {};
  const frame = (key, id) => { const bytes = Buffer.alloc(64 * 1024); bytes[0] = key ? 1 : 0; bytes[1] = id; return bytes; };
  try {
    socket._socket.cork();
    flow.send(page, socket, viewer, frame(true, 1)); flow.send(page, socket, viewer, frame(false, 2));
    assert(socket.bufferedAmount > 128 * 1024);
    flow.send(page, socket, viewer, frame(false, 3));
    flow.send(page, socket, viewer, null, { type: 'control' });
    assert.equal(socket.readyState, WebSocket.OPEN);
    socket._socket.uncork(); await wait(150);
    assert(keys >= 1); flow.send(page, socket, viewer, frame(false, 4));
    flow.send(page, socket, viewer, frame(true, 5)); flow.send(page, socket, viewer, frame(false, 6));
    await wait(30);
    assert.deepEqual(received, [1, 2, 'control', 5, 6]);
    assert.deepEqual(diagnostics, ['display_paused', 'display_resumed']); assert.equal(client.readyState, WebSocket.OPEN);
  } finally { flow.close(); client.terminate(); socket.terminate(); await new Promise(resolve => server.close(resolve)); }
});

test('a stalled viewer is bounded without affecting a healthy viewer or retaining timers on detach', () => {
  let time = 0; const seen = [], diagnostics = [];
  const flow = createDisplayFlow({ now: () => time, keyframe() {}, diagnose: e => diagnostics.push(e) });
  const slow = { bufferedAmount: 200000, readyState: 1, send() { throw Error('delta must be skipped'); }, close(code) { seen.push(code); }, once() {}, terminate() {} };
  const fast = { bufferedAmount: 0, readyState: 1, send(packet) { seen.push(packet[1]); } };
  const viewer = { visible: true }, page = {};
  flow.send(page, slow, viewer, Buffer.from([0, 1]));
  flow.send(page, fast, viewer, Buffer.from([0, 2]));
  time = 11000; slow.bufferedAmount = 5 * 1024 * 1024;
  flow.send(page, slow, viewer, Buffer.from([1, 3]));
  assert.deepEqual(seen, [2, 1013]); assert(diagnostics.includes('display_stalled')); flow.detach(slow); flow.close();
});
