import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  computeScrollOffsetFromThumbDelta,
  computeScrollOffsetFromThumbOffset,
  computeVerticalScrollbarGeometry,
} from "../src/conversation-runtime/scrollbar/geometry";

const root = process.cwd();

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

test("overlay thumb drag exposes committed scroll offsets to the conversation scroll runtime", () => {
  const source = readFileSync(
    join(
      root,
      "packages/vela-chat-web/src/conversation-runtime/scrollbar/useVerticalScrollbarOverlay.tsx",
    ),
    "utf8",
  );

  assert.match(
    source,
    /onScrollCommit/,
    "self-drawn scrollbar must not only mutate element.scrollTop; it must synchronously commit the drag position to the scroll runtime before a route switch can unmount it",
  );
  assert.match(
    source,
    /onUserScrollIntent/,
    "thumb dragging is user scroll intent and must be reported to bottom-anchor ownership, not inferred later from an async DOM scroll event",
  );
});

test("layout resize updates scrollbar geometry without revealing the overlay", () => {
  const source = readFileSync(
    join(
      root,
      "packages/vela-chat-web/src/conversation-runtime/scrollbar/useVerticalScrollbarOverlay.tsx",
    ),
    "utf8",
  );
  const scrollHandler = source.match(/const handleScroll = \(\) => \{[\s\S]*?\n    \};/);
  const resizeHandler = source.match(/const handleResize = \(\) => \{[\s\S]*?\n    \};/);

  assert.ok(scrollHandler, "scroll events must own scrollbar reveal behavior");
  assert.match(scrollHandler[0], /revealFromScroll\(\)/);
  assert.match(scrollHandler[0], /markScrollActive\(\)/);
  assert.match(scrollHandler[0], /suppressScrollRevealForResizeRef\.current/);
  assert.ok(resizeHandler, "resize observer must be present for geometry updates");
  assert.match(resizeHandler[0], /updateMetrics\(\)/);
  assert.match(resizeHandler[0], /requestAnimationFrame/);
  assert.doesNotMatch(resizeHandler[0], /revealFromScroll|markScrollActive/);
  assert.match(source, /new ResizeObserver\(handleResize\)/);
});
