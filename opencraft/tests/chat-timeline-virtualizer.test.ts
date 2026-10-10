import assert from "node:assert/strict";
import test from "node:test";

import {
  anchorRange,
  buildTurnLayout,
  buildTimelineLayout,
  calculateSoftwareKeyboardInset,
  CODEX_LATEST_TURN_PLACEMENT_SPRING,
  CODEX_TURN_VIRTUALIZER_CONFIG,
  compensateDistanceFromBottom,
  computeTurnRange,
  computeTurnViewportBounds,
  createInitialTurnFollowState,
  createLatestTurnPlacementSnapshot,
  createTurnMeasurementTransaction,
  createTurnRestoreState,
  createTurnFollowState,
  createTurnViewportState,
  createTurnWindowSlice,
  createTimelineViewportState,
  createTimelineWindowSlice,
  distanceFromBottomToCenterTurn,
  distanceAfterUnplacedLatestTurnContentResize,
  distanceFromBottomToTargetWithinTurn,
  distanceFromBottomToTopTurn,
  findMeasuredViewportAnchor,
  getTurnGeometry,
  normalizeTurnViewportMetrics,
  normalizeInvertedWebViewportMetrics,
  invertedWebScrollTopForDistance,
  normalizeInitialScrollDistance,
  normalizeWheelDeltaPx,
  reconcileRenderedRangeForEntries,
  reconcileTurnLayoutViewport,
  rekeyTurnMeasurements,
  keyboardScrollDirection,
  directionForTouchDelta,
  distanceExcludingBottomPadding,
  isAtVirtualizedBottom,
  isViewportPreservingTurnFollowMode,
  shouldLoadOlderHistory,
  shouldPlaceLatestTurnFromPendingSubmit,
  shouldShowScrollToBottomAction,
  scrollToBottomDistanceAtTime,
  footerResizeCompensation,
  footerScrollPaddingPx,
  maximumResponseSpacerHeightPx,
  normalizeFollowRestorePosition,
  reduceTurnFollowState,
  reduceTurnRestoreState,
  responseSpacerOverflowPx,
  resolveTimelineViewportPolicy,
  serializeTurnRestoreState,
  shouldFollowLatestTurn,
  topOffsetForDistanceFromBottom,
  timelineWideContentOffset,
  TurnHistoryBackfillCoordinator,
  updateTurnViewportState,
  type VirtualizedTurnEntry,
  TurnScrollController,
  TurnResponsePositioningController,
  TIMELINE_VIRTUALIZER_CONFIG,
} from "@opencraft/timeline-virtualizer";

test("history backfill drains pages until the viewport becomes scrollable", async () => {
  let scrollHeightPx = 300;
  let pageCount = 0;
  let layoutBarrierCount = 0;
  const coordinator = new TurnHistoryBackfillCoordinator({
    isEnabled: () => true,
    readMetrics: () => ({
      distanceFromBottomPx: 0,
      viewportHeightPx: 600,
      scrollHeightPx,
    }),
    loadPage: () => {
      pageCount += 1;
      scrollHeightPx += 250;
    },
    afterLayout: async () => {
      layoutBarrierCount += 1;
    },
  });

  await coordinator.request();
  assert.equal(pageCount, 2);
  assert.equal(layoutBarrierCount, 2);
  assert.equal(scrollHeightPx, 800);
});

test("history backfill is single-flight within one layout generation", async () => {
  let releasePage!: () => void;
  let pageCount = 0;
  const page = new Promise<void>((resolve) => { releasePage = resolve; });
  const coordinator = new TurnHistoryBackfillCoordinator({
    isEnabled: () => true,
    readMetrics: () => ({ distanceFromBottomPx: 0, viewportHeightPx: 600, scrollHeightPx: 300 }),
    loadPage: async () => {
      pageCount += 1;
      await page;
      return "stop";
    },
    afterLayout: async () => undefined,
  });

  const first = coordinator.request();
  const second = coordinator.request();
  assert.equal(first, second);
  assert.equal(pageCount, 1);
  releasePage();
  await Promise.all([first, second]);
  assert.equal(pageCount, 1);
});

test("history backfill stops when a page produces no new layout", async () => {
  let pageCount = 0;
  const coordinator = new TurnHistoryBackfillCoordinator({
    isEnabled: () => true,
    readMetrics: () => ({ distanceFromBottomPx: 0, viewportHeightPx: 600, scrollHeightPx: 300 }),
    loadPage: () => { pageCount += 1; },
    afterLayout: async () => undefined,
  });

  await coordinator.request();
  assert.equal(pageCount, 1);
});

test("a new history generation waits for the stale load instead of overlapping it", async () => {
  let releaseFirst!: () => void;
  let loadCount = 0;
  let concurrentLoads = 0;
  let maximumConcurrentLoads = 0;
  const firstPage = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const coordinator = new TurnHistoryBackfillCoordinator({
    isEnabled: () => true,
    readMetrics: () => ({ distanceFromBottomPx: 0, viewportHeightPx: 600, scrollHeightPx: 300 }),
    loadPage: async () => {
      loadCount += 1;
      concurrentLoads += 1;
      maximumConcurrentLoads = Math.max(maximumConcurrentLoads, concurrentLoads);
      if (loadCount === 1) await firstPage;
      concurrentLoads -= 1;
      return "stop";
    },
    afterLayout: async () => undefined,
  });

  const stale = coordinator.request();
  coordinator.invalidate();
  const current = coordinator.request();
  assert.equal(loadCount, 1);
  releaseFirst();
  await Promise.all([stale, current]);
  assert.equal(loadCount, 2);
  assert.equal(maximumConcurrentLoads, 1);
});

test("history backfill contains recoverable page failures", async () => {
  const failures: unknown[] = [];
  const expected = new Error("offline");
  const coordinator = new TurnHistoryBackfillCoordinator({
    isEnabled: () => true,
    readMetrics: () => ({ distanceFromBottomPx: 0, viewportHeightPx: 600, scrollHeightPx: 300 }),
    loadPage: () => { throw expected; },
    afterLayout: async () => undefined,
    onError: (error) => failures.push(error),
  });

  await coordinator.request();
  assert.deepEqual(failures, [expected]);
});

const turns = (count: number, height = 100): readonly VirtualizedTurnEntry[] =>
  Array.from({ length: count }, (_, index) => ({
    turnKey: `turn-${index}`,
    estimatedHeightPx: height,
  }));

const config = {
  ...CODEX_TURN_VIRTUALIZER_CONFIG,
  gapPx: 0,
  overscanTurnCount: 0,
};

test("domain-neutral Timeline geometry has no public Turn configuration", () => {
  const entries = [
    { timelineKey: "message:a", estimatedHeightPx: 80 },
    { timelineKey: "execution:b", estimatedHeightPx: 32 },
  ];
  const timelineConfig = {
    ...TIMELINE_VIRTUALIZER_CONFIG,
    gapPx: 4,
    overscanEntryCount: 0,
  };
  const layout = buildTimelineLayout(entries, {}, timelineConfig);
  const viewport = createTimelineViewportState(layout, 0, 40, timelineConfig);
  const window = createTimelineWindowSlice(
    entries,
    layout,
    viewport.renderedRange,
    timelineConfig.gapPx,
  );

  assert.deepEqual(layout.entryKeys, ["message:a", "execution:b"]);
  assert.equal("estimatedTurnHeightPx" in TIMELINE_VIRTUALIZER_CONFIG, false);
  assert.equal(window.entries.at(-1)?.timelineKey, "execution:b");
});

test("Codex Turn layout uses chronological top offsets and inverted bottom offsets", () => {
  const layout = buildTurnLayout(turns(3), {}, config);
  assert.deepEqual(layout.topOffsetsPx, [0, 100, 200]);
  assert.deepEqual(layout.bottomOffsetsPx, [200, 100, 0]);
  assert.deepEqual(layout.heightsPx, [100, 100, 100]);
  assert.equal(layout.totalHeightPx, 300);
});

test("the latest Turn is selected at distanceFromBottom zero", () => {
  const layout = buildTurnLayout(turns(5), {}, config);
  assert.deepEqual(computeTurnRange(layout, 0, 100, 0), { startIndex: 4, endIndex: 5 });
  assert.deepEqual(computeTurnRange(layout, 100, 100, 0), { startIndex: 3, endIndex: 4 });
  assert.deepEqual(computeTurnRange(layout, 400, 100, 0), { startIndex: 0, endIndex: 1 });
});

test("Codex overscan is counted in Turns rather than pixels", () => {
  const layout = buildTurnLayout(turns(8), {}, config);
  assert.deepEqual(computeTurnRange(layout, 300, 100, 2), { startIndex: 2, endIndex: 7 });
});

test("measured heights override estimates while history gaps retain explicit estimates", () => {
  const entries: readonly VirtualizedTurnEntry[] = [
    { turnKey: "history-gap", estimatedHeightPx: 640 },
    { turnKey: "turn-a", estimatedHeightPx: 180 },
  ];
  const layout = buildTurnLayout(entries, { "turn-a": 312 }, config);
  assert.deepEqual(layout.heightsPx, [640, 312]);
  assert.equal(layout.totalHeightPx, 952);
});

test("unknown Turn heights use the recovered Codex 280px estimate", () => {
  const layout = buildTurnLayout([{ turnKey: "unknown" }]);
  assert.equal(layout.heightsPx[0], 280);
});

test("duplicate Turn identity matches Codex layout semantics by retaining the last index", () => {
  const layout = buildTurnLayout([{ turnKey: "same" }, { turnKey: "same" }]);
  assert.deepEqual(layout.turnKeys, ["same", "same"]);
  assert.equal(layout.turnIndexByKey.get("same"), 1);
});

test("an existing rendered range is restored from its stable anchor key", () => {
  const layout = buildTurnLayout(turns(10), {}, config);
  assert.deepEqual(
    anchorRange(layout, "turn-4", { startIndex: 0, endIndex: 4 }),
    { startIndex: 4, endIndex: 8 },
  );
  assert.equal(anchorRange(layout, "removed", { startIndex: 0, endIndex: 4 }), null);
});

test("route restore retains measured heights and the rendered window", () => {
  const entries = turns(10);
  const layout = buildTurnLayout(entries, { "turn-4": 220, "turn-5": 240 }, config);
  const saved = serializeTurnRestoreState(
    { removed: 900, "turn-4": 220, "turn-5": 240 },
    layout.turnKeys,
    { startIndex: 4, endIndex: 7 },
  );
  assert.deepEqual(saved, {
    renderedWindow: { anchorKey: "turn-4", count: 3 },
    turnHeightsByKey: { "turn-4": 220, "turn-5": 240 },
  });

  const restored = createTurnViewportState(layout, 300, 100, saved, config);
  const visible = computeTurnRange(layout, 300, 100, config.overscanTurnCount);
  assert.ok(restored.renderedRange.startIndex <= visible.startIndex);
  assert.ok(restored.renderedRange.endIndex >= visible.endIndex);
});

test("restore never mounts a saved window that omits the current viewport", () => {
  const layout = buildTurnLayout(turns(40), {}, config);
  const restored = createTurnViewportState(layout, 0, 100, {
    renderedWindow: { anchorKey: "turn-5", count: 3 },
    turnHeightsByKey: { "turn-5": 100 },
  }, config);
  assert.deepEqual(restored.renderedRange, computeTurnRange(layout, 0, 100, config.overscanTurnCount));
  assert.equal(createTurnWindowSlice(turns(40), layout, restored.renderedRange).entries.at(-1)?.turnKey, "turn-39");
});

test("prepending hydrated history preserves the measured viewport anchor", () => {
  const previousEntries = turns(4);
  const nextEntries = [
    { turnKey: "older-0", estimatedHeightPx: 300 },
    { turnKey: "older-1", estimatedHeightPx: 300 },
    ...previousEntries,
  ];
  const measurements = { "turn-1": 100, "turn-2": 100 };
  const previousLayout = buildTurnLayout(previousEntries, measurements, config);
  const nextLayout = buildTurnLayout(nextEntries, measurements, config);
  const anchor = findMeasuredViewportAnchor(previousLayout, nextLayout, measurements, 100, 100);
  assert.equal(anchor, "turn-2");
  assert.equal(compensateDistanceFromBottom(anchor!, 100, previousLayout, nextLayout), 100);
});

test("entry-layout reconciliation has one fenced virtualizer-owned correction", () => {
  const previousEntries = turns(3);
  const measurements = { "turn-1": 100 };
  const previousLayout = buildTurnLayout(previousEntries, measurements, config);
  const nextLayout = buildTurnLayout([
    ...previousEntries,
    { turnKey: "turn-3", estimatedHeightPx: 100 },
  ], measurements, config);
  const options = {
    previousLayout,
    nextLayout,
    measuredHeightsByKey: measurements,
    currentDistanceFromBottomPx: 100,
    viewportHeightPx: 100,
    bottomPaddingPx: 0,
    preserveViewport: true,
    layoutOwnedByMeasurement: false,
    restorePending: false,
  };
  assert.equal(reconcileTurnLayoutViewport(options), 200);
  assert.equal(reconcileTurnLayoutViewport({ ...options, currentDistanceFromBottomPx: 0 }), null);
  assert.equal(reconcileTurnLayoutViewport({ ...options, layoutOwnedByMeasurement: true }), null);
  assert.equal(reconcileTurnLayoutViewport({ ...options, restorePending: true }), null);
  assert.equal(reconcileTurnLayoutViewport({ ...options, preserveViewport: false }), null);
});

test("prepending above the viewport reapplies an unchanged bottom distance", () => {
  const previous = buildTurnLayout(turns(4), { "turn-2": 100 }, config);
  const next = buildTurnLayout([
    { turnKey: "older", estimatedHeightPx: 300 },
    ...turns(4),
  ], { "turn-2": 100 }, config);
  assert.equal(reconcileTurnLayoutViewport({
    previousLayout: previous,
    nextLayout: next,
    measuredHeightsByKey: { "turn-2": 100 },
    currentDistanceFromBottomPx: 100,
    viewportHeightPx: 100,
    bottomPaddingPx: 0,
    preserveViewport: true,
    layoutOwnedByMeasurement: false,
    restorePending: false,
  }), 100);
});

test("height changes below the anchor compensate distanceFromBottom", () => {
  const entries = turns(3);
  const previousLayout = buildTurnLayout(entries, {}, config);
  const nextLayout = buildTurnLayout(entries, { "turn-2": 180 }, config);
  assert.equal(compensateDistanceFromBottom("turn-1", 100, previousLayout, nextLayout), 180);
});

test("viewport updates retain a wider mounted range until it no longer contains visibility", () => {
  const layout = buildTurnLayout(turns(10), {}, config);
  const current = {
    distanceFromBottomPx: 300,
    viewportHeightPx: 100,
    renderedRange: { startIndex: 4, endIndex: 9 },
    turnKeys: layout.turnKeys,
  };
  const retained = updateTurnViewportState(current, layout, 200, 100, config);
  assert.deepEqual(retained.renderedRange, current.renderedRange);
  assert.equal(retained.distanceFromBottomPx, 200);
  assert.deepEqual(
    updateTurnViewportState(current, layout, 800, 100, config).renderedRange,
    { startIndex: 1, endIndex: 2 },
  );
});

test("target positioning uses viewport-relative top geometry instead of a content-origin estimate", () => {
  const layout = buildTurnLayout(turns(5), {}, config);
  assert.deepEqual(getTurnGeometry(layout, "turn-2"), { startPx: 200, endPx: 300 });
  assert.equal(distanceFromBottomToCenterTurn(layout, "turn-2", 300), 100);
  assert.equal(distanceFromBottomToTopTurn({
    layout,
    turnKey: "turn-2",
    viewportHeightPx: 200,
  }), 110);
});

test("the platform renderer receives only the current slice and full-height placement", () => {
  const entries = turns(6);
  const layout = buildTurnLayout(entries, {}, config);
  const slice = createTurnWindowSlice(entries, layout, { startIndex: 2, endIndex: 5 }, 0);
  assert.deepEqual(slice.entries.map((entry) => entry.turnKey), ["turn-2", "turn-3", "turn-4"]);
  assert.equal(slice.marginTopPx, 200);
  assert.equal(slice.totalHeightPx, 600);
});

test("only an explicit composer submit snapshot places a changed latest Turn", () => {
  assert.equal(shouldPlaceLatestTurnFromPendingSubmit(null), false);
  assert.equal(shouldPlaceLatestTurnFromPendingSubmit({
    distanceFromBottomPx: 24,
    scrollHeightPx: 2_000,
    shouldPlaceLatestTurn: true,
  }), true);
  assert.equal(shouldPlaceLatestTurnFromPendingSubmit({
    distanceFromBottomPx: 800,
    scrollHeightPx: 2_000,
    shouldPlaceLatestTurn: false,
  }), false);
});

test("an unplaced latest Turn preserves position across signed content resize", () => {
  const placement = createLatestTurnPlacementSnapshot({
    distanceFromBottomPx: 500,
    responseSpacerHeightPx: 100,
    scrollHeightPx: 2_000,
  });
  assert.equal(distanceAfterUnplacedLatestTurnContentResize({
    nextScrollHeightPx: 2_120,
    placement,
  }), 620);
  assert.equal(distanceAfterUnplacedLatestTurnContentResize({
    nextScrollHeightPx: 1_850,
    placement,
  }), 350);
});

test("a ResizeObserver batch commits height table, layout, window and scroll as one transaction", () => {
  const entries = turns(4);
  const previousLayout = buildTurnLayout(entries, {}, config);
  const viewport = createTurnViewportState(previousLayout, 100, 100, null, config);
  const transaction = createTurnMeasurementTransaction({
    entries,
    measurements: [{ turnKey: "turn-3", heightPx: 260 }],
    measuredHeightsByKey: {},
    layout: previousLayout,
    viewport,
    currentDistanceFromBottomPx: 100,
    bottomPaddingPx: 0,
    preserveMeasuredTurnViewport: true,
    getPendingRestoreScrollDistanceFromBottomPx: null,
    config,
  });
  assert.ok(transaction);
  assert.equal(transaction.measuredHeightsByKey["turn-3"], 260);
  assert.equal(transaction.layout.heightsPx[3], 260);
  assert.equal(transaction.scrollDistanceFromBottomPx, 260);
  assert.equal(transaction.viewport.distanceFromBottomPx, 260);
  assert.equal(transaction.latestTurnHeightChange?.heightDeltaPx, 0);
});

test("folding a measured visible Turn keeps its top offset and visible range", () => {
  const entries = turns(4);
  const measured = { "turn-2": 500 };
  const previous = buildTurnLayout(entries, measured, config);
  const viewport = createTurnViewportState(previous, 500, 100, null, config);
  const transaction = createTurnMeasurementTransaction({
    entries,
    measurements: [{ turnKey: "turn-2", heightPx: 300 }],
    measuredHeightsByKey: measured,
    layout: previous,
    viewport,
    currentDistanceFromBottomPx: 500,
    bottomPaddingPx: 0,
    preserveMeasuredTurnViewport: true,
    getPendingRestoreScrollDistanceFromBottomPx: null,
    config,
  });
  assert.ok(transaction);
  assert.equal(transaction.scrollDistanceFromBottomPx, 300);
  assert.equal(previous.totalHeightPx - 100 - 500, transaction.layout.totalHeightPx - 100 - 300);
  const visible = computeTurnRange(transaction.layout, 300, 100, 0);
  assert.ok(transaction.viewport.renderedRange.startIndex <= visible.startIndex);
  assert.ok(transaction.viewport.renderedRange.endIndex >= visible.endIndex);
});

test("latest-Turn single measurement has the synchronous DOM-height fast path at bottom", () => {
  const entries = turns(2);
  const previousLayout = buildTurnLayout(entries, {}, config);
  const viewport = createTurnViewportState(previousLayout, 0, 100, null, config);
  const transaction = createTurnMeasurementTransaction({
    entries,
    measurements: [{ turnKey: "turn-1", heightPx: 340 }],
    measuredHeightsByKey: {},
    layout: previousLayout,
    viewport,
    currentDistanceFromBottomPx: 0,
    bottomPaddingPx: 0,
    preserveMeasuredTurnViewport: true,
    getPendingRestoreScrollDistanceFromBottomPx: null,
    config,
  });
  assert.ok(transaction);
  assert.equal(transaction.scrollDistanceFromBottomPx, 0);
  assert.equal(transaction.canUseLatestTurnFastPath, true);
  assert.equal(transaction.preservePlatformScrollForNextLayout, false);
});

test("route restoration is explicit, measurement-adjustable, and permanently yields to the user", () => {
  let state = createTurnRestoreState(800);
  let transition = reduceTurnRestoreState(state, {
    type: "height_delta_below_viewport",
    heightDeltaPx: 120,
  });
  state = transition.state;
  assert.deepEqual(state, { phase: "pending", distanceFromBottomPx: 920, attempts: 0 });

  transition = reduceTurnRestoreState(state, { type: "attempt", observedDistanceFromBottomPx: 0 });
  state = transition.state;
  assert.equal(transition.scrollToDistanceFromBottomPx, 920);
  assert.equal(state.phase, "pending");

  transition = reduceTurnRestoreState(state, { type: "user_takeover" });
  state = transition.state;
  assert.deepEqual(state, { phase: "settled", reason: "user-takeover" });
  assert.equal(
    reduceTurnRestoreState(state, { type: "attempt", observedDistanceFromBottomPx: 0 }).scrollToDistanceFromBottomPx,
    null,
  );
});

test("Web scrollTop and React Native contentOffset normalize to one coordinate", () => {
  assert.deepEqual(
    normalizeTurnViewportMetrics({ contentHeightPx: 2_000, viewportHeightPx: 600, topOffsetPx: 1_250 }),
    { distanceFromBottomPx: 150, viewportHeightPx: 600, scrollHeightPx: 2_000 },
  );
  assert.equal(topOffsetForDistanceFromBottom(2_000, 600, 150), 1_250);
  assert.equal(topOffsetForDistanceFromBottom(2_000, 600, 9_000), 0);
  assert.deepEqual(
    normalizeInvertedWebViewportMetrics({ contentHeightPx: 2_000, viewportHeightPx: 600, scrollTopPx: -150 }),
    { distanceFromBottomPx: 150, viewportHeightPx: 600, scrollHeightPx: 2_000 },
  );
  assert.equal(invertedWebScrollTopForDistance(150), -150);
});

test("viewport policy keeps host mechanics outside the shared scroll state machine", () => {
  assert.deepEqual(resolveTimelineViewportPolicy({ kind: "electron", platform: "darwin" }), {
    lockRootScroll: true,
    threadOverscroll: "auto",
    localElasticEffect: true,
    tracksVisualViewport: false,
  });
  assert.deepEqual(resolveTimelineViewportPolicy({ kind: "browser", platform: "ios" }), {
    lockRootScroll: true,
    threadOverscroll: "contain",
    localElasticEffect: true,
    tracksVisualViewport: true,
  });
  assert.equal(timelineWideContentOffset({ displayMode: "shift", panelWidthPx: 316, pinned: true }), -158);
  assert.equal(timelineWideContentOffset({ displayMode: "gutter", panelWidthPx: 316, pinned: true }), 0);
});

test("software keyboard inset excludes unfocused and pinch-zoomed visual viewports", () => {
  assert.equal(calculateSoftwareKeyboardInset({
    editableFocused: true,
    layoutViewportHeightPx: 1_024,
    scale: 1,
    visualOffsetTopPx: 0,
    visualViewportHeightPx: 640,
  }), 384);
  assert.equal(calculateSoftwareKeyboardInset({
    editableFocused: false,
    layoutViewportHeightPx: 1_024,
    scale: 1,
    visualOffsetTopPx: 0,
    visualViewportHeightPx: 640,
  }), 0);
  assert.equal(calculateSoftwareKeyboardInset({
    editableFocused: true,
    layoutViewportHeightPx: 1_024,
    scale: 1.5,
    visualOffsetTopPx: 80,
    visualViewportHeightPx: 640,
  }), 0);
});

test("ten thousand Turns retain a bounded mounted window", () => {
  const entries = turns(10_000, 96);
  const layout = buildTurnLayout(entries);
  const viewport = createTurnViewportState(layout, 400_000, 900);
  const slice = createTurnWindowSlice(entries, layout, viewport.renderedRange);
  assert.ok(slice.entries.length <= 16, `mounted ${slice.entries.length} Turns`);
  assert.equal(slice.totalHeightPx, 10_000 * 96 + 9_999 * CODEX_TURN_VIRTUALIZER_CONFIG.gapPx);
});

test("streaming growth below a measured viewport anchor preserves visible content", () => {
  const entries = turns(5);
  const measured = { "turn-2": 100 };
  const previous = buildTurnLayout(entries, measured, config);
  const next = buildTurnLayout(entries, { ...measured, "turn-4": 260 }, config);
  const anchor = findMeasuredViewportAnchor(previous, next, measured, 200, 100);
  assert.equal(anchor, "turn-2");
  assert.equal(compensateDistanceFromBottom(anchor!, 200, previous, next), 360);
});

test("prepending thousands of historical Turns keeps an existing anchor stationary", () => {
  const currentEntries = turns(100);
  const olderEntries = Array.from({ length: 2_000 }, (_, index) => ({
    turnKey: `older-${index}`,
    estimatedHeightPx: 80,
  }));
  const measurements = { "turn-40": 115, "turn-41": 105 };
  const previous = buildTurnLayout(currentEntries, measurements, config);
  const next = buildTurnLayout([...olderEntries, ...currentEntries], measurements, config);
  const distance = previous.bottomOffsetsPx[40] ?? 0;
  const anchor = findMeasuredViewportAnchor(previous, next, measurements, distance, 100);
  assert.equal(anchor, "turn-40");
  assert.equal(compensateDistanceFromBottom(anchor!, distance, previous, next), distance);
});

test("a prepended history page re-anchors the render window before viewport state commits", () => {
  const currentEntries = turns(10);
  const currentLayout = buildTurnLayout(currentEntries, {}, config);
  const currentViewport = {
    distanceFromBottomPx: 400,
    viewportHeightPx: 200,
    renderedRange: { startIndex: 3, endIndex: 8 },
    turnKeys: currentLayout.turnKeys,
  };
  const prepended = Array.from({ length: 2_000 }, (_, index) => ({
    turnKey: `older-${index}`,
    estimatedHeightPx: 100,
  }));
  const nextEntries = [...prepended, ...currentEntries];
  const nextLayout = buildTurnLayout(nextEntries, {}, config);

  // During this intermediate React render entries/layout are new, while the
  // committed viewport state still contains indices into the previous tree.
  const staleSlice = createTurnWindowSlice(
    nextEntries,
    nextLayout,
    currentViewport.renderedRange,
    0,
  );
  assert.equal(staleSlice.entries[0]?.turnKey, "older-3");

  const reconciled = reconcileRenderedRangeForEntries(currentViewport, nextLayout);
  const anchoredSlice = createTurnWindowSlice(nextEntries, nextLayout, reconciled, 0);
  assert.ok(reconciled.startIndex >= 2_000);
  assert.ok(anchoredSlice.entries.some((entry) => entry.turnKey === "turn-4"));
  assert.equal(anchoredSlice.marginTopPx, nextLayout.topOffsetsPx[reconciled.startIndex]);
});

test("a stale mounted range never hides the visible turn after folding or removal", () => {
  const entries = turns(10);
  const previous = buildTurnLayout(entries, { "turn-6": 800 }, config);
  const current = {
    distanceFromBottomPx: 350,
    viewportHeightPx: 100,
    renderedRange: { startIndex: 5, endIndex: 8 },
    turnKeys: previous.turnKeys,
  };
  const folded = buildTurnLayout(entries, { "turn-6": 1 }, config);
  const foldedRange = reconcileRenderedRangeForEntries(current, folded);
  const visibleAfterFold = computeTurnRange(folded, 350, 100);
  assert.ok(visibleAfterFold.startIndex < current.renderedRange.startIndex);
  assert.ok(foldedRange.startIndex <= visibleAfterFold.startIndex);
  assert.ok(foldedRange.endIndex >= visibleAfterFold.endIndex);

  const removedCurrent = {
    distanceFromBottomPx: 100,
    viewportHeightPx: 100,
    renderedRange: { startIndex: 7, endIndex: 10 },
    turnKeys: buildTurnLayout(entries, {}, config).turnKeys,
  };
  const removed = buildTurnLayout(entries.slice(0, 7), {}, config);
  const removedRange = reconcileRenderedRangeForEntries(removedCurrent, removed);
  const visibleAfterRemoval = computeTurnRange(removed, 100, 100);
  assert.ok(visibleAfterRemoval.startIndex < removedCurrent.renderedRange.startIndex);
  assert.ok(removedRange.startIndex <= visibleAfterRemoval.startIndex);
  assert.ok(removedRange.endIndex >= visibleAfterRemoval.endIndex);
});

test("hydration inside a mounted window preserves its last row before viewport commit", () => {
  const current = { distanceFromBottomPx: 0, viewportHeightPx: 1800,
    renderedRange: { startIndex: 0, endIndex: 4 }, turnKeys: ["older", "a", "c", "live"] };
  const entries = ["older", "a", "b", "c", "live"].map(turnKey => ({ turnKey }));
  const next = buildTurnLayout(entries);
  const range = reconcileRenderedRangeForEntries(current, next);
  assert.deepEqual(range, { startIndex: 0, endIndex: 5 });
  assert.deepEqual(createTurnWindowSlice(entries, next, range).entries.map(entry => entry.turnKey),
    ["older", "a", "b", "c", "live"]);
  const removedStart = buildTurnLayout(entries.slice(1));
  assert.deepEqual(reconcileRenderedRangeForEntries(current, removedStart), { startIndex: 0, endIndex: 4 },
    "the remaining mounted identities own the window even when its first anchor disappears");
});

test("same-count identity handoff retains the replaced window edge as well as surviving rows", () => {
  const current = { distanceFromBottomPx: 0, viewportHeightPx: 500,
    renderedRange: { startIndex: 1, endIndex: 4 }, turnKeys: ["older", "a", "b", "optimistic"] };
  const latest = buildTurnLayout(["older", "a", "b", "authority"].map(turnKey => ({ turnKey })));
  assert.deepEqual(reconcileRenderedRangeForEntries(current, latest), { startIndex: 1, endIndex: 4 },
    "a canonical ID handoff must not exclude the latest slot while count is unchanged");
  const first = buildTurnLayout(["older", "replacement", "b", "optimistic"].map(turnKey => ({ turnKey })));
  assert.deepEqual(reconcileRenderedRangeForEntries(current, first), { startIndex: 1, endIndex: 4 },
    "a surviving row's previous relative position also retains a replaced first slot");
});

test("identity handoff transfers measured geometry without fabricating content growth", () => {
  const previous = [{ turnKey: "older", identity: "older" }, { turnKey: "optimistic", identity: "client-message" }];
  const next = [{ turnKey: "older", identity: "older" }, { turnKey: "authority", identity: "client-message" }];
  const heights = { older: 600, optimistic: 306 };
  const transferred = rekeyTurnMeasurements(previous, next, heights, entry => entry.identity);
  assert.deepEqual(transferred, { ...heights, authority: 306 });
  assert.deepEqual(heights, { older: 600, optimistic: 306 }, "the prior height map is immutable");
  assert.equal(buildTurnLayout(previous, heights).totalHeightPx, buildTurnLayout(next, transferred).totalHeightPx);
  assert.equal(rekeyTurnMeasurements(next, next, transferred, entry => entry.identity), transferred);
  const authoritative = { ...heights, authority: 400 };
  assert.equal(rekeyTurnMeasurements(previous, next, authoritative, entry => entry.identity), authoritative,
    "already observed authority geometry wins over the old locator");
  assert.equal(rekeyTurnMeasurements(previous, [{ turnKey: "new", identity: "different-client" }], heights, entry => entry.identity), heights,
    "unrelated messages cannot inherit a previous row's height");
});

test("the recovered prework follow state machine is shared by Web and RN adapters", () => {
  let state = createInitialTurnFollowState({
    distanceFromBottomPx: 0,
    isLatestTurnInProgress: true,
    latestTurnPhase: "prework",
  });
  assert.equal(state.followMode, "prework_follow");
  assert.equal(shouldFollowLatestTurn(state, "prework"), true);

  state = reduceTurnFollowState(state, {
    type: "scroll_distance_changed",
    distanceFromBottomPx: 25,
    latestTurnPhase: "prework",
  });
  assert.equal(state.followMode, "prework_watch");
  assert.equal(shouldFollowLatestTurn(state, "prework"), false);

  state = reduceTurnFollowState(state, {
    type: "latest_turn_follow_content_changed",
    followContentOverflowPx: 1,
    latestTurnPhase: "prework",
  });
  assert.equal(state.followMode, "prework_follow");

  state = reduceTurnFollowState(state, {
    type: "latest_turn_phase_changed",
    previousLatestTurnPhase: "prework",
    latestTurnPhase: "final_answer",
  });
  assert.equal(state.followMode, "user_follow");
  assert.equal(shouldFollowLatestTurn(state, "final_answer"), true);

  state = reduceTurnFollowState(state, {
    type: "scroll_distance_changed",
    distanceFromBottomPx: 120,
    latestTurnPhase: "final_answer",
  });
  assert.equal(state.followMode, "static");
});

test("static prework watches until follow content actually overflows", () => {
  let state = reduceTurnFollowState(createTurnFollowState(), {
    type: "latest_turn_phase_changed",
    previousLatestTurnPhase: "idle",
    latestTurnPhase: "prework",
  });
  assert.equal(state.followMode, "prework_watch");
  state = reduceTurnFollowState(state, {
    type: "latest_turn_follow_content_changed",
    followContentOverflowPx: 0,
    latestTurnPhase: "prework",
  });
  assert.equal(state.followMode, "prework_watch");
  state = reduceTurnFollowState(state, {
    type: "scroll_to_bottom",
    latestTurnPhase: "prework",
  });
  assert.equal(state.followMode, "prework_follow");
});

test("response placement does not give final-answer growth ownership of following", () => {
  let state = reduceTurnFollowState(createTurnFollowState("user_follow"), { type: "latest_turn_placed" });
  assert.equal(state.followMode, "static");
  state = reduceTurnFollowState(state, {
    type: "latest_turn_phase_changed", previousLatestTurnPhase: "idle", latestTurnPhase: "prework",
  });
  state = reduceTurnFollowState(state, {
    type: "latest_turn_phase_changed", previousLatestTurnPhase: "prework", latestTurnPhase: "final_answer",
  });
  for (const overflow of [0, 100, 5_000, 20_000]) {
    state = reduceTurnFollowState(state, {
      type: "latest_turn_follow_content_changed", latestTurnPhase: "final_answer", followContentOverflowPx: overflow,
    });
    assert.equal(state.followMode, "static");
    assert.equal(shouldFollowLatestTurn(state, "final_answer"), false);
  }
  state = reduceTurnFollowState(state, { type: "scroll_to_bottom", latestTurnPhase: "final_answer" });
  state = reduceTurnFollowState(state, {
    type: "latest_turn_follow_content_changed", latestTurnPhase: "final_answer", followContentOverflowPx: 30_000,
  });
  assert.equal(shouldFollowLatestTurn(state, "final_answer"), true);
  state = reduceTurnFollowState(state, {
    type: "scroll_distance_changed", latestTurnPhase: "final_answer", distanceFromBottomPx: 25,
  });
  state = reduceTurnFollowState(state, {
    type: "latest_turn_follow_content_changed", latestTurnPhase: "final_answer", followContentOverflowPx: 40_000,
  });
  assert.equal(state.followMode, "static", "new text must not steal a detached reader's viewport");
});

test("a near-bottom local submit follows streaming once the answer reaches the viewport edge", () => {
  let state = reduceTurnFollowState(createTurnFollowState(), {
    type: "latest_turn_placed", watchForOverflow: true,
  });
  assert.equal(state.followMode, "response_watch");
  assert.equal(isViewportPreservingTurnFollowMode(state.followMode), true);
  state = reduceTurnFollowState(state, {
    type: "latest_turn_phase_changed", previousLatestTurnPhase: "idle", latestTurnPhase: "prework",
  });
  state = reduceTurnFollowState(state, {
    type: "latest_turn_phase_changed", previousLatestTurnPhase: "prework", latestTurnPhase: "final_answer",
  });
  assert.equal(state.followMode, "response_watch");
  state = reduceTurnFollowState(state, {
    type: "latest_turn_follow_content_changed", latestTurnPhase: "final_answer", followContentOverflowPx: 0,
  });
  assert.equal(state.followMode, "response_watch");
  state = reduceTurnFollowState(state, {
    type: "latest_turn_follow_content_changed", latestTurnPhase: "final_answer", followContentOverflowPx: 1,
  });
  assert.equal(state.followMode, "user_follow");
  assert.equal(shouldFollowLatestTurn(state, "final_answer"), true);
  state = reduceTurnFollowState(state, {
    type: "scroll_distance_changed", latestTurnPhase: "final_answer", distanceFromBottomPx: 100,
  });
  assert.equal(state.followMode, "static");
  assert.equal(shouldFollowLatestTurn(state, "final_answer"), false);
});

test("reading away cancels local response watch and restored watch cannot steal position", () => {
  let state = reduceTurnFollowState(createTurnFollowState(), {
    type: "latest_turn_placed", watchForOverflow: true,
  });
  state = reduceTurnFollowState(state, {
    type: "scroll_distance_changed", latestTurnPhase: "prework", distanceFromBottomPx: 25,
  });
  state = reduceTurnFollowState(state, {
    type: "latest_turn_follow_content_changed", latestTurnPhase: "final_answer", followContentOverflowPx: 500,
  });
  assert.equal(state.followMode, "static");
  assert.equal(createInitialTurnFollowState({
    distanceFromBottomPx: 100,
    isLatestTurnInProgress: true,
    latestTurnPhase: "final_answer",
    restoredFollowMode: "response_watch",
  }).followMode, "static");
  const directAnswer = reduceTurnFollowState(
    reduceTurnFollowState(createTurnFollowState(), {
      type: "latest_turn_placed", watchForOverflow: true,
    }),
    { type: "latest_turn_phase_changed", previousLatestTurnPhase: "idle", latestTurnPhase: "final_answer" },
  );
  assert.equal(directAnswer.followMode, "response_watch");
  assert.equal(reduceTurnFollowState(directAnswer, {
    type: "latest_turn_follow_content_changed", latestTurnPhase: "final_answer", followContentOverflowPx: 1,
  }).followMode, "user_follow");
});

test("latest Turn placement and response spacer retain recovered Codex constants", () => {
  assert.deepEqual(CODEX_LATEST_TURN_PLACEMENT_SPRING, {
    bounce: 0,
    durationMs: 500,
    damping: 36.933653905806345,
    mass: 1,
    stiffness: 341.02369770847105,
  });
  assert.equal(createLatestTurnPlacementSnapshot({
    distanceFromBottomPx: 340,
    responseSpacerHeightPx: 40,
    scrollHeightPx: 2_000,
  }).shouldPlaceLatestTurn, true);
  assert.equal(createLatestTurnPlacementSnapshot({
    distanceFromBottomPx: 341,
    responseSpacerHeightPx: 40,
    scrollHeightPx: 2_000,
  }).shouldPlaceLatestTurn, false);

  assert.equal(maximumResponseSpacerHeightPx({
    scrollElementHeightPx: 900,
    scrollPaddingBottomPx: 0,
  }), 600);
  assert.equal(maximumResponseSpacerHeightPx({
    scrollElementHeightPx: 300,
    scrollPaddingBottomPx: 0,
  }), 60);
  assert.equal(responseSpacerOverflowPx({
    distanceFromBottomPx: 80,
    responseSpacerHeightPx: 300,
    scrollPaddingBottomPx: 20,
  }), 200);
});

test("restore normalization never persists a viewport inside the response spacer", () => {
  const normalized = normalizeFollowRestorePosition({
    distanceFromBottomPx: 80,
    latestTurnPhase: "final_answer",
    responseSpacerHeightPx: 300,
    scrollPaddingBottomPx: 20,
    scrollState: createTurnFollowState("static"),
  });
  assert.equal(normalized.distanceFromBottomPx, 0);
  assert.equal(normalized.scrollState.followMode, "user_follow");

  const outsideSpacer = normalizeFollowRestorePosition({
    distanceFromBottomPx: 420,
    latestTurnPhase: "idle",
    responseSpacerHeightPx: 300,
    scrollPaddingBottomPx: 20,
    scrollState: createTurnFollowState("static"),
  });
  assert.equal(outsideSpacer.distanceFromBottomPx, 120);
  assert.equal(outsideSpacer.scrollState.followMode, "static");
});

test("scroll-to-bottom visibility excludes the synthetic response spacer", () => {
  assert.equal(shouldShowScrollToBottomAction({
    isScrolledFromBottom: true,
    responseSpacerHeightPx: 100,
    scrollDistanceFromBottomPx: 124,
  }), false);
  assert.equal(shouldShowScrollToBottomAction({
    isScrolledFromBottom: true,
    responseSpacerHeightPx: 100,
    scrollDistanceFromBottomPx: 124.01,
  }), true);
  assert.equal(shouldShowScrollToBottomAction({
    isScrolledFromBottom: true,
    responseSpacerHeightPx: null,
    scrollDistanceFromBottomPx: 25,
  }), true);
  assert.equal(shouldShowScrollToBottomAction({
    isScrolledFromBottom: false,
    responseSpacerHeightPx: null,
    scrollDistanceFromBottomPx: 24,
  }), false);
});

test("bottom padding and viewport reporting match the original virtualized list", () => {
  const layout = buildTurnLayout(turns(5), {}, config);
  assert.equal(distanceExcludingBottomPadding(180, 64), 116);
  assert.equal(distanceExcludingBottomPadding(40, 64), 0);
  assert.equal(isAtVirtualizedBottom(24, 0), true);
  assert.equal(isAtVirtualizedBottom(1, 64), false);
  assert.equal(isAtVirtualizedBottom(0, 64), true);
  assert.deepEqual(computeTurnViewportBounds(layout, 100, 160), {
    viewportStartPx: 240,
    viewportEndPx: 400,
  });
});

test("target positioning can align a descendant inside a Turn", () => {
  const layout = buildTurnLayout(turns(5), {}, config);
  assert.equal(distanceFromBottomToTargetWithinTurn({
    align: "top",
    layout,
    targetHeightPx: 20,
    targetTopOffsetWithinTurnPx: 30,
    turnKey: "turn-2",
    viewportHeightPx: 200,
  }), 80);
  assert.equal(distanceFromBottomToTargetWithinTurn({
    align: "top",
    layout,
    targetHeightPx: 20,
    targetTopOffsetWithinTurnPx: 30,
    topAlignmentInsetPx: 16,
    turnKey: "turn-2",
    viewportHeightPx: 200,
  }), 86);
  assert.equal(distanceFromBottomToTargetWithinTurn({
    align: "center",
    layout,
    targetHeightPx: 20,
    targetTopOffsetWithinTurnPx: 30,
    turnKey: "turn-2",
    viewportHeightPx: 200,
  }), 160);
});

test("input modality helpers retain Codex wheel, keyboard, touch and history thresholds", () => {
  assert.equal(normalizeInitialScrollDistance(24), 0);
  assert.equal(normalizeInitialScrollDistance(25), 25);
  assert.equal(normalizeWheelDeltaPx(2, 1, 800), 32);
  assert.equal(normalizeWheelDeltaPx(2, 2, 800), 1_600);
  assert.equal(keyboardScrollDirection({ defaultPrevented: false, key: "PageUp", repeat: false, shiftKey: false }), "away");
  assert.equal(keyboardScrollDirection({ defaultPrevented: false, key: " ", repeat: false, shiftKey: false }), "toward");
  assert.equal(keyboardScrollDirection({ defaultPrevented: false, key: " ", repeat: false, shiftKey: true }), "away");
  assert.equal(directionForTouchDelta(2, 7), null);
  assert.equal(directionForTouchDelta(2, 9), "away");
  assert.equal(shouldLoadOlderHistory({ contentHeightPx: 2_000, viewportHeightPx: 600, distanceFromBottomPx: 1_336 }), true);
  assert.equal(shouldLoadOlderHistory({ contentHeightPx: 2_000, viewportHeightPx: 600, distanceFromBottomPx: 1_335 }), false);
});

test("footer resize compensation and smooth bottom curve match ThreadScrollLayout", () => {
  assert.equal(footerScrollPaddingPx(100), 116);
  assert.equal(footerResizeCompensation({
    currentDistanceFromBottomPx: 120,
    footerResizeViewportPreserveDisabled: false,
    isScrollAnimationActive: false,
    nextFooterHeightPx: 140,
    previousFooterHeightPx: 100,
  }), 160);
  assert.equal(footerResizeCompensation({
    currentDistanceFromBottomPx: 20,
    footerResizeViewportPreserveDisabled: false,
    isScrollAnimationActive: false,
    nextFooterHeightPx: 140,
    previousFooterHeightPx: 100,
  }), null);
  assert.equal(scrollToBottomDistanceAtTime(800, 0), 800);
  assert.equal(scrollToBottomDistanceAtTime(800, 260), 0);
  assert.equal(scrollToBottomDistanceAtTime(800, 130), 100);
});

test("response positioning atomically yields restore and follow ownership to the user", () => {
  const controller = new TurnResponsePositioningController({
    distanceFromBottomPx: 180,
    isLatestTurnInProgress: true,
    latestTurnPhase: "prework",
  });

  assert.equal(controller.isRestorePending(), true);
  controller.reduceFollow({
    type: "latest_turn_phase_changed",
    previousLatestTurnPhase: "idle",
    latestTurnPhase: "prework",
  });
  assert.equal(controller.getFollowState().followMode, "prework_watch");

  controller.userTakeover();
  controller.reduceFollow({
    type: "scroll_distance_changed",
    distanceFromBottomPx: 240,
    latestTurnPhase: "prework",
  });

  assert.deepEqual(controller.getRestoreState(), { phase: "settled", reason: "user-takeover" });
  assert.equal(controller.attemptRestore(0), null);
  assert.equal(controller.getPendingRestoreDistanceFromBottomPx(), null);
});

test("response positioning exposes one padded restore target and follow can settle it", () => {
  const controller = new TurnResponsePositioningController({
    distanceFromBottomPx: 320,
    isLatestTurnInProgress: true,
    latestTurnPhase: "prework",
    restoredLatestTurn: {
      turnKey: "turn-1",
      isLatestTurnInProgress: true,
      latestTurnPhase: "prework",
      followMode: "prework_watch",
      latestTurnHeightPx: 500,
      latestTurnFollowContentHeightPx: 300,
    },
  });

  assert.equal(controller.getPendingRestoreDistanceFromBottomPx(120), 200);
  controller.adjustPendingRestoreForHeightDelta(40);
  assert.equal(controller.getPendingRestoreDistanceFromBottomPx(120), 240);
  controller.settleRestoreForFollowMode();
  assert.equal(controller.getPendingRestoreDistanceFromBottomPx(120), null);
});

test("capturing a restore checkpoint cannot grant live follow ownership", () => {
  const controller = new TurnResponsePositioningController({
    distanceFromBottomPx: 180,
    isLatestTurnInProgress: true,
    latestTurnPhase: "prework",
  });
  controller.reduceFollow({
    type: "latest_turn_phase_changed",
    previousLatestTurnPhase: "idle",
    latestTurnPhase: "prework",
  });
  assert.equal(controller.getFollowState().followMode, "prework_watch");

  const checkpoint = controller.captureRestorePosition({
    distanceFromBottomPx: 1,
    latestTurnPhase: "prework",
    responseSpacerHeightPx: 320,
    scrollPaddingBottomPx: 160,
  });

  // The checkpoint is normalized for a future mount, exactly like Codex fO,
  // while the mounted viewport keeps its existing read-position ownership.
  assert.equal(checkpoint.distanceFromBottomPx, 0);
  assert.equal(checkpoint.scrollState.followMode, "prework_follow");
  assert.equal(controller.getFollowState().followMode, "prework_watch");
  const transition = controller.transitionLatestTurnPhase("prework", "final_answer");
  assert.equal(transition.transferFollowToFinalAnswer, false);
  assert.equal(transition.followState.followMode, "static");
});

test("response completion reports a fact without acquiring bottom ownership", () => {
  const controller = new TurnResponsePositioningController({
    distanceFromBottomPx: 320,
    isLatestTurnInProgress: true,
    latestTurnPhase: "final_answer",
  });

  const transition = controller.transitionLatestTurnPhase(
    "final_answer",
    "idle",
  );

  assert.equal(transition.completed, true);
  assert.equal(transition.transferFollowToFinalAnswer, false);
  assert.equal(transition.followState.followMode, "static");
  assert.equal(controller.ownsFollowPosition("idle"), false);
});

test("response completion retains existing user follow without creating a new reason", () => {
  const controller = new TurnResponsePositioningController({
    distanceFromBottomPx: 0,
    isLatestTurnInProgress: true,
    latestTurnPhase: "final_answer",
  });

  const transition = controller.transitionLatestTurnPhase(
    "final_answer",
    "idle",
  );

  assert.equal(transition.completed, true);
  assert.equal(transition.previousFollowMode, "user_follow");
  assert.equal(transition.transferFollowToFinalAnswer, false);
  assert.equal(controller.ownsFollowPosition("idle"), true);
});

test("only prework follow transfer owns an explicit phase-transition bottom command", () => {
  const controller = new TurnResponsePositioningController({
    distanceFromBottomPx: 0,
    isLatestTurnInProgress: true,
    latestTurnPhase: "prework",
  });

  const transition = controller.transitionLatestTurnPhase(
    "prework",
    "final_answer",
  );

  assert.equal(transition.completed, false);
  assert.equal(transition.previousFollowMode, "prework_follow");
  assert.equal(transition.transferFollowToFinalAnswer, true);
  assert.equal(transition.followState.followMode, "user_follow");
});

test("shared scroll controller preserves layout and runs the recovered 260ms bottom animation", () => {
  let distance = 500;
  let scrollHeight = 2_000;
  let now = 0;
  let nextFrameId = 1;
  const frames = new Map<number, (nowMs: number) => void>();
  const writes: number[] = [];
  const controller = new TurnScrollController({
    getMetrics: () => ({ distanceFromBottomPx: distance, viewportHeightPx: 600, scrollHeightPx: scrollHeight }),
    writeDistanceFromBottomPx: (next) => { distance = next; writes.push(next); },
    now: () => now,
    requestFrame: (callback) => { const id = nextFrameId++; frames.set(id, callback); return id; },
    cancelFrame: (id) => { frames.delete(id); },
  }, distance);

  controller.scrollToBottom();
  while (frames.size > 0) {
    const [id, callback] = frames.entries().next().value!;
    frames.delete(id);
    now += 65;
    callback(now);
  }
  assert.equal(distance, 0);
  assert.ok(writes.length >= 4);

  distance = 300;
  controller.reportPlatformScroll("system");
  controller.preserveScrollPositionForNextLayout();
  scrollHeight = 2_400;
  const [id, callback] = frames.entries().next().value!;
  frames.delete(id);
  callback(now + 16);
  assert.equal(distance, 300);
  controller.dispose();
});

test("layout preservation consumes wheel input before classifying the resulting scroll event", () => {
  let distance = 300;
  let scrollHeight = 2_000;
  let nextFrameId = 1;
  const frames = new Map<number, (nowMs: number) => void>();
  const controller = new TurnScrollController({
    getMetrics: () => ({ distanceFromBottomPx: distance, viewportHeightPx: 600, scrollHeightPx: scrollHeight }),
    writeDistanceFromBottomPx: (next) => { distance = Math.min(Math.max(0, next), scrollHeight - 600); },
    now: () => 0,
    requestFrame: (callback) => { const id = nextFrameId++; frames.set(id, callback); return id; },
    cancelFrame: (id) => { frames.delete(id); },
  }, distance);

  controller.preserveScrollPositionForNextLayout();
  controller.recordWheelDelta(-40);
  scrollHeight = 2_400;
  const observedTransitions: Array<readonly [number, number]> = [];
  const userTransitions: Array<readonly [number, number]> = [];
  controller.addUserScrollListener((current, previous) => {
    userTransitions.push([previous, current]);
  });
  const snapshot = controller.reportPlatformScroll((change) => {
    observedTransitions.push([
      change.previousDistanceFromBottomPx,
      change.currentDistanceFromBottomPx,
    ]);
    return change.currentDistanceFromBottomPx > change.previousDistanceFromBottomPx
      ? "user"
      : "system";
  });
  assert.equal(snapshot.distanceFromBottomPx, 340);
  assert.equal(snapshot.previousDistanceFromBottomPx, 300);
  assert.equal(snapshot.origin, "user");
  assert.deepEqual(observedTransitions, [[300, 340]]);
  assert.deepEqual(userTransitions, [[300, 340]]);
  assert.equal(distance, 340);
  assert.equal(frames.size, 0);
  controller.dispose();
});

test("wheel accumulation survives until the scheduled layout-preservation frame", () => {
  let distance = 400;
  let scrollHeight = 2_000;
  let nextFrameId = 1;
  const frames = new Map<number, (nowMs: number) => void>();
  const controller = new TurnScrollController({
    getMetrics: () => ({ distanceFromBottomPx: distance, viewportHeightPx: 800, scrollHeightPx: scrollHeight }),
    writeDistanceFromBottomPx: (next) => { distance = next; },
    now: () => 0,
    requestFrame: (callback) => { const id = nextFrameId++; frames.set(id, callback); return id; },
    cancelFrame: (id) => { frames.delete(id); },
  }, distance);

  controller.preserveScrollPositionForNextLayout();
  controller.recordWheelDelta(-120);
  distance = 420;
  controller.reportPlatformScroll("user");
  scrollHeight = 2_500;
  const [id, callback] = frames.entries().next().value!;
  frames.delete(id);
  callback(16);
  assert.equal(distance, 520);
  controller.dispose();
});

for (const [confirmed, physical] of [[0, 800], [400, 800], [400, 20]] as const) {
  test(`bottom command samples physical distance ${physical}, not confirmed distance ${confirmed}`, () => {
    let distance: number = physical;
    const frames = new Map<number, (nowMs: number) => void>();
    let nextFrameId = 0;
    const controller = new TurnScrollController({
      getMetrics: () => ({ distanceFromBottomPx: distance, viewportHeightPx: 600, scrollHeightPx: 2_000 }),
      writeDistanceFromBottomPx: (next) => { distance = next; },
      now: () => 0,
      requestFrame: (callback) => { const id = ++nextFrameId; frames.set(id, callback); return id; },
      cancelFrame: (id) => { frames.delete(id); },
    }, confirmed);
    try {
      // A layout/browser update happened but its scroll event is not yet
      // confirmed. Clicking bottom starts a new command from current geometry.
      controller.scrollToBottom();
      if (physical <= 24) {
        assert.equal(frames.size, 0);
        assert.equal(distance, 0);
      } else {
        assert.equal(frames.size, 1);
        const [id, callback] = frames.entries().next().value!;
        frames.delete(id);
        callback(130);
        assert.equal(distance, physical / 8, "r3562 cubic animation must use the current physical origin");
      }
    } finally {
      controller.dispose();
    }
  });
}

test("keyboard or pointer takeover cancels a pending layout preservation", () => {
  let distance = 300;
  let scrollHeight = 2_000;
  let nextFrameId = 1;
  const frames = new Map<number, (nowMs: number) => void>();
  const controller = new TurnScrollController({
    getMetrics: () => ({ distanceFromBottomPx: distance, viewportHeightPx: 600, scrollHeightPx: scrollHeight }),
    writeDistanceFromBottomPx: (next) => { distance = next; },
    now: () => 0,
    requestFrame: (callback) => { const id = nextFrameId++; frames.set(id, callback); return id; },
    cancelFrame: (id) => { frames.delete(id); },
  }, distance);

  controller.preserveScrollPositionForNextLayout();
  controller.cancelPendingLayoutPreservation();
  distance = 520;
  controller.reportPlatformScroll("user");
  scrollHeight = 2_600;
  assert.equal(frames.size, 0);
  assert.equal(distance, 520);
  controller.dispose();
});

test("smooth bottom animation snaps to zero as soon as physical distance is within 24px", () => {
  let distance = 400;
  let now = 0;
  let nextFrameId = 1;
  const frames = new Map<number, (nowMs: number) => void>();
  const controller = new TurnScrollController({
    getMetrics: () => ({ distanceFromBottomPx: distance, viewportHeightPx: 600, scrollHeightPx: 2_000 }),
    writeDistanceFromBottomPx: (next) => { distance = next; },
    now: () => now,
    requestFrame: (callback) => { const id = nextFrameId++; frames.set(id, callback); return id; },
    cancelFrame: (id) => { frames.delete(id); },
  }, distance);

  controller.scrollToBottom();
  const [id, callback] = frames.entries().next().value!;
  frames.delete(id);
  now = 220;
  callback(now);
  assert.equal(distance, 0);
  assert.equal(frames.size, 0);
  controller.dispose();
});

test("imperative scrolling cancels pending preservation and publishes the platform-clamped distance", () => {
  let distance = 300;
  let scrollHeight = 2_000;
  let nextFrameId = 1;
  const frames = new Map<number, (nowMs: number) => void>();
  const userDistances: number[] = [];
  const controller = new TurnScrollController({
    getMetrics: () => ({ distanceFromBottomPx: distance, viewportHeightPx: 600, scrollHeightPx: scrollHeight }),
    writeDistanceFromBottomPx: (next) => { distance = Math.min(Math.max(0, next), scrollHeight - 600); },
    now: () => 0,
    requestFrame: (callback) => { const id = nextFrameId++; frames.set(id, callback); return id; },
    cancelFrame: (id) => { frames.delete(id); },
  }, distance);
  controller.addUserScrollListener((next) => userDistances.push(next));

  controller.preserveScrollPositionForNextLayout();
  controller.scrollToDistanceFromBottomPx(9_000, "instant", "user");
  assert.equal(distance, 1_400);
  assert.deepEqual(userDistances, [1_400]);
  controller.scrollToDistanceFromBottomPx(9_000, "instant", "user");
  assert.deepEqual(
    userDistances,
    [1_400],
    "an unchanged imperative target is not a second user-scroll transaction",
  );
  assert.equal(frames.size, 0);
  scrollHeight = 2_400;
  assert.equal(controller.reportPlatformScroll("system").distanceFromBottomPx, 1_400);
  controller.dispose();
});
