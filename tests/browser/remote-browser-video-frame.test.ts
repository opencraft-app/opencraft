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
  Object.assign(video, { readyState: 0, seeking: false });
  let callback: (() => void) | undefined, cancelled = 0;
  if (native) Object.assign(video, {
    requestVideoFrameCallback: (next: () => void) => { callback = next; return 17; },
    cancelVideoFrameCallback: (id: number) => { assert.equal(id, 17); cancelled++; },
  });
  return { video, presentFrame: () => callback!(), get cancelled() { return cancelled; },
    raf() { const pending = [...frames.values()]; frames.clear(); for (const frame of pending) frame(0); }, get queued() { return frames.size; } };
}

test('native frame fence waits for presentation, completes once and rejects a cancelled late callback', t => {
  const f = fixture(t); let presented = 0;
  const cancel = onFirstVideoFrame(f.video, () => presented++);
  Object.assign(f.video, { readyState: 2 }); f.video.dispatchEvent(new Event('loadeddata'));
  assert.equal(presented, 0, 'loaded metadata/data does not replace the old picture before presentation');
  cancel(); f.presentFrame(); assert.equal(presented, 0); assert.equal(f.cancelled, 1);
  onFirstVideoFrame(f.video, () => presented++); f.presentFrame(); f.presentFrame();
  assert.equal(presented, 1); assert.equal(f.queued, 0, 'no continuous RAF after first frame');
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


test('sparse MSE waiting cannot restart a pending or unchanged seek', () => {
  let currentTime = 0, seeking = false, end = 1, writes = 0, plays = 0;
  const video = { readyState: 1, get currentTime() { return currentTime; },
    set currentTime(value: number) { currentTime = value; seeking = true; writes++; },
    get seeking() { return seeking; }, play() { plays++; return Promise.resolve(); } };
  // Drive the actual waiting handler without native MediaSource dependencies.
  const media = Object.create(H264MediaSource.prototype) as any;
  Object.assign(media, { video, disposed: false, primed: false,
    buffer: { buffered: { length: 1, start: () => 0, end: () => end } } });
  media.catchUp(); assert.equal(writes, 1); assert.equal(currentTime, .975);
  media.catchUp(); assert.equal(writes, 1, 'waiting during a seek must not restart it');
  seeking = false; media.catchUp(); assert.equal(writes, 1, 'waiting at the same target must make progress');
  end = 2; media.catchUp(); assert.equal(writes, 2); assert.equal(currentTime, 1.975);
  seeking = false; currentTime += .0005; media.catchUp(); assert.equal(writes, 2, 'sub-millisecond media rounding does not repeat the seek');
  assert.equal(plays, 5);
  media.disposed = true; media.catchUp(); assert.equal(plays, 5);
});
