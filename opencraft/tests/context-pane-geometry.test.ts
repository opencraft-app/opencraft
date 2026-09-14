import assert from "node:assert/strict";
import test from "node:test";
import { previewContextGeometry, settledContextGeometry } from "../apps/workbench-web/src/components/context-pane-geometry";
import { beginSidecarPrimaryResize, previewSidecarPrimaryResize, primaryViewportWidth } from "../apps/workbench-web/src/components/sidecar-primary-resize";

test("growing a contextual frame grows its content in the same projection", () => {
  const state = settledContextGeometry(275);
  assert.deepEqual(previewContextGeometry(state, 335), { committedWidth: 275, frameWidth: 335, viewportWidth: 335 });
  assert.deepEqual(state, settledContextGeometry(275));
});
test("held contraction and reversal reflow live content without changing the saved preference", () => {
  let state = settledContextGeometry(335);
  for (const width of [400, 360, 300, 240, 0, 275, 380]) {
    state = previewContextGeometry(state, width);
    assert.equal(state.viewportWidth, width);
    assert.equal(state.viewportWidth, state.frameWidth);
    assert.equal(state.committedWidth, 335);
  }
  assert.deepEqual(settledContextGeometry(275), { committedWidth: 275, frameWidth: 275, viewportWidth: 275 });
});
test("release commits but does not move the content viewport", () => {
  const held = previewContextGeometry(settledContextGeometry(400), 260);
  const released = settledContextGeometry(held.frameWidth);
  assert.equal(released.viewportWidth, held.viewportWidth);
  assert.equal(released.frameWidth, held.frameWidth);
  assert.equal(released.committedWidth, 260);
});
test("primary layout follows ordinary resize and uses a floor only for compact/hidden transitions", () => {
  for (const width of [137, 130, 126, 129, 135]) assert.equal(primaryViewportWidth(width, 126), width);
  for (const width of [125, 90, 52, 20, 0]) assert.equal(primaryViewportWidth(width, 126), 126);
});
test("a new drag takes over the actual settling frame instead of jumping to the saved target", () => {
  const transaction = beginSidecarPrimaryResize({ clientX: 200, detent: "expanded", expandedWidth: 137, compactWidth: 52, currentWidth: 110 });
  const preview = previewSidecarPrimaryResize({ transaction, clientX: 201, compactWidth: 52, expandedMinimumWidth: 126, maximumWidth: 137 });
  assert.equal(preview.frameWidth, 111);
});
test("cancel restores origin and invalid geometry is rejected", () => {
  const preview = previewContextGeometry(settledContextGeometry(275), 400);
  assert.deepEqual(settledContextGeometry(preview.committedWidth), settledContextGeometry(275));
  for (const width of [-1, NaN, Infinity]) assert.throws(() => previewContextGeometry(preview, width), RangeError);
});
