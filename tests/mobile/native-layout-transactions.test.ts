import assert from "node:assert/strict";
import test from "node:test";
import {
  NativeContentMeasurementEpoch,
  NativeTargetPositionTransaction,
  createNativeTurnMountPlan,
  nativeTargetReadiness,
  NativeConversationViewportOwner,
} from "@opencraft/timeline-host-native";

test("target absence is independent of row measurement; a valid late child is pending", () => {
  const row = { observedRowHeightPx: 300, committedRowHeightPx: 300, geometryCommitPending: false };
  assert.equal(nativeTargetReadiness({ ...row, targetExists: false, anchorMeasured: false }), "unavailable");
  assert.equal(nativeTargetReadiness({ ...row, targetExists: true, anchorMeasured: false }), "pending");
  assert.equal(nativeTargetReadiness({ ...row, targetExists: true, anchorMeasured: true }), "ready");
  assert.equal(nativeTargetReadiness({ ...row, targetExists: true, anchorMeasured: true, geometryCommitPending: true }), "pending");
  assert.equal(nativeTargetReadiness({ ...row, targetExists: false, anchorMeasured: false, observedRowHeightPx: null }), "unavailable");
});

test("natural measurement rejects callbacks from an old content, width, node or lifetime", () => {
  const epoch = new NativeContentMeasurementEpoch();
  const node = {};
  epoch.reconcile("a", 300);
  const first = epoch.capture(node);
  assert.equal(epoch.accepts(first, node), true);
  epoch.reconcile("a", 600);
  assert.equal(epoch.accepts(first, node), false);
  epoch.reconcile("a", 300);
  assert.equal(epoch.accepts(first, node), false);
  epoch.reconcile("a", 600);
  const wide = epoch.capture(node);
  epoch.reconcile("b", 600);
  assert.equal(epoch.accepts(wide, node), false);
  const current = epoch.capture(node);
  assert.equal(epoch.accepts(current, {}), false);
  epoch.invalidate();
  assert.equal(epoch.accepts(current, node), false);
  epoch.activate();
  assert.equal(epoch.accepts(current, node), false);
  assert.equal(epoch.matchesLayout(current), true);
  assert.equal(epoch.accepts(epoch.capture(node), node), true);
});

test("a remote measurement window preserves visible rows without mounting the intervening history", () => {
  assert.deepEqual(createNativeTurnMountPlan(
    { startIndex: 95, endIndex: 100 }, { startIndex: 27, endIndex: 34 }, 100,
  ), [27, 28, 29, 30, 31, 32, 33, 95, 96, 97, 98, 99]);
  assert.deepEqual(createNativeTurnMountPlan(
    { startIndex: 3, endIndex: 7 }, { startIndex: 5, endIndex: 9 }, 8,
  ), [3, 4, 5, 6, 7]);
});

test("a smooth position is corrected when content or viewport geometry changes", () => {
  const transaction = new NativeTargetPositionTransaction();
  assert.deepEqual(transaction.advance({
    geometry: "first", destinationDistancePx: 500, physicalDistancePx: 900, behavior: "smooth",
  }), { type: "write", distancePx: 500, behavior: "smooth" });
  assert.deepEqual(transaction.advance({
    geometry: "first", destinationDistancePx: 500, physicalDistancePx: 700, behavior: "smooth",
  }), { type: "wait" });
  assert.deepEqual(transaction.advance({
    geometry: "grown", destinationDistancePx: 700, physicalDistancePx: 800, behavior: "smooth",
  }), { type: "write", distancePx: 700, behavior: "instant" });
  assert.deepEqual(transaction.advance({
    geometry: "grown", destinationDistancePx: 700, physicalDistancePx: 700, behavior: "smooth",
  }), { type: "complete" });
});

test("a resized target is revalidated even when the old destination has just been reached", () => {
  const transaction = new NativeTargetPositionTransaction();
  transaction.advance({ geometry: "a", destinationDistancePx: 200, physicalDistancePx: 400, behavior: "smooth" });
  assert.deepEqual(transaction.advance({
    geometry: "b", destinationDistancePx: 300, physicalDistancePx: 200, behavior: "smooth",
  }), { type: "write", distancePx: 300, behavior: "instant" });
});

test("stream growth during native motion publishes geometry and allows a final target correction", () => {
  const owner = new NativeConversationViewportOwner({ initialDistanceFromBottomPx: 0 });
  const writes: { topOffsetPx: number; animated: boolean }[] = [];
  owner.attachScrollWriter((command) => writes.push(command));
  owner.reportPlatformScroll({ contentHeightPx: 2000, viewportHeightPx: 600, topOffsetPx: 500 });
  const transaction = new NativeTargetPositionTransaction();
  const advance = (geometry: string, destinationDistancePx: number) => transaction.advance({
    geometry, destinationDistancePx,
    physicalDistancePx: owner.scrollController.getLastScrollDistanceFromBottomPx(), behavior: "smooth",
  });
  const start = advance("original", 500);
  assert.equal(start.type, "write");
  if (start.type === "write") owner.writeDistanceFromBottomPx(start.distancePx, start.behavior);
  owner.commitContentGeometry(2200, () => null);
  assert.equal(owner.scrollController.getLastScrollDistanceFromBottomPx(), 1100);
  const corrected = advance("stream-grown", 700);
  assert.equal(corrected.type, "write");
  if (corrected.type === "write") owner.writeDistanceFromBottomPx(corrected.distancePx, corrected.behavior);
  assert.deepEqual(writes, [{ topOffsetPx: 900, animated: true }, { topOffsetPx: 900, animated: false }]);
  owner.reportPlatformScroll({ contentHeightPx: 2200, viewportHeightPx: 600, topOffsetPx: 900 });
  assert.deepEqual(advance("stream-grown", 700), { type: "complete" });
  owner.dispose();
});
