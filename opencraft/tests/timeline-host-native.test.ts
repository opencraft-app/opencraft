import assert from "node:assert/strict";
import test from "node:test";

import {
  NativeConversationViewportOwner,
  type NativeScrollCommand,
} from "@opencraft/timeline-host-native";

test("native viewport owner distinguishes its own write from active momentum", () => {
  let now = 0;
  const writes: number[] = [];
  const owner = new NativeConversationViewportOwner({
    initialDistanceFromBottomPx: 400,
    now: () => now,
    requestFrame: () => 1,
    cancelFrame: () => undefined,
  });
  owner.attachScrollWriter(({ topOffsetPx }) => writes.push(topOffsetPx));
  owner.reportPlatformScroll({ contentHeightPx: 2_000, viewportHeightPx: 600, topOffsetPx: 1_000 });
  owner.beginMomentum();

  owner.writeDistanceFromBottomPx(0);
  assert.deepEqual(writes, [1_400]);
  assert.equal(owner.reportPlatformScroll({
    contentHeightPx: 2_000,
    viewportHeightPx: 600,
    topOffsetPx: 1_400,
  }), "system");

  now += 16;
  assert.equal(owner.reportPlatformScroll({
    contentHeightPx: 2_000,
    viewportHeightPx: 600,
    topOffsetPx: 1_320,
  }), "user");
  owner.dispose();
});

test("native viewport owner owns composer padding compensation", () => {
  const writes: number[] = [];
  const owner = new NativeConversationViewportOwner({
    initialDistanceFromBottomPx: 300,
    requestFrame: () => 1,
    cancelFrame: () => undefined,
  });
  owner.attachScrollWriter(({ topOffsetPx }) => writes.push(topOffsetPx));
  owner.reportPlatformScroll({ contentHeightPx: 2_000, viewportHeightPx: 600, topOffsetPx: 1_100 });
  owner.reportFooterScrollPadding(100);
  owner.reportFooterScrollPadding(140);

  assert.equal(owner.scrollController.getLastScrollDistanceFromBottomPx(), 300);
  assert.deepEqual(writes, []);
  owner.reportContentHeight(2_040);
  const requestedDistance = owner.consumePendingGeometryDistanceFromBottomPx();
  assert.equal(requestedDistance, 340);
  owner.writeDistanceFromBottomPx(requestedDistance!);
  assert.deepEqual(writes, [1_100]);
  owner.dispose();
});

test("native viewport owner gives one policy target precedence per geometry commit", () => {
  const owner = new NativeConversationViewportOwner({
    initialDistanceFromBottomPx: 120,
    requestFrame: () => 1,
    cancelFrame: () => undefined,
  });
  owner.reportFooterScrollPadding(80);
  owner.reportFooterScrollPadding(120);
  owner.requestDistanceAfterNextGeometry(0);

  assert.equal(owner.consumePendingGeometryDistanceFromBottomPx(), 0);
  assert.equal(owner.consumePendingGeometryDistanceFromBottomPx(), null);
  owner.dispose();
});

test("native content geometry commit performs at most one merged physical write", () => {
  const writes: NativeScrollCommand[] = [];
  const owner = new NativeConversationViewportOwner({
    initialDistanceFromBottomPx: 200,
    requestFrame: () => 1,
    cancelFrame: () => undefined,
  });
  owner.attachScrollWriter((command) => writes.push(command));
  owner.reportViewportHeight(600);
  owner.reportFooterScrollPadding(80);
  owner.reportFooterScrollPadding(120);

  const applied = owner.commitContentGeometry(
    2_000,
    ({ inheritedDistanceFromBottomPx, metrics }) => {
      assert.equal(metrics.scrollHeightPx, 2_000);
      assert.equal(inheritedDistanceFromBottomPx, 240);
      return 0;
    },
  );

  assert.equal(applied, 0);
  assert.deepEqual(writes, [{ topOffsetPx: 1_400, animated: false }]);
  assert.equal(owner.consumePendingGeometryDistanceFromBottomPx(), null);
  owner.dispose();
});

test("native viewport owner invalidates stale callbacks on disposal", () => {
  const owner = new NativeConversationViewportOwner({
    initialDistanceFromBottomPx: 0,
    requestFrame: () => 1,
    cancelFrame: () => undefined,
  });
  const generation = owner.generation;
  assert.equal(owner.isCurrentGeneration(generation), true);
  owner.dispose();
  assert.equal(owner.isCurrentGeneration(generation), false);
});
