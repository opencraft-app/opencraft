import assert from "node:assert/strict";
import test from "node:test";
import { hasNativeHorizontalOverflow } from "../packages/chat-render-native/src/horizontal-scroll-policy.ts";

test("horizontal gestures stay with locally scrollable content only", () => {
  assert.equal(hasNativeHorizontalOverflow(null, null), true);
  assert.equal(hasNativeHorizontalOverflow(320, null), true);
  assert.equal(hasNativeHorizontalOverflow(320, 0), true);
  assert.equal(hasNativeHorizontalOverflow(320, 220), false);
  assert.equal(hasNativeHorizontalOverflow(320, 320), false);
  assert.equal(hasNativeHorizontalOverflow(320, 320.5), false);
  assert.equal(hasNativeHorizontalOverflow(320, 400), true);
  assert.equal(hasNativeHorizontalOverflow(700, 400), false);
});
