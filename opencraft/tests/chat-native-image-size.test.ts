import assert from "node:assert/strict";
import test from "node:test";

import { nativeImageBox } from "../packages/chat-render-native/src/renderers/image-size";

test("native Markdown image thumbnails preserve intrinsic ratio and Web limits", () => {
  assert.deepEqual(nativeImageBox(1200, 600, 390), { width: 200, height: 100 });
  assert.deepEqual(nativeImageBox(600, 1200, 390), { width: 100, height: 200 });
  assert.deepEqual(nativeImageBox(40, 30, 390), { width: 40, height: 30 });
  assert.deepEqual(nativeImageBox(1200, 600, 120), { width: 120, height: 60 });
});

test("unknown image metadata reserves a bounded loading box", () => {
  assert.deepEqual(nativeImageBox(null, null, 120), { width: 120, height: 96 });
  assert.deepEqual(nativeImageBox(0, 100, null), { width: 200, height: 96 });
});
