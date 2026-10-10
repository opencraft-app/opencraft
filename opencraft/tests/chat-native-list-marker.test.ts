import assert from "node:assert/strict";
import test from "node:test";

import { nativeListMarker, nativeListMarkerColumnWidth } from "../packages/chat-render-native/src/renderers/list-marker";

test("native Markdown list markers preserve Web ordered starts and nested bullets", () => {
  assert.deepEqual([0, 1, 2].map(index => nativeListMarker(true, 4, index)), ["4.", "5.", "6."]);
  assert.equal(nativeListMarker(true, null, 0), "1.");
  assert.equal(nativeListMarker(false, null, 0), "•");
  assert.equal(nativeListMarker(false, null, 0, 1), "◦");
  assert.equal(nativeListMarker(false, null, 0, 2), "▪");
  assert.equal(nativeListMarker(false, null, 0, 3), "▪");
});

test("ordered Markdown list markers keep one body column across 9 to 10", () => {
  assert.equal(nativeListMarkerColumnWidth(true, 9, 2), 24);
  assert.equal(nativeListMarkerColumnWidth(true, 1, 3), 18);
  assert.equal(nativeListMarkerColumnWidth(false, null, 20), 18);
});
