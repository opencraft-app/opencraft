import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import {
  buildTurnLayout,
  distanceFromBottomToTargetWithinTurn,
} from "@opencraft/timeline-virtualizer";

const require = createRequire(import.meta.url);
const { selectNativeTargetScrollBehavior } = require("../apps/workbench-expo/src/components/native-target-scroll-policy.ts") as typeof import("../apps/workbench-expo/src/components/native-target-scroll-policy");

test("Native target scrolling animates only an already mounted nearby target", () => {
  const base = {
    requestedBehavior: "smooth" as const,
    targetWasMountedAtStart: true,
    currentDistanceFromBottomPx: 600,
    destinationDistanceFromBottomPx: 1_000,
    viewportHeightPx: 700,
  };
  assert.equal(selectNativeTargetScrollBehavior(base), "smooth");
  assert.equal(selectNativeTargetScrollBehavior({ ...base, targetWasMountedAtStart: false }), "instant");
  assert.equal(selectNativeTargetScrollBehavior({ ...base, destinationDistanceFromBottomPx: 1_500 }), "instant");
  assert.equal(selectNativeTargetScrollBehavior({ ...base, viewportHeightPx: 0 }), "instant");
  assert.equal(selectNativeTargetScrollBehavior({ ...base, requestedBehavior: "instant" }), "instant");
});

test("Native user-message target aligns within its measured Turn, rather than the whole Turn", () => {
  const layout = buildTurnLayout([
    { turnKey: "older", estimatedHeightPx: 300 },
    { turnKey: "target", estimatedHeightPx: 500 },
    { turnKey: "newer", estimatedHeightPx: 200 },
  ]);
  assert.equal(distanceFromBottomToTargetWithinTurn({
    align: "top",
    layout,
    targetHeightPx: 80,
    targetTopOffsetWithinTurnPx: 160,
    topAlignmentInsetPx: 12,
    turnKey: "target",
    viewportHeightPx: 400,
  }), 164);
});
