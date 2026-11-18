import assert from "node:assert/strict";
import test from "node:test";
import { TurnHistoryBackfillCoordinator } from "@opencraft/timeline-virtualizer";

test("short pages advance by cursor while scrollHeight stays floored by the viewport", async () => {
  let pages = 0;
  const coordinator = new TurnHistoryBackfillCoordinator({
    isEnabled: () => true,
    readPagination: () => ({ cursor: String(pages), hasOlder: pages < 4, loading: false }),
    readMetrics: () => ({ viewportHeightPx: 600, scrollHeightPx: 600, distanceFromBottomPx: 0 }),
    loadPage: () => { pages++; void coordinator.request(); },
    afterLayout: async () => { void coordinator.request(); },
  });
  await coordinator.request();
  assert.equal(pages, 4);
  await coordinator.request();
  assert.equal(pages, 4, "exhaustion remains authoritative");
});

test("unchanged pagination stays bounded despite layout notifications and loading settlements", async () => {
  let calls = 0, height = 600;
  const coordinator = new TurnHistoryBackfillCoordinator({
    isEnabled: () => true,
    readPagination: () => ({ cursor: "same", hasOlder: true, loading: false }),
    readMetrics: () => ({ viewportHeightPx: 600, scrollHeightPx: height, distanceFromBottomPx: height - 600 }),
    loadPage: () => { calls++; height += 100; void coordinator.request(); },
    afterLayout: async () => { void coordinator.request(); },
  });
  await coordinator.request();
  await coordinator.request();
  assert.equal(calls, 1, "height growth is not pagination progress");
  await coordinator.retry();
  assert.equal(calls, 2, "an explicit user action can retry the stalled frontier");
});

test("pending demand is reconsidered after the current pass without concurrent reads", async () => {
  let height = 1000, pages = 0;
  const coordinator = new TurnHistoryBackfillCoordinator({
    isEnabled: () => true,
    readPagination: () => ({ cursor: String(pages), hasOlder: pages < 1, loading: false }),
    readMetrics: () => {
      const measured = height;
      if (height === 1000) { height = 600; void coordinator.request(); }
      return { viewportHeightPx: 600, scrollHeightPx: measured, distanceFromBottomPx: 0 };
    },
    loadPage: () => { pages++; }, afterLayout: async () => {},
  });
  await coordinator.request();
  assert.equal(pages, 1);
});

test("hidden viewports and external reads wait for a new demand signal", async () => {
  let height = 0, loading = false, calls = 0;
  const coordinator = new TurnHistoryBackfillCoordinator({
    isEnabled: () => true,
    readPagination: () => ({ cursor: null, hasOlder: true, loading }),
    readMetrics: () => ({ viewportHeightPx: height, scrollHeightPx: height, distanceFromBottomPx: 0 }),
    loadPage: () => { calls++; return "stop"; }, afterLayout: async () => {},
  });
  await coordinator.request();
  height = 600; loading = true;
  await coordinator.request();
  assert.equal(calls, 0);
  loading = false;
  await coordinator.request();
  assert.equal(calls, 1);
});

test("late failure from a retired owner cannot block or report into the next owner", async () => {
  let reject!: (error: Error) => void, calls = 0, errors = 0;
  const held = new Promise<void>((_, fail) => { reject = fail; });
  const coordinator = new TurnHistoryBackfillCoordinator({
    isEnabled: () => true,
    readPagination: () => ({ cursor: null, hasOlder: true, loading: false }),
    readMetrics: () => ({ viewportHeightPx: 600, scrollHeightPx: 600, distanceFromBottomPx: 0 }),
    loadPage: async () => { if (++calls === 1) await held; return "stop"; },
    afterLayout: async () => {}, onError: () => { errors++; },
  });
  const old = coordinator.request(); await Promise.resolve();
  coordinator.invalidate();
  const next = coordinator.request();
  reject(new Error("retired"));
  await Promise.all([old, next]);
  assert.equal(errors, 0);
  assert.equal(calls, 2);
});

test("recoverable failures stop automatic retries but a changed frontier resumes demand", async () => {
  let cursor = "first", calls = 0, errors = 0;
  const coordinator = new TurnHistoryBackfillCoordinator({
    isEnabled: () => true,
    readPagination: () => ({ cursor, hasOlder: true, loading: false }),
    readMetrics: () => ({ viewportHeightPx: 600, scrollHeightPx: 600, distanceFromBottomPx: 0 }),
    loadPage: () => { calls++; if (cursor === "first") throw new Error("offline"); return "stop"; },
    afterLayout: async () => {}, onError: () => { errors++; },
  });
  await coordinator.request();
  await coordinator.request();
  assert.equal(calls, 1);
  assert.equal(errors, 1);
  cursor = "next";
  await coordinator.request();
  assert.equal(calls, 2);
});
