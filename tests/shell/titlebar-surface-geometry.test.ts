import assert from "node:assert/strict";
import test from "node:test";
import { headerSurfaceGeometry, titlebarSurfaceGeometry } from "../../apps/workbench-web/src/components/titlebar-surface-geometry";

test("compact upper lip moves with the existing context spring before unmount", () => {
  const frames = [1, .9, .5, .1, 0].map(progress => titlebarSurfaceGeometry(52, 320 * progress, progress));
  assert.deepEqual(frames[0], { extensionLeft: 372, extensionWidth: 0, dividerProgress: 0 });
  assert.deepEqual(frames[2], { extensionLeft: 186, extensionWidth: 26, dividerProgress: .5 });
  assert.deepEqual(frames[4], { extensionLeft: 0, extensionWidth: 52, dividerProgress: 1 });
  for (let i = 1; i < frames.length; i++) {
    assert.ok(frames[i].extensionLeft < frames[i - 1].extensionLeft);
    assert.ok(frames[i].extensionWidth > frames[i - 1].extensionWidth);
  }
});

test("expanded and ordinary held-resize geometry do not get an upper lip", () => {
  for (const primary of [126, 136, 200, 320]) {
    assert.deepEqual(titlebarSurfaceGeometry(primary, 0, 0), { extensionLeft: primary, extensionWidth: 0, dividerProgress: 0 });
  }
  for (const context of [240, 400, 300]) {
    assert.deepEqual(titlebarSurfaceGeometry(52, context, 1), { extensionLeft: context + 52, extensionWidth: 0, dividerProgress: 0 });
  }
});

test("primary compaction projects every pointer frame, not a discrete detent", () => {
  const frames = [126, 100, 75, 52].map(width => titlebarSurfaceGeometry(width, 0, 0));
  assert.ok(frames[1].extensionWidth > 0);
  for (let i = 1; i < frames.length; i++) assert.ok(frames[i].extensionLeft < frames[i - 1].extensionLeft);
});

test("reversal, reduced-motion snap and hidden rail are deterministic projections", () => {
  const closing = titlebarSurfaceGeometry(52, 160, .5);
  assert.deepEqual(closing, titlebarSurfaceGeometry(52, 160, .5));
  assert.deepEqual(titlebarSurfaceGeometry(0, 0, 0), { extensionLeft: 0, extensionWidth: 0, dividerProgress: 0 });
  assert.deepEqual(titlebarSurfaceGeometry(52, 0, -.1), titlebarSurfaceGeometry(52, 0, 0));
  assert.deepEqual(titlebarSurfaceGeometry(52, 320, 1.1), titlebarSurfaceGeometry(52, 320, 1));
  for (const width of [0, 20, 52, 70, 126, 200]) for (const progress of [0, .1, .5, 1]) {
    const frame = titlebarSurfaceGeometry(width, 320 * progress, progress);
    assert.ok(frame.extensionWidth >= 0 && frame.extensionWidth <= width);
    assert.equal(frame.extensionLeft + frame.extensionWidth, 320 * progress + width);
    assert.ok(frame.dividerProgress >= 0 && frame.dividerProgress <= 1);
  }
});


test("window header leaves the panel aperture to its toolbar", () => {
  assert.deepEqual(headerSurfaceGeometry(1600, 1600, 280, 94), { leadingWidth: 1506, trailingWidth: 94 });
  assert.deepEqual(headerSurfaceGeometry(1600, 960, 280, 94), { leadingWidth: 960, trailingWidth: 94 });
  assert.deepEqual(headerSurfaceGeometry(1600, 52, 280, 94), { leadingWidth: 280, trailingWidth: 94 });
  assert.deepEqual(headerSurfaceGeometry(360, 0, 90, 44), { leadingWidth: 90, trailingWidth: 44 });
});

test("paint ownership stays disjoint while panes animate, reverse or shrink", () => {
  for (const width of [0, 100, 360, 1600]) for (const end of [0, 52, 400, 960, 1600]) {
    const frame = headerSurfaceGeometry(width, end, 280, 94);
    assert.ok(frame.leadingWidth >= 0 && frame.trailingWidth >= 0);
    assert.ok(frame.leadingWidth + frame.trailingWidth <= width);
  }
  const forward = [960, 800, 500, 52].map(end => headerSurfaceGeometry(1600, end, 280, 94));
  const reverse = [52, 500, 800, 960].map(end => headerSurfaceGeometry(1600, end, 280, 94));
  assert.deepEqual(forward, reverse.reverse());
});
