import assert from "node:assert/strict";
import test from "node:test";
import { headerSurfaceGeometry } from "../../apps/workbench-web/src/components/titlebar-surface-geometry";

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
