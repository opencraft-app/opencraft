import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketMediaReceiver } from '../../packages/remote-interaction/src/websocket';
import type { MediaFeedback } from '../../packages/remote-interaction/src/protocol.cjs';
const packet = (id: number) => { const bytes = new ArrayBuffer(10); new DataView(bytes).setBigUint64(1, BigInt(id)); return bytes; };
function fixture() {
  let now = 0, resets = 0, visible = true;
  const sent: MediaFeedback[] = [];
  const receiver = new WebSocketMediaReceiver({ send: value => sent.push(value), reset: () => resets++, visible: () => visible, now: () => now });
  const config = (epoch = 'media-generation-initial-00001', stage = 'rendered') =>
    receiver.configure({ type: 'media-config', version: 1, epoch, stage, profile: 'h264-timestamp-v1', maxFrameBytes: 4194304 });
  return { receiver, sent, config, setNow(value: number) { now = value; }, hide() { visible = false; }, get resets() { return resets; } };
}
test('receiver reports receipt separately, confirms reset before resuming and retires callbacks', () => {
  const f = fixture();
  try {
    assert(f.config()); assert.equal(f.resets, 1); assert.equal(f.sent[0].ready, true);
    f.receiver.receive(packet(1)); f.setNow(50); f.receiver.tick();
    assert.equal(f.sent.at(-1)?.received, '1'); assert.equal(f.sent.at(-1)?.rendered, null);
    f.receiver.decoded('1', 0); f.receiver.renderedFrame('1'); f.setNow(100); f.receiver.tick();
    assert.equal(f.sent.at(-1)?.rendered, '1');
    assert(f.config('media-generation-replaced-0002')); f.receiver.renderedFrame('1');
    f.setNow(1200); f.receiver.tick(); assert.equal(f.sent.at(-1)?.rendered, null);
    const length = f.sent.length; f.receiver.dispose(); f.setNow(50000); f.receiver.tick(); assert.equal(f.sent.length, length);
  } finally { f.receiver.dispose(); }
});
test('idle and hidden pages are not silently decoded-stalled', () => {
  const f = fixture();
  try {
    f.config(); f.setNow(100000); f.receiver.tick(); assert(!f.sent.some(value => value.requestReset));
    f.hide(); f.receiver.receive(packet(1)); f.setNow(110000); f.receiver.tick();
    assert(!f.sent.some(value => value.requestReset));
  } finally { f.receiver.dispose(); }
});
test('fresh chunks without presentation request recovery once; steady progress does not', () => {
  const f = fixture();
  try {
    f.config();
    for (let i = 1; i <= 6; i++) { f.setNow(i * 1000); f.receiver.receive(packet(i)); f.receiver.tick(); }
    assert.equal(f.sent.filter(value => value.requestReset).length, 1);
    f.config('media-generation-reset-0000002');
    for (let i = 10; i < 16; i++) { f.setNow(i * 1000); f.receiver.receive(packet(i)); f.receiver.renderedFrame(String(i)); f.receiver.tick(); }
    assert.equal(f.sent.filter(value => value.requestReset).length, 1);
  } finally { f.receiver.dispose(); }
});
test('sustained decoding debt lowers capture requests and a reset preserves the learned cap', () => {
  const f = fixture();
  try {
    f.config();
    for (let second = 1; second <= 4; second++) {
      for (let frame = 0; frame < 10; frame++) {
        const id = second * 100 + frame; f.receiver.receive(packet(id));
        f.receiver.observeQueue(2); f.receiver.decoded(String(id), 0); f.receiver.renderedFrame(String(id));
      }
      f.setNow(second * 1000); f.receiver.tick();
    }
    assert(f.sent.some(value => value.fps !== undefined && value.fps < 30));
    f.config('media-generation-reset-0000002');
    assert(f.sent.at(-1)!.fps! < 30);
  } finally { f.receiver.dispose(); }
});
