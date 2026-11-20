import assert from 'node:assert/strict';
import test from 'node:test';
import { motionValue } from 'motion/react';
import { animateOverviewProgress, overviewMaxFrameStep, type OverviewFrameSource } from '../../apps/workbench-web/src/components/overview-playback';

function fixture(from = 0, to = 1, initialVelocity = 0) {
  let nextId = 0, completed = 0;
  const callbacks = new Map<number, (time: number) => void>();
  const frames: OverviewFrameSource = {
    request(callback) { callbacks.set(++nextId, callback); return nextId; },
    cancel(id) { callbacks.delete(id); },
  };
  const updates: number[] = [], value = motionValue(from);
  const options = { stiffness:550, damping:42, mass:1, restDelta:.0001, restSpeed:.001,
    velocity:initialVelocity, onUpdate:(v: number) => updates.push(v), onComplete:() => completed++ };
  const playback = animateOverviewProgress(value, to, options, frames);
  const frame = (time: number) => { const pending = [...callbacks.values()]; callbacks.clear(); for (const callback of pending) callback(time); };
  return { playback, updates, value, frame, callbacks, options, frames, completed:() => completed };
}

test('first presentation owns time zero, regardless of allocation stall; both directions mirror', () => {
  const a = fixture(), b = fixture(1, 0);
  a.frame(10000); b.frame(100000);
  assert.deepEqual(a.updates, [0]); assert.deepEqual(b.updates, [1]);
  for (let i = 1; i < 60; i++) {
    a.frame(10000 + i * 16.67); b.frame(100000 + i * 16.67);
    assert(Math.abs(a.value.get() + b.value.get() - 1) < 1e-9);
  }
  assert.equal(a.completed(), 1); assert.equal(b.completed(), 1);
});

test('blocked/hidden time creates no catch-up debt; ordinary cadence is unchanged', () => {
  const a = fixture(); a.frame(500); a.frame(516);
  assert.equal(a.playback.time, .016);
  a.frame(50000);
  assert.equal(a.playback.time, (.016 * 1000 + overviewMaxFrameStep) / 1000);
  a.frame(50016);
  assert(Math.abs(a.playback.time - (.032 + overviewMaxFrameStep/1000)) < 1e-9);
  assert(a.value.get() < .6);
});

test('stop before first frame and stop while painting fence callbacks without jumping', () => {
  const a = fixture(); const late = [...a.callbacks.values()][0];
  a.playback.stop(); late(100000); assert.deepEqual(a.updates, []); assert.equal(a.completed(), 0);
  const b = fixture(); b.frame(0); b.frame(30); const at = b.value.get();
  b.playback.stop(); b.frame(10000); assert.equal(b.value.get(), at); assert.equal(b.completed(), 0);
  const c = fixture(); c.options.onUpdate = () => c.playback.stop();
  c.frame(0); assert.equal(c.callbacks.size, 0); assert.equal(c.completed(), 0);
});

test('reversal inherits physical velocity, independent of time spent stopped/preparing', () => {
  const a = fixture(); a.frame(0); a.frame(30); a.frame(60); a.playback.stop();
  const position = a.value.get(), velocity = a.playback.velocity;
  assert(velocity > 0);
  const reverse = animateOverviewProgress(a.value, 0, { ...a.options, velocity }, a.frames);
  a.frame(10000); assert.equal(a.value.get(), position); assert.equal(reverse.velocity, velocity);
  a.frame(10008); assert(a.value.get() > position, 'momentum must not be replaced by a new ease-in');
  a.frame(10024); reverse.stop(); assert.equal(a.completed(), 0);
});

test('pause/seek/restart and explicit finish have a single completion owner', () => {
  const a = fixture(); a.frame(0); a.frame(16); a.playback.pause();
  a.frame(5000); assert.equal(a.playback.time, .016);
  a.playback.time = .08; const position = a.value.get();
  a.playback.play(); a.frame(100000); assert.equal(a.value.get(), position);
  a.playback.complete(); a.playback.complete(); a.frame(200000);
  assert.equal(a.value.get(), 1); assert.equal(a.completed(), 1); assert.equal(a.callbacks.size, 0);
});
