import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
const require = createRequire(import.meta.url);
const { CreditWindow, parseMediaFeedback } = require('../../packages/remote-interaction/src/protocol.cjs');
const { MediaFlow } = require('../../packages/remote-interaction/src/media-flow.cjs');
const { createDisplayFlow } = require('../../scripts/remote-browser/display.cjs');
const frame = (id, key = false, bytes = 20) => {
  const buffer = Buffer.alloc(bytes); buffer[0] = key ? 1 : 0; buffer.writeBigUInt64BE(BigInt(id), 1); return buffer;
};
function fixture(stage = 'rendered') {
  let now = 0, serial = 0, keys = 0, closed = 0;
  const configurations = [], rates = [];
  const flow = new MediaFlow({ stage, epoch: () => 'media-generation-0000-' + ++serial,
    configure: config => configurations.push(config), keyframe: () => keys++,
    close: () => closed++, pace: fps => rates.push(fps), now: () => now });
  const feedback = (data = {}) => flow.feedback({ version: 1, epoch: flow.epoch, received: null, rendered: null, ...data });
  return { flow, configurations, rates, feedback, setNow(value) { now = value; },
    get keys() { return keys; }, get closed() { return closed; } };
}

test('unknown settlement cannot return capacity; exact input replies may arrive out of order', () => {
  const credits = new CreditWindow({ maxItems: 2, maxBytes: 3 });
  assert(credits.reserve('a', 1)); assert(credits.reserve('b', 2));
  const outcomes = new Map([['a', 'unknown']]);
  assert.equal(outcomes.get('a'), 'unknown');
  assert.equal(credits.reserve('c', 1), false, 'a timed-out request is still capacity debt');
  assert.equal(credits.release('future'), false);
  assert(credits.release('b')); assert(credits.reserve('c', 1));
  assert.equal(credits.size, 2); assert.equal(credits.bytes, 2);
});

test('rendered profile cannot turn receipt or a future ID into presentation credit', () => {
  const f = fixture(); assert(f.feedback({ ready: true }));
  assert(f.flow.admit(frame(1, true)));
  for (let i = 2; i <= 6; i++) assert(f.flow.admit(frame(i)));
  assert.equal(f.flow.admit(frame(7)), false);
  f.feedback({ received: '6', rendered: null });
  assert.equal(f.flow.credits.size, 6);
  f.feedback({ received: '2', rendered: '6' });
  assert.equal(f.flow.credits.size, 6, 'presentation cannot exceed receipt');
  f.feedback({ received: '9999', rendered: '9999' }); assert.equal(f.flow.credits.size, 6);
  f.feedback({ received: '6', rendered: '6' }); assert.equal(f.flow.credits.size, 0);
  assert.equal(f.flow.admit(frame(8)), false, 'a dropped delta requires resynchronization');
  assert(f.flow.admit(frame(9, true)));
});

test('reset requires a new receiver confirmation; stale feedback and duplicate ready do not erase new work', () => {
  const f = fixture(); f.feedback({ ready: true }); f.flow.admit(frame(1, true));
  const old = f.flow.epoch; f.setNow(1600); f.flow.tick();
  assert.notEqual(f.flow.epoch, old); assert.equal(f.flow.credits.size, 1);
  assert.equal(f.flow.admit(frame(2, true)), false);
  assert.equal(f.flow.feedback({ version: 1, epoch: old, received: '1', rendered: '1' }), false);
  assert.equal(f.flow.credits.size, 1);
  assert.equal(f.feedback({ ready: true, received: '1' }), false);
  f.feedback({ ready: true }); assert.equal(f.flow.credits.size, 0);
  assert(f.flow.admit(frame(3, true)));
  f.feedback({ ready: true }); assert.equal(f.flow.credits.size, 1, 'ready is not an arbitrary credit refund');
});

test('static screens do not reset; stalled handshake closes, and another receiver remains independent', () => {
  const slow = fixture(), healthy = fixture('received');
  slow.feedback({ ready: true }); healthy.feedback({ ready: true });
  healthy.setNow(50000); healthy.flow.tick(); assert.equal(healthy.configurations.length, 1);
  slow.flow.admit(frame(1, true)); slow.setNow(1600); slow.flow.tick();
  slow.setNow(11600); slow.flow.tick(); assert.equal(slow.closed, 1);
  assert(healthy.flow.admit(frame(2, true)));
  healthy.feedback({ received: '2' }); assert.equal(healthy.flow.credits.size, 0);
});

test('keyframe burst is bounded separately from normal bytes and oversize frames close', () => {
  const f = fixture(); f.feedback({ ready: true });
  assert(f.flow.admit(frame(1, true, 3 * 1024 * 1024)));
  assert.equal(f.flow.admit(frame(2)), false);
  assert.equal(f.flow.credits.size, 1);
  assert.equal(f.flow.admit(frame(3, true, 4 * 1024 * 1024 + 1)), false);
  assert.equal(f.closed, 1);
});

test('repeated reset confirmations without frame progress reach a terminal close', () => {
  const f = fixture(); f.feedback({ ready: true });
  for (let i = 1; i <= 4; i++) {
    f.flow.admit(frame(i, true)); f.setNow(i * 2000); f.flow.tick();
    if (i < 4) { assert.equal(f.closed, 0); f.feedback({ ready: true }); }
  }
  assert.equal(f.closed, 1); assert.equal(f.flow.admit(frame(5, true)), false);
});

test('feedback rejects malformed numbers, missing watermarks and configuration fields', () => {
  const base = { version: 1, epoch: 'media-generation-valid-00001', received: null, rendered: null };
  assert(parseMediaFeedback(base));
  for (const change of [{ received: 12 }, { rendered: '-1' }, { fps: NaN }, { fps: 31 }, { fps: 5.5 }, { epoch: 'x' }])
    assert.equal(parseMediaFeedback({ ...base, ...change }), null);
  assert.equal(parseMediaFeedback({ version: 1, epoch: base.epoch }), null);
});

test('real WebSocket gate passes control, holds old capacity through reset and resumes on a keyframe', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  const joining = once(server, 'connection');
  const client = new WebSocket('ws://127.0.0.1:' + server.address().port);
  await once(client, 'open'); const [socket] = await joining;
  let now = 0, keys = 0;
  const flow = createDisplayFlow({ keyframe: () => keys++, diagnose() {}, now: () => now });
  const viewer = { visible: true }, page = {};
  const receive = async () => { const [value, binary] = await once(client, 'message'); return binary ? value : JSON.parse(value.toString()); };
  const feedback = data => flow.feedback(socket, { version: 1, epoch: config.epoch, received: null, rendered: null, ...data });
  let config;
  try {
    let next = receive(); flow.attach(page, socket, viewer, 'rendered'); config = await next;
    assert.equal(config.type, 'media-config'); assert(feedback({ ready: true }));
    for (let i = 1; i <= 6; i++) { next = receive(); flow.send(page, socket, viewer, frame(i, i === 1)); await next; }
    flow.send(page, socket, viewer, frame(7));
    next = receive(); flow.send(page, socket, viewer, null, { type: 'control' });
    assert.equal((await next).type, 'control', 'media gate does not gate the control plane');
    now = 2000; next = receive(); feedback({ requestReset: true }); const old = config; config = await next;
    assert.notEqual(config.epoch, old.epoch);
    assert.equal(flow.feedback(socket, { version: 1, epoch: old.epoch, received: '6', rendered: '6' }), false);
    assert(feedback({ ready: true }));
    next = receive(); flow.send(page, socket, viewer, frame(8, true)); assert.equal((await next).readBigUInt64BE(1), 8n);
    assert(keys >= 2);
  } finally { flow.close(); client.terminate(); socket.terminate(); await new Promise(resolve => server.close(resolve)); }
});
