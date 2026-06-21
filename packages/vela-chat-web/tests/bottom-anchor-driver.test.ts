import assert from "node:assert/strict";
import test from "node:test";

type DriverModule = typeof import("../src/conversation-runtime/scroll/bottomAnchorDriver");

async function loadDriverModule(): Promise<DriverModule> {
  const loaded = await import("../src/conversation-runtime/scroll/bottomAnchorDriver").catch(
    () => null,
  );
  assert.notEqual(loaded, null, "bottomAnchorDriver module should exist");
  return loaded as DriverModule;
}

function createScheduler() {
  const frames: Array<() => void> = [];
  return {
    scheduleFrame(callback: () => void) {
      frames.push(callback);
      return callback;
    },
    cancelFrame(handle: unknown) {
      const index = frames.indexOf(handle as () => void);
      if (index >= 0) frames.splice(index, 1);
    },
    flushOne() {
      const next = frames.shift();
      next?.();
    },
    flushAll() {
      while (frames.length > 0) this.flushOne();
    },
  };
}

function createHarness() {
  return loadDriverModule().then(({ createBottomAnchorDriver }) => {
    const scheduler = createScheduler();
    const scrollReasons: string[] = [];
    const measurement = {
      containerKey: "web-scroll",
      viewportMeasuredForKey: "web-scroll",
      contentMeasuredForKey: "web-scroll",
      viewportWidth: 900,
      viewportHeight: 500,
      contentHeight: 1200,
      scrollTop: 700,
      bottomInsetPx: 0,
    };
    let historyReady = true;
    let nearBottom = true;
    const driver = createBottomAnchorDriver({
      getIsAuthoritativeHistoryReady: () => historyReady,
      getMeasurementState: () => measurement,
      isNearBottom: () => nearBottom,
      scrollToBottom: ({ reason }) => {
        scrollReasons.push(reason);
        measurement.scrollTop = Math.max(0, measurement.contentHeight - measurement.viewportHeight);
        nearBottom = true;
      },
      scheduleFrame: ({ callback }) => scheduler.scheduleFrame(callback),
      cancelFrame: (handle) => scheduler.cancelFrame(handle),
    });
    return {
      driver,
      measurement,
      scheduler,
      scrollReasons,
      setHistoryReady(value: boolean) {
        historyReady = value;
      },
      setNearBottom(value: boolean) {
        nearBottom = value;
      },
    };
  });
}

test("bottom anchor driver treats message sent as a sticky local request", async () => {
  const harness = await createHarness();

  harness.driver.detachByUser("user_scroll");
  harness.driver.requestLocalAnchor({
    reason: "message_sent",
    requestKey: "message:1",
  });
  harness.scheduler.flushAll();

  assert.deepEqual(harness.scrollReasons, ["message_sent"]);
  assert.equal(harness.driver.getSnapshot().mode, "sticky_bottom");
  assert.equal(harness.driver.getSnapshot().lastFulfilledReason, "message_sent");
});

test("bottom anchor driver keeps streaming growth sticky until verified", async () => {
  const harness = await createHarness();
  harness.setNearBottom(false);

  harness.driver.handleContentSizeChange({
    previousContentHeight: 1200,
    contentHeight: 1500,
  });
  harness.scheduler.flushAll();

  assert.ok(harness.scrollReasons.includes("content_mutated"));
  assert.equal(harness.driver.getSnapshot().mode, "sticky_bottom");
  assert.equal(harness.driver.getSnapshot().pendingRequest, null);
});

test("bottom anchor driver suppresses auto anchoring while detached", async () => {
  const harness = await createHarness();

  harness.driver.detachByUser("user_scroll");
  harness.driver.handleViewportMetricsChange({
    previousViewportWidth: 900,
    viewportWidth: 700,
    previousViewportHeight: 500,
    viewportHeight: 420,
  });
  harness.driver.handleContentSizeChange({
    previousContentHeight: 1200,
    contentHeight: 1500,
  });
  harness.scheduler.flushAll();

  assert.deepEqual(harness.scrollReasons, []);
  assert.equal(harness.driver.getSnapshot().mode, "detached");
});

test("bottom anchor driver blocks route requests on stale measurements", async () => {
  const harness = await createHarness();
  harness.measurement.containerKey = "web-partial-virtualized";
  harness.measurement.viewportMeasuredForKey = "web-scroll";
  harness.measurement.contentMeasuredForKey = "web-scroll";

  harness.driver.applyRouteRequest({
    reason: "route_resume",
    requestKey: "session:1:resume",
  });
  harness.scheduler.flushAll();

  assert.equal(harness.scrollReasons.length, 0);
  assert.equal(
    harness.driver.getSnapshot().blockedReason,
    "waiting_for_measurable_viewport",
  );

  harness.measurement.viewportMeasuredForKey = "web-partial-virtualized";
  harness.measurement.contentMeasuredForKey = "web-partial-virtualized";
  harness.driver.reevaluate();
  harness.scheduler.flushAll();

  assert.deepEqual(harness.scrollReasons, ["route_resume"]);
});

test("bottom anchor driver detaches only for explicit user scroll away", async () => {
  const harness = await createHarness();
  harness.setNearBottom(false);

  harness.driver.handleScrollNearBottomChange({
    nextIsNearBottom: false,
    scrollDelta: -80,
    userIntent: "none",
  });
  assert.equal(harness.driver.getSnapshot().mode, "sticky_bottom");

  harness.driver.handleScrollNearBottomChange({
    nextIsNearBottom: false,
    scrollDelta: -80,
    userIntent: "scroll_up",
  });
  assert.equal(harness.driver.getSnapshot().mode, "detached");
  assert.equal(harness.driver.getSnapshot().detachReason, "user_scroll");
});
