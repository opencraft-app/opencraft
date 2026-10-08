import assert from "node:assert/strict";
import test from "node:test";
import { classifyTwoFinger, constrainView, DesktopScrollPolicy, framebufferPoint, zoomAround } from "../plugins/cloud-desktop/src/input-policy";

test("coordinates use displayed canvas bounds; reject bars, clamp a captured drag, never exceed framebuffer", () => {
  const frame = { x: 50, y: 100, width: 400, height: 200 };
  assert.equal(framebufferPoint({ x: 49, y: 200 }, frame, 800, 400), null);
  assert.deepEqual(framebufferPoint({ x: 250, y: 200 }, frame, 800, 400), { x: 400, y: 200 });
  assert.deepEqual(framebufferPoint({ x: 450, y: 301 }, frame, 800, 400, true), { x: 799, y: 399 });
  assert.equal(framebufferPoint({ x: NaN, y: 200 }, frame, 800, 400), null);
  assert.equal(framebufferPoint({ x: 0, y: 0 }, { ...frame, width: 0 }, 800, 400), null);
});

test("local zoom is bounded and panning cannot lose the picture or magnify letterboxing", () => {
  assert.deepEqual(constrainView({ scale: 0, x: 20, y: 20 }, { width: 400, height: 200 }, { width: 500, height: 300 }),
    { scale: 1, x: 0, y: 0 });
  assert.deepEqual(constrainView({ scale: 8, x: 999, y: -999 }, { width: 400, height: 200 }, { width: 500, height: 300 }),
    { scale: 4, x: 550, y: -250 });
});

test("zoom anchors the touched media point rather than pulling an off-center pinch to the middle", () => {
  const view = { scale: 2, x: 20, y: 10 }, focal = { x: 70, y: -30 };
  const next = zoomAround(view, focal, 3);
  assert.equal(next.x + (focal.x - view.x) / view.scale * next.scale, focal.x);
  assert.equal(next.y + (focal.y - view.y) / view.scale * next.scale, focal.y);
});

test("wheel and touch share small-delta accumulation, step bounds, idle and grant resets", () => {
  const wheel = new DesktopScrollPolicy(), touch = new DesktopScrollPolicy();
  for (const policy of [wheel, touch]) {
    assert.deepEqual(policy.consume(0, 2, 0, 0), []);
    assert.deepEqual(policy.consume(0, 3, 0, 10), []);
    assert.deepEqual(policy.consume(0, 5, 0, 20), [16]);
    assert.deepEqual(policy.consume(999, -999, 0, 21), []);
    assert.deepEqual(policy.consume(999, -999, 0, 120), [64, 8]);
    assert.deepEqual(policy.consume(0, 5, 0, 121), []);
    assert.deepEqual(policy.consume(0, 5, 0, 500), [], "idle does not replay old deltas");
    policy.reset();
    assert.deepEqual(policy.consume(0, 5, 0, 510), [], "new grant cannot inherit old momentum");
    assert.deepEqual(policy.consume(0, -10, 0, 520), [8], "reversal does not pay back old direction");
    assert.deepEqual(policy.consume(NaN, 10, 0, 630), []);
  }
  const lines = new DesktopScrollPolicy();
  assert.deepEqual(lines.consume(-1, 1, 1, 0), [32, 16]);
});

test("two-finger intent distinguishes a local pinch from remote scrolling without jitter", () => {
  assert.equal(classifyTwoFinger(3, { x: 3, y: 3 }), "undecided");
  assert.equal(classifyTwoFinger(2, { x: 0, y: 9 }), "scroll");
  assert.equal(classifyTwoFinger(10, { x: 0, y: 9 }), "zoom");
});
