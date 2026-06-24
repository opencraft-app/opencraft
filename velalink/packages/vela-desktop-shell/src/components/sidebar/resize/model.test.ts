import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SIDEBAR_RESIZE_CONSTRAINTS,
  resolveSidebarResize,
} from "./model";

test("sidebar resize commits the same clamped width that preview displays", () => {
  assert.deepEqual(resolveSidebarResize(760), {
    isSidebarVisible: true,
    proposedWidthPx: 760,
    reason: "max_clamped",
    sidebarWidthPx: DEFAULT_SIDEBAR_RESIZE_CONSTRAINTS.maxWidthPx,
  });
  assert.deepEqual(resolveSidebarResize(200), {
    isSidebarVisible: true,
    proposedWidthPx: 200,
    reason: "min_clamped",
    sidebarWidthPx: DEFAULT_SIDEBAR_RESIZE_CONSTRAINTS.minWidthPx,
  });
});

test("sidebar resize keeps a left overscroll band before collapse intent", () => {
  assert.deepEqual(resolveSidebarResize(180), {
    isSidebarVisible: true,
    proposedWidthPx: 180,
    reason: "min_clamped",
    sidebarWidthPx: DEFAULT_SIDEBAR_RESIZE_CONSTRAINTS.minWidthPx,
  });
});

test("sidebar resize collapses when dragged far past the minimum edge", () => {
  assert.deepEqual(resolveSidebarResize(160), {
    isSidebarVisible: false,
    proposedWidthPx: 160,
    reason: "collapse_requested",
    sidebarWidthPx: DEFAULT_SIDEBAR_RESIZE_CONSTRAINTS.minWidthPx,
  });
});

test("sidebar resize preserves exact in-range pointer widths", () => {
  assert.deepEqual(resolveSidebarResize(337.4), {
    isSidebarVisible: true,
    proposedWidthPx: 337,
    reason: "within_bounds",
    sidebarWidthPx: 337,
  });
});
