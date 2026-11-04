import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { H264MediaSource, onFirstVideoFrame } from '../../apps/workbench-web/src/browser/h264-media-source';

function fixture(t: TestContext, native = true) {
  const frames = new Map<number, FrameRequestCallback>(); let serial = 0;
  const oldRequest = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const oldCancel = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => { const id = ++serial; frames.set(id, callback); return id; } });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => { frames.delete(id); } });
  t.after(() => {
    if (oldRequest) Object.defineProperty(globalThis, 'requestAnimationFrame', oldRequest); else delete (globalThis as any).requestAnimationFrame;
    if (oldCancel) Object.defineProperty(globalThis, 'cancelAnimationFrame', oldCancel); else delete (globalThis as any).cancelAnimationFrame;
  });
  const video = new EventTarget() as HTMLVideoElement;
  Object.assign(video, { readyState: 0, seeking: false, videoWidth: 1280, videoHeight: 720 });
  let alpha = 255, reads = 0, denied = false;
  Object.defineProperty(video, 'ownerDocument', { value: { createElement: () => ({
    getContext: () => ({ clearRect() {}, drawImage() {}, getImageData() {
      reads++; if (denied) throw new Error('frame read unavailable');
      return { data: new Uint8ClampedArray([0, 0, 0, alpha]) };
    } }),
  }) } });
  let callback: (() => void) | undefined, cancelled = 0;
  if (native) Object.assign(video, {
    requestVideoFrameCallback: (next: () => void) => { callback = next; return 17; },
    cancelVideoFrameCallback: (id: number) => { assert.equal(id, 17); cancelled++; },
  });
  return { video, presentFrame: () => callback!(), get cancelled() { return cancelled; },
    setAlpha(value: number) { alpha = value; }, denyRead() { denied = true; }, get reads() { return reads; },
    raf() { const pending = [...frames.values()]; frames.clear(); for (const frame of pending) frame(0); }, get queued() { return frames.size; } };
}

test('native frame notification completes once and rejects a cancelled late callback', t => {
  const f = fixture(t); let presented = 0;
  const cancel = onFirstVideoFrame(f.video, () => presented++);
  Object.assign(f.video, { readyState: 2 }); f.video.dispatchEvent(new Event('loadeddata'));
  assert.equal(presented, 0, 'loaded metadata/data does not replace the old picture before presentation');
  cancel(); f.presentFrame(); assert.equal(presented, 0); assert.equal(f.cancelled, 1);
  onFirstVideoFrame(f.video, () => presented++); f.presentFrame(); f.presentFrame();
  assert.equal(presented, 1); assert.equal(f.queued, 0, 'no continuous RAF after first frame');
});

test('a decoded opaque sparse frame can reveal when native presentation callback never arrives', t => {
  const f = fixture(t); let presented = 0;
  onFirstVideoFrame(f.video, () => presented++);
  Object.assign(f.video, { readyState: 2 });
  f.video.dispatchEvent(new Event('loadeddata')); f.video.dispatchEvent(new Event('playing'));
  f.raf(); assert.equal(presented, 1); assert.equal(f.reads, 1); assert.equal(f.cancelled, 1);
  f.presentFrame(); f.video.dispatchEvent(new Event('seeked')); f.raf();
  assert.equal(presented, 1); assert.equal(f.reads, 1); assert.equal(f.queued, 0);
});

test('readiness and dimensions cannot reveal a transparent no-op video draw', t => {
  const f = fixture(t); f.setAlpha(0); let presented = 0;
  onFirstVideoFrame(f.video, () => presented++);
  Object.assign(f.video, { readyState: 3 }); f.video.dispatchEvent(new Event('loadeddata')); f.raf();
  assert.equal(presented, 0); assert.equal(f.queued, 0, 'no recurring polling while the decoder has no frame');
  f.setAlpha(255); f.video.dispatchEvent(new Event('playing')); f.raf();
  assert.equal(presented, 1);
});

test('a real native presentation still works when pixel access is unavailable', t => {
  const f = fixture(t); f.denyRead(); let presented = 0;
  onFirstVideoFrame(f.video, () => presented++);
  Object.assign(f.video, { readyState: 2 }); f.video.dispatchEvent(new Event('loadeddata')); f.raf();
  assert.equal(presented, 0); f.presentFrame(); assert.equal(presented, 1); assert.equal(f.queued, 0);
});

test('a seek fences both native and readable notifications until its completion', t => {
  const f = fixture(t); let presented = 0;
  onFirstVideoFrame(f.video, () => presented++);
  Object.assign(f.video, { readyState: 2, seeking: true }); f.presentFrame();
  f.video.dispatchEvent(new Event('loadeddata')); f.raf(); assert.equal(presented, 0); assert.equal(f.reads, 0);
  Object.assign(f.video, { seeking: false }); f.video.dispatchEvent(new Event('seeked')); f.raf();
  assert.equal(presented, 1);
});

test('event fallback waits for readable data and the seek, then retires its listeners and RAF', t => {
  const f = fixture(t, false); let presented = 0;
  onFirstVideoFrame(f.video, () => presented++); f.raf(); assert.equal(presented, 0);
  Object.assign(f.video, { readyState: 2, seeking: true }); f.video.dispatchEvent(new Event('loadeddata')); f.raf(); assert.equal(presented, 0);
  Object.assign(f.video, { seeking: false }); f.video.dispatchEvent(new Event('seeked')); f.video.dispatchEvent(new Event('playing')); assert.equal(f.queued, 1);
  f.raf(); assert.equal(presented, 1); f.video.dispatchEvent(new Event('playing')); assert.equal(f.queued, 0);
});

test('replacement cancels event fallback even if its RAF callback was already queued', t => {
  const f = fixture(t, false); let presented = 0;
  const cancel = onFirstVideoFrame(f.video, () => presented++);
  Object.assign(f.video, { readyState: 2 }); cancel(); f.raf();
  f.video.dispatchEvent(new Event('loadeddata')); assert.equal(presented, 0); assert.equal(f.queued, 0);
});


test('the first MSE append keeps initialization and its keyframe in one transaction', () => {
  const media = Object.create(H264MediaSource.prototype) as any;
  Object.assign(media, { sequence: 0, queue: [], disposed: false, width: 1280, height: 720,
    sps: null, pps: null, lastKey: 0, needsKey: false, requestKey() {}, recover() {} });
  const packet = new Uint8Array(9 + 4 + 4 + 4 + 5); packet[0] = 1;
  packet.set([0, 0, 0, 1, 0x67], 9); packet.set([0, 0, 0, 1, 0x68], 14); packet.set([0, 0, 0, 1, 0x65, 0x88], 19);
  media.push(packet.buffer);
  assert.equal(media.queue.length, 1);
  const appended: Uint8Array = media.queue[0];
  const header = new TextDecoder().decode(appended.subarray(0, 64));
  assert.equal(header.slice(4, 8), 'ftyp');
  assert.notEqual(new TextDecoder().decode(appended).indexOf('moof'), -1);
});

test('sparse MSE waiting cannot restart a pending or unchanged seek', () => {
  let currentTime = 0, seeking = false, end = 1, writes = 0, plays = 0;
  const video = { readyState: 1, get currentTime() { return currentTime; },
    set currentTime(value: number) { currentTime = value; seeking = true; writes++; },
    get seeking() { return seeking; }, play() { plays++; return Promise.resolve(); } };
  // Drive the actual waiting handler without native MediaSource dependencies.
  const media = Object.create(H264MediaSource.prototype) as any;
  Object.assign(media, { video, disposed: false, primed: false,
    caughtUpThrough: -Infinity,
    buffer: { buffered: { length: 1, start: () => 0, end: () => end } } });
  media.catchUp(); assert.equal(writes, 1); assert.equal(currentTime, .975);
  media.catchUp(); assert.equal(writes, 1, 'waiting during a seek must not restart it');
  seeking = false; media.catchUp(); assert.equal(writes, 1, 'waiting at the same target must make progress');
  end = 2; media.catchUp(); assert.equal(writes, 2); assert.equal(currentTime, 1.975);
  seeking = false; currentTime += .0005; media.catchUp(); assert.equal(writes, 2, 'sub-millisecond media rounding does not repeat the seek');
  assert.equal(plays, 5);
  media.disposed = true; media.catchUp(); assert.equal(plays, 5);
});

test('playback drift and repeated waiting cannot rewind an already caught-up sparse tail', () => {
  let time = 0, end = 1, seeking = false, writes = 0;
  const video = { readyState: 2, get currentTime() { return time; },
    set currentTime(value: number) { time = value; seeking = true; writes++; },
    get seeking() { return seeking; }, play: async () => {} };
  const media = Object.create(H264MediaSource.prototype) as any;
  Object.assign(media, { video, disposed: false, primed: false, caughtUpThrough: -Infinity,
    buffer: { buffered: { length: 1, start: () => 0, end: () => end } } });
  media.catchUp(); assert.equal(writes, 1); assert.equal(time, .975);
  seeking = false; time = 1.01;
  for (let i = 0; i < 20; i++) media.catchUp();
  assert.equal(writes, 1, 'waiting after normal playback must not replay the same frame');
  end += 1 / 30; media.catchUp(); assert.equal(writes, 2, 'a genuine new frame may catch up');
  seeking = false; time = end + .01; media.catchUp(); assert.equal(writes, 2);
  end += 1 / 30; seeking = true; media.catchUp(); assert.equal(writes, 2);
  seeking = false; media.catchUp(); assert.equal(writes, 3, 'a pending seek cannot consume a later target');
});


for (const firstSequence of [715827, 1431655, 2863311]) {
  test(`MSE decode times stay exact and monotonic across the ${firstSequence} frame boundary`, () => {
    // Fast-forward the frame counter; parse the actual generated MP4 bytes as
    // a demuxer would, independently from the writer's number representation.
    const media = Object.create(H264MediaSource.prototype) as any;
    Object.assign(media, { sequence: firstSequence, queue: [], disposed: false,
      buffer: null, lastKey: 0, needsKey: false, requestKey() {}, recover() { assert.fail('unexpected recovery'); } });
    const packet = new Uint8Array(15); packet[0] = 1;
    packet.set([0, 0, 0, 1, 0x65, 0x88], 9);
    let previous = -1n;
    for (let i = 0; i < 3; i++) {
      const expected = BigInt(firstSequence + i) * 3000n;
      media.push(packet.buffer);
      const fragment: Uint8Array = media.queue.at(-1);
      const offset = new TextDecoder().decode(fragment).indexOf('tfdt');
      assert(offset > 0);
      const view = new DataView(fragment.buffer, fragment.byteOffset, fragment.byteLength);
      assert.equal(view.getUint8(offset + 4), 1, 'version 1 carries a 64-bit decode time');
      const actual = view.getBigUint64(offset + 8);
      assert.equal(actual, expected);
      assert(actual > previous, 'a long stream must never jump backward at an integer boundary');
      previous = actual;
    }
  });
}
