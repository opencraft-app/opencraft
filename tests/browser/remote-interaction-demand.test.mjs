import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { MediaFlow } = require('../../packages/remote-interaction/src/media-flow.cjs');
const { AdaptiveInputWindow, EncodingBuckets, bucketBounds } = require('../../packages/remote-interaction/src/policy.cjs');
const packet = (id, key) => { const p = Buffer.alloc(100); p[0] = key ? 1 : 0; p.writeBigUInt64BE(BigInt(id), 1); return p; };
test('200ms feedback path sustains continuous media without a periodic keyframe freeze', () => {
  let now = 0, key = true, sent = 0, offered = 0, due = [], resets = 0;
  const f = new MediaFlow({ stage: 'rendered', now: () => now, epoch: () => 'generation-valid-00000-' + ++resets,
    configure() {}, keyframe() { key = true; }, close() { assert.fail('unexpected close'); } });
  const ack = fields => f.feedback({ version: 1, epoch: f.epoch, received: null, rendered: null, ...fields });
  ack({ ready: true });
  for (; now < 5000; now++) {
    for (const d of due.filter(d => d.at <= now)) ack({ received: d.id, rendered: d.id });
    due = due.filter(d => d.at > now);
    if (now >= offered * 1000 / 30) {
      const id = String(++offered), p = packet(offered, key); key = false;
      if (f.admit(p)) { sent++; due.push({ id, at: Math.ceil((now + 100) / 50) * 50 + 100 }); }
    }
    if (now % 250 === 0) f.tick();
    assert(f.credits.size <= 12); assert(f.credits.bytes <= 2 * 1024 * 1024);
  }
  assert.equal(offered, 150); assert.equal(sent, 150); assert.equal(resets, 1);
  assert(f.snapshot().feedbackDelayMs >= 200);
});
test('input adaptation is bounded and reset discards prior connection samples', () => {
  const w = new AdaptiveInputWindow(); assert.equal(w.limit, 2);
  w.observe(100); assert.equal(w.limit, 8); w.observe(20000); assert.equal(w.limit, 12);
  w.observe(NaN); assert.equal(w.limit, 12); w.reset(); assert.equal(w.limit, 2); assert.equal(w.samples, 0);
});
test('exactly two buckets adapt down promptly, recover only after stable progress, and stay idle without demand', () => {
  assert.throws(() => bucketBounds({ fast: { fps: 30, bitrate: 2500000 } }));
  assert.throws(() => bucketBounds({ fast: { fps: 15, bitrate: 300000 }, slow: { fps: 30, bitrate: 400000 } }));
  const b = new EncodingBuckets();
  const fast = { bucket: 'fast', fps: 30, allowed: true, pressure: false, progress: true };
  const slow = { bucket: 'slow', fps: 12, allowed: true, pressure: true, progress: true };
  let p = b.plan([fast, slow], 0); assert.deepEqual(Object.keys(p), ['fast', 'slow']);
  assert.equal(p.fast.bitrate, 2500000); assert.equal(p.slow.bitrate, 720000); assert.equal(p.slow.fps, 12);
  p = b.plan([fast, { ...slow, pressure: false }], 1000); assert.equal(p.slow.bitrate, 720000);
  p = b.plan([fast, { ...slow, pressure: false }], 22000); assert(p.slow.bitrate > 720000); assert(p.slow.bitrate <= 900000);
  p = b.plan([], 23000); assert.equal(p.fast.allowed, false); assert.equal(p.slow.allowed, false);
});
test('bucket switch retains old debt until a new ready and rejects stale acknowledgements', () => {
  let now = 0, n = 0;
  const f = new MediaFlow({ stage: 'rendered', now: () => now, epoch: () => 'generation-valid-00000-' + ++n, configure() {}, keyframe() {}, close() {} });
  f.feedback({ version: 1, epoch: f.epoch, ready: true, received: null, rendered: null });
  f.admit(packet(1, true)); const old = f.epoch; now = 1200;
  assert(f.switchBucket('slow')); assert.equal(f.credits.size, 1); assert(!f.capacity());
  assert(!f.feedback({ version: 1, epoch: old, received: '1', rendered: '1' }));
  f.feedback({ version: 1, epoch: f.epoch, ready: true, received: null, rendered: null });
  assert.equal(f.credits.size, 0); assert(f.admit(packet(2, true))); assert.equal(f.snapshot().bucket, 'slow');
});
test('a transient delayed keyframe does not turn into sustained link pressure', () => {
  let now = 0;
  const f = new MediaFlow({ stage: 'rendered', now: () => now, epoch: () => 'generation-transient-00001', configure() {}, keyframe() {}, close() {} });
  f.feedback({ version: 1, epoch: f.epoch, ready: true, received: null, rendered: null });
  const ack = id => f.feedback({ version: 1, epoch: f.epoch, received: String(id), rendered: String(id) });
  f.admit(packet(1, true)); now = 20; ack(1);
  f.admit(packet(2, false)); now = 300; ack(2); assert.equal(f.snapshot().pressure, false);
  f.admit(packet(3, false)); now = 320; ack(3); assert.equal(f.snapshot().pressure, false);
});
