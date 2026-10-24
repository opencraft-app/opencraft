import assert from "node:assert/strict";
import test from "node:test";
import {
  compactTokens,
  dashboardMetrics,
  buildActivityGrid,
  buildActivityBars,
  modelShare,
  formatModelLabel,
  formatStateLabel,
} from "../../apps/workbench-web/src/components/token-usage-dashboard-data.js";

test("compactTokens formats numbers in compact K/M/B with decimals and sign", () => {
  assert.equal(compactTokens("0"), "0");
  assert.equal(compactTokens("42"), "42");
  assert.equal(compactTokens("999"), "999");
  assert.equal(compactTokens("1000"), "1K");
  assert.equal(compactTokens("1500"), "1.5K");
  assert.equal(compactTokens("25400"), "25.4K");
  assert.equal(compactTokens("1000000"), "1M");
  assert.equal(compactTokens("12500000"), "12.5M");
  assert.equal(compactTokens("1000000000"), "1B");
  assert.equal(compactTokens("2500000000"), "2.5B");
  assert.equal(compactTokens("-500"), "-500");
  assert.equal(compactTokens("-1500000"), "-1.5M");
  assert.equal(compactTokens("not-a-number"), "not-a-number");
});

test("dashboardMetrics calculates peak, settled and streak information correctly", () => {
  const snapshot = {
    summary: {
      tokens: "5000",
      turns: 10,
      settledTurns: 8,
      categories: { settled: "4000", provisional: "1000" },
    },
    daily: [
      { key: "2026-10-18", tokens: "1000", turns: 2 },
      { key: "2026-10-19", tokens: "2500", turns: 5 }, // Peak day
      { key: "2026-10-20", tokens: "500", turns: 1 },
      // Gap on 2026-10-21
      { key: "2026-10-22", tokens: "1000", turns: 2 },
    ],
  };

  const metrics = dashboardMetrics(snapshot, "2026-10-22");
  assert.equal(metrics.settled, "4000");
  assert.equal(metrics.total, "5000");
  assert.equal(metrics.peak, "2500");
  assert.equal(metrics.peakDay, "2026-10-19");
  assert.equal(metrics.settledTurns, 8);
  assert.equal(metrics.longestStreak, 3); // 18, 19, 20
  assert.equal(metrics.currentStreak, 1); // 22 (today)
});

test("dashboardMetrics handles empty and zero states gracefully", () => {
  const empty = dashboardMetrics({
    summary: { tokens: "0", turns: 0 },
    daily: [],
  });
  assert.equal(empty.settled, "0");
  assert.equal(empty.total, "0");
  assert.equal(empty.peak, "0");
  assert.equal(empty.peakDay, null);
  assert.equal(empty.settledTurns, 0);
  assert.equal(empty.longestStreak, 0);
  assert.equal(empty.currentStreak, 0);
});

test("buildActivityGrid constructs 7-row columns clamped between 4 and 26 weeks", () => {
  const daily = [
    { key: "2026-10-20", tokens: "5000", turns: 2 },
    { key: "2026-10-21", tokens: "20000", turns: 4 },
  ];

  // Short range (3 days) clamps to minimum 4 weeks
  const grid = buildActivityGrid(daily, "2026-10-20", "2026-10-22");
  assert.ok(grid.weeks >= 4 && grid.weeks <= 26);
  assert.equal(grid.columns.length, grid.weeks);
  for (const col of grid.columns) {
    assert.equal(col.length, 7); // Exactly 7 days per week
  }

  // Find 2026-10-21 cell and verify scaled level and state
  let cell21 = null;
  for (const col of grid.columns) {
    for (const cell of col) {
      if (cell.date === "2026-10-21") cell21 = cell;
    }
  }
  assert.ok(cell21);
  assert.equal(cell21.state, "measured");
  assert.equal(cell21.level, 4); // Max tokens in range
  assert.equal(cell21.tokens, "20000");
});

test("buildActivityBars aggregates by weekly and cumulative modes", () => {
  const daily = [
    { key: "2026-10-12", tokens: "1000", turns: 1 },
    { key: "2026-10-19", tokens: "2000", turns: 2 },
  ];

  const weeklyBars = buildActivityBars(daily, "2026-10-12", "2026-10-25", "weekly");
  assert.ok(weeklyBars.length >= 2);
  const cumBars = buildActivityBars(daily, "2026-10-12", "2026-10-25", "cumulative");
  assert.equal(cumBars.length, weeklyBars.length);
  const lastBar = cumBars[cumBars.length - 1]!;
  assert.equal(lastBar.tokens, "3000");
  assert.equal(lastBar.turns, 3);
});

test("modelShare, formatModelLabel and formatStateLabel provide reliable presentations", () => {
  assert.equal(modelShare("250", "1000"), 25);
  assert.equal(modelShare("0", "1000"), 0);
  assert.equal(modelShare("100", "0"), 0);

  const copy = (cn: string, en: string) => cn;
  assert.equal(formatModelLabel(JSON.stringify(["openai", "gpt-4o"]), copy), "openai / gpt-4o");
  assert.equal(formatModelLabel(JSON.stringify([null, null]), copy), "未知提供方 / 未知模型");
  assert.equal(formatModelLabel("invalid-json", copy), "未知模型");

  assert.equal(formatStateLabel("settled", copy), "已结算");
  assert.equal(formatStateLabel("provisional", copy), "暂定");
  assert.equal(formatStateLabel("custom-state", copy), "custom-state");
});


test("cumulative bars retain earlier usage when the selected range exceeds the visible weeks", () => {
  const daily = [
    { key: "2025-10-31", tokens: "999", turns: 9 },
    { key: "2025-11-01", tokens: "9007199254740993", turns: 2 },
    { key: "2026-10-24", tokens: "300", turns: 1 },
    { key: "2026-10-25", tokens: "999", turns: 9 },
  ];
  const cumulative = buildActivityBars(daily, "2025-11-01", "2026-10-24", "cumulative");
  assert.equal(cumulative.at(-1)!.tokens, "9007199254741293");
  assert.equal(cumulative.at(-1)!.turns, 3);
  assert.equal(buildActivityBars(daily, "2025-11-01", "2026-10-24", "weekly").at(-1)!.tokens, "300");
});


test("an omitted settled turn count stays unknown instead of borrowing the total turn count", () => {
  const metrics = dashboardMetrics({summary: {tokens: "1500", turns: 3, categories: {settled: "1200"}}, daily: []});
  assert.equal(metrics.settledTurns, null);
  assert.equal(metrics.settled, "1200");
  assert.equal(metrics.total, "1500");
});

test("earlier cumulative days retain the visible weeks' invalid-value and duplicate-key handling", () => {
  const daily = [
    { key: "2025-11-01", tokens: "100", turns: 1 },
    { key: "2025-11-01", tokens: "200", turns: 2 },
    { key: "2025-11-02", tokens: "unavailable", turns: 9 },
    { key: "2026-10-24", tokens: "300", turns: 3 },
  ];
  const last = buildActivityBars(daily, "2025-11-01", "2026-10-24", "cumulative").at(-1)!;
  assert.equal(last.tokens, "500");
  assert.equal(last.turns, 5);
});
