import assert from "node:assert/strict";
import test from "node:test";

import {
  NativeConversationViewportOwner,
  NativeTurnMeasurementRegistry,
  nativeFollowContentOverflowPx,
  type NativeScrollCommand,
} from "@opencraft/timeline-host-native";

test("viewport resize publishes the same geometry to the scroll controller without a scroll event", () => {
  const owner = new NativeConversationViewportOwner({
    initialDistanceFromBottomPx: 0, requestFrame: () => 1, cancelFrame: () => undefined,
  });
  const writes: NativeScrollCommand[] = [];
  owner.attachScrollWriter((command) => writes.push(command));
  owner.reportPlatformScroll({ contentHeightPx: 2000, viewportHeightPx: 600, topOffsetPx: 900 });
  owner.reportViewportHeight(900);
  assert.equal(owner.getMetrics().distanceFromBottomPx, 200);
  assert.equal(owner.scrollController.getLastScrollDistanceFromBottomPx(), 200);
  assert.deepEqual(writes, []);
  owner.dispose();
});

test("geometry publication leaves pending content preservation for its own commit", () => {
  const owner = new NativeConversationViewportOwner({
    initialDistanceFromBottomPx: 0, requestFrame: () => 1, cancelFrame: () => undefined,
  });
  const writes: NativeScrollCommand[] = [];
  owner.attachScrollWriter((command) => writes.push(command));
  owner.reportPlatformScroll({ contentHeightPx: 2000, viewportHeightPx: 600, topOffsetPx: 900 });
  owner.scrollController.preserveScrollPositionForNextLayout();
  owner.reportContentHeight(2300);
  owner.reportViewportHeight(900);
  assert.deepEqual(writes, []);
  owner.reportPlatformScroll({ contentHeightPx: 2300, viewportHeightPx: 900, topOffsetPx: 900 });
  assert.deepEqual(writes, [{ topOffsetPx: 900, animated: false }]);
  assert.equal(owner.scrollController.getLastScrollDistanceFromBottomPx(), 500);
  owner.dispose();
});

test("native virtual turn measurements accept only the current mounted row", () => {
  const registry = new NativeTurnMeasurementRegistry();
  const first = registry.register("turn-a");
  assert.equal(registry.isCurrent(first), true);
  const queuedFirst = { lease: first, heightPx: 700 };

  assert.equal(registry.retire(first), true);
  assert.equal(registry.isCurrent(first), false);
  const replacement = registry.register("turn-a");
  const queuedReplacement = { lease: replacement, heightPx: 350 };
  assert.equal(registry.isCurrent(first), false);
  assert.equal(registry.isCurrent(replacement), true);
  assert.deepEqual(
    registry.filterCurrent([queuedFirst, queuedReplacement]),
    [queuedReplacement],
  );
  assert.equal(registry.retire(first), false);
  assert.equal(registry.isCurrent(replacement), true);

  registry.clear();
  assert.equal(registry.isCurrent(replacement), false);
});

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

test("smooth native positioning waits for observed physical scroll before settling", () => {
  const commands: NativeScrollCommand[] = [];
  const owner = new NativeConversationViewportOwner({
    initialDistanceFromBottomPx: 400,
    requestFrame: () => 1,
    cancelFrame: () => undefined,
  });
  owner.attachScrollWriter((command) => commands.push(command));
  owner.reportPlatformScroll({ contentHeightPx: 2_000, viewportHeightPx: 600, topOffsetPx: 1_000 });
  const observed: number[] = [];
  const unsubscribe = owner.scrollController.subscribe((snapshot) => {
    observed.push(snapshot.distanceFromBottomPx);
  });
  owner.writeDistanceFromBottomPx(0, "smooth");
  assert.deepEqual(commands, [{ topOffsetPx: 1_400, animated: true }]);
  assert.equal(owner.scrollController.getLastScrollDistanceFromBottomPx(), 400);
  owner.reportPlatformScroll({ contentHeightPx: 2_000, viewportHeightPx: 600, topOffsetPx: 1_200 });
  assert.equal(owner.scrollController.getLastScrollDistanceFromBottomPx(), 200);
  owner.reportPlatformScroll({ contentHeightPx: 2_000, viewportHeightPx: 600, topOffsetPx: 1_400 });
  assert.equal(owner.scrollController.getLastScrollDistanceFromBottomPx(), 0);
  assert.deepEqual(observed, [400, 400, 200, 0]);
  unsubscribe();
  owner.dispose();
});

test("native follow boundary includes the virtualizer's measured container offset", () => {
  assert.equal(nativeFollowContentOverflowPx({
    virtualizerTopPx: 36,
    latestTurnTopPx: 500,
    contentBottomWithinTurnPx: 260,
    viewportTopPx: 100,
    viewportHeightPx: 700,
    footerPaddingPx: 20,
  }), 16);
});

test("touch down interrupts native auto-scroll before drag without claiming a scroll gesture", () => {
  let nextFrame = 0;
  const cancelled: number[] = [];
  let takeovers = 0;
  const owner = new NativeConversationViewportOwner({
    initialDistanceFromBottomPx: 400,
    now: () => 1_000,
    requestFrame: () => ++nextFrame,
    cancelFrame: frame => { cancelled.push(frame); },
  });
  owner.reportPlatformScroll({ contentHeightPx: 2_000, viewportHeightPx: 600, topOffsetPx: 1_000 });
  owner.setUserInputListener(() => { takeovers++; });
  owner.scrollController.scrollToBottom();
  assert.equal(owner.scrollController.getSnapshot().isScrollAnimationActive, true);

  owner.noteUserTouch();
  owner.noteUserTouch();
  assert.equal(owner.scrollController.getSnapshot().isScrollAnimationActive, false);
  assert.deepEqual(cancelled, [1]);
  assert.equal(takeovers, 1);
  assert.equal(owner.reportPlatformScroll({ contentHeightPx: 2_000, viewportHeightPx: 600, topOffsetPx: 990 }), "system");

  owner.beginUserGesture();
  assert.equal(takeovers, 1);
  assert.equal(owner.reportPlatformScroll({ contentHeightPx: 2_000, viewportHeightPx: 600, topOffsetPx: 950 }), "user");
  owner.endUserGesture();
  owner.noteUserTouch();
  assert.equal(takeovers, 2);
  owner.endUserTouch();
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

test("native geometry commit moves the physical offset after a history prepend", () => {
  const writes: NativeScrollCommand[] = [];
  const owner = new NativeConversationViewportOwner({ initialDistanceFromBottomPx: 100 });
  owner.attachScrollWriter((command) => writes.push(command));
  owner.reportPlatformScroll({ contentHeightPx: 1_000, viewportHeightPx: 400, topOffsetPx: 500 });
  owner.requestDistanceAfterNextGeometry(100);
  const applied = owner.commitContentGeometry(1_300, ({ inheritedDistanceFromBottomPx }) => inheritedDistanceFromBottomPx);
  assert.equal(applied, 100);
  assert.deepEqual(writes, [{ topOffsetPx: 800, animated: false }]);
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
