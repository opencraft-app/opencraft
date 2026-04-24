import test from "node:test";
import assert from "node:assert/strict";
import { normalizeUserUsage } from "./user-usage-chart.ts";

test("normalizeUserUsage fills missing days with zero values", () => {
  const result = normalizeUserUsage({
    user_id: "usr_001",
    days: 3,
    daily: [
      { date: "2026-04-01", total_tokens: 120, total_interactions: 2 },
    ],
    total_tokens: 120,
    total_interactions: 2,
  }, new Date("2026-04-03T12:00:00Z"));

  assert.deepEqual(result.daily, [
    { date: "2026-04-01", total_tokens: 120, total_interactions: 2 },
    { date: "2026-04-02", total_tokens: 0, total_interactions: 0 },
    { date: "2026-04-03", total_tokens: 0, total_interactions: 0 },
  ]);
});

test("normalizeUserUsage builds zero-filled series when backend daily is empty", () => {
  const result = normalizeUserUsage({
    user_id: "usr_001",
    days: 3,
    daily: [],
    total_tokens: 0,
    total_interactions: 0,
  }, new Date("2026-04-03T12:00:00Z"));

  assert.deepEqual(result.daily, [
    { date: "2026-04-01", total_tokens: 0, total_interactions: 0 },
    { date: "2026-04-02", total_tokens: 0, total_interactions: 0 },
    { date: "2026-04-03", total_tokens: 0, total_interactions: 0 },
  ]);
});
