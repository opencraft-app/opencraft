import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTurnLayout,
  createTurnMeasurementTransaction,
  createTurnViewportState,
  type TurnMeasurementTransaction,
} from "@opencraft/timeline-virtualizer";

const entries = [{ turnKey: "old", estimatedHeightPx: 800 }, { turnKey: "latest", estimatedHeightPx: 280 }];
function measure({
  heights = { old: 800 } as Readonly<Record<string, number>>,
  measurements = [{ turnKey: "latest", heightPx: 420 }],
  distance = 400,
  preserve = false,
  restore = (() => null) as (() => number | null) | null,
  previous = null as TurnMeasurementTransaction | null,
} = {}) {
  const layout = previous?.layout ?? buildTurnLayout(entries, heights);
  const transaction = createTurnMeasurementTransaction({
    entries,
    measurements,
    measuredHeightsByKey: previous?.measuredHeightsByKey ?? heights,
    layout,
    viewport: previous?.viewport ?? createTurnViewportState(layout, distance, 200),
    currentDistanceFromBottomPx: distance,
    bottomPaddingPx: 0,
    preserveMeasuredTurnViewport: preserve,
    getPendingRestoreScrollDistanceFromBottomPx: restore,
    previousPendingTransaction: previous,
  });
  assert.ok(transaction);
  return transaction;
}

test("r3562: first measurement establishes a baseline, estimate correction is a different delta", () => {
  const first = measure();
  assert.equal(first.layoutHeightDeltaPx, 140);
  assert.equal(first.latestTurnHeightChange?.heightDeltaPx, 0);
  assert.equal(first.scrollDistanceFromBottomPx, null, "latest-Turn policy owns this row, not the generic compensator");
  const growth = measure({ heights: first.measuredHeightsByKey, measurements: [{ turnKey: "latest", heightPx: 450 }] });
  assert.equal(growth.latestTurnHeightChange?.heightDeltaPx, 30);
});

test("r3562: a settled restore delegate still leaves historical rows owned by the virtualizer", () => {
  const result = measure({ heights: { old: 800, latest: 280 }, measurements: [{ turnKey: "old", heightPx: 920 }] });
  assert.equal(result.scrollDistanceFromBottomPx, 520);
  assert.equal(result.latestTurnHeightChange, null);
  assert.equal(result.restoreScrollDistanceFromBottom, false);
});

test("r3562: no correction for growth above the reading anchor", () => {
  const result = measure({ heights: { old: 800, latest: 280 }, measurements: [{ turnKey: "old", heightPx: 920 }], distance: 100 });
  assert.equal(result.scrollDistanceFromBottomPx, null);
});

test("r3562: historical and latest growth in the same batch have disjoint compensation owners", () => {
  const result = measure({ heights: { old: 800, latest: 280 }, measurements: [{ turnKey: "old", heightPx: 920 }, { turnKey: "latest", heightPx: 310 }] });
  assert.equal(result.scrollDistanceFromBottomPx, 520);
  assert.equal(result.latestTurnHeightChange?.heightDeltaPx, 30);
});

test("r3562: pending restoration wins over ordinary compensation", () => {
  const result = measure({ restore: () => 700 });
  assert.equal(result.restoreScrollDistanceFromBottom, true);
  assert.equal(result.scrollDistanceFromBottomPx, null);
  assert.equal(result.viewport.distanceFromBottomPx, 700);
});

test("r3562: generic preservation does not request the delegated restore target", () => {
  const result = measure({ preserve: true, restore: () => { throw new Error("must not be sampled"); } });
  assert.equal(result.restoreScrollDistanceFromBottom, false);
  assert.equal(result.scrollDistanceFromBottomPx, 540);
});

test("r3562: queued measurements accumulate latest growth, not just the last batch", () => {
  const first = measure({ heights: { old: 800, latest: 280 }, measurements: [{ turnKey: "latest", heightPx: 300 }] });
  const next = measure({ previous: first, measurements: [{ turnKey: "latest", heightPx: 350 }] });
  assert.equal(next.latestTurnHeightChange?.heightDeltaPx, 70);
  assert.equal(next.latestTurnHeightChange?.heightPx, 350);
});

test("r3562: preserved bottom remains bottom through first measurement and shrink", () => {
  const first = measure({ preserve: true, distance: 0 });
  const shrink = measure({ preserve: true, distance: 0, heights: first.measuredHeightsByKey, measurements: [{ turnKey: "latest", heightPx: 300 }] });
  assert.equal(first.scrollDistanceFromBottomPx, 0);
  assert.equal(shrink.scrollDistanceFromBottomPx, 0);
  assert.equal(shrink.latestTurnHeightChange?.heightDeltaPx, -120);
});
