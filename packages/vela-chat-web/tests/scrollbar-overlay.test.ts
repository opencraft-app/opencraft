import assert from "node:assert/strict";
import test from "node:test";

import {
  computeScrollOffsetFromThumbDelta,
  computeScrollOffsetFromThumbOffset,
  computeVerticalScrollbarGeometry,
} from "../src/conversation-runtime/scrollbar/geometry";

test("vertical scrollbar geometry mirrors native scroll range", () => {
  const geometry = computeVerticalScrollbarGeometry({
    contentSize: 2400,
    offset: 600,
    viewportSize: 600,
  });

  assert.deepEqual(geometry, {
    maxScrollOffset: 1800,
    maxThumbOffset: 450,
    thumbOffset: 150,
    thumbSize: 150,
    visible: true,
  });
});

test("vertical scrollbar geometry hides when content fits", () => {
  const geometry = computeVerticalScrollbarGeometry({
    contentSize: 600,
    offset: 0,
    viewportSize: 600,
  });

  assert.deepEqual(geometry, {
    maxScrollOffset: 0,
    maxThumbOffset: 0,
    thumbOffset: 0,
    thumbSize: 0,
    visible: false,
  });
});

test("vertical scrollbar geometry clamps thumb size and offset", () => {
  const geometry = computeVerticalScrollbarGeometry({
    contentSize: 10000,
    minThumbSize: 24,
    offset: 99999,
    viewportSize: 100,
  });

  assert.deepEqual(geometry, {
    maxScrollOffset: 9900,
    maxThumbOffset: 76,
    thumbOffset: 76,
    thumbSize: 24,
    visible: true,
  });
});

test("dragging the overlay thumb maps back to scrollTop", () => {
  const offset = computeScrollOffsetFromThumbDelta({
    delta: 100,
    maxScrollOffset: 1800,
    maxThumbOffset: 450,
    startOffset: 600,
  });

  assert.equal(offset, 1000);
});

test("dragging the overlay thumb clamps to scroll bounds", () => {
  const offset = computeScrollOffsetFromThumbDelta({
    delta: 1000,
    maxScrollOffset: 1800,
    maxThumbOffset: 450,
    startOffset: 1600,
  });

  assert.equal(offset, 1800);
});

test("clicking the overlay track maps directly to an absolute scrollTop", () => {
  const offset = computeScrollOffsetFromThumbOffset({
    maxScrollOffset: 1800,
    maxThumbOffset: 450,
    thumbOffset: 225,
  });

  assert.equal(offset, 900);
});
