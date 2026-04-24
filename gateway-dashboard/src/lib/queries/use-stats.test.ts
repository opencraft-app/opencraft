import test from "node:test";
import assert from "node:assert/strict";
import { normalizeUsageTrend } from "./stats-shape.ts";

test("normalizeUsageTrend converts null collections to empty arrays", () => {
  const result = normalizeUsageTrend({
    period: "7d",
    granularity: "daily",
    data: null,
    model_distribution: null,
    model_daily_distribution: null,
  }, new Date("2026-04-01T12:00:00Z"));

  assert.deepEqual(result.data, [
    { date: "2026-03-26", total_tokens: 0, total_interactions: 0 },
    { date: "2026-03-27", total_tokens: 0, total_interactions: 0 },
    { date: "2026-03-28", total_tokens: 0, total_interactions: 0 },
    { date: "2026-03-29", total_tokens: 0, total_interactions: 0 },
    { date: "2026-03-30", total_tokens: 0, total_interactions: 0 },
    { date: "2026-03-31", total_tokens: 0, total_interactions: 0 },
    { date: "2026-04-01", total_tokens: 0, total_interactions: 0 },
  ]);
  assert.deepEqual(result.model_distribution, []);
  assert.deepEqual(result.model_daily_distribution, [
    { date: "2026-03-26", model: "暂无模型", tokens: 0, requests: 0, share: 0 },
    { date: "2026-03-27", model: "暂无模型", tokens: 0, requests: 0, share: 0 },
    { date: "2026-03-28", model: "暂无模型", tokens: 0, requests: 0, share: 0 },
    { date: "2026-03-29", model: "暂无模型", tokens: 0, requests: 0, share: 0 },
    { date: "2026-03-30", model: "暂无模型", tokens: 0, requests: 0, share: 0 },
    { date: "2026-03-31", model: "暂无模型", tokens: 0, requests: 0, share: 0 },
    { date: "2026-04-01", model: "暂无模型", tokens: 0, requests: 0, share: 0 },
  ]);
});

test("normalizeUsageTrend preserves interaction fields", () => {
  const result = normalizeUsageTrend({
    period: "7d",
    granularity: "daily",
    data: [
      {
        date: "2026-03-31",
        total_tokens: 42,
        total_interactions: 3,
      },
    ],
    model_distribution: [],
    model_daily_distribution: [],
  }, new Date("2026-04-01T12:00:00Z"));

  assert.equal(result.data[5]?.total_interactions, 3);
});

test("normalizeUsageTrend fills missing days with zero values", () => {
  const result = normalizeUsageTrend({
    period: "3d",
    granularity: "daily",
    data: [
      {
        date: "2026-04-01",
        total_tokens: 42,
        total_interactions: 3,
      },
    ],
    model_distribution: [],
    model_daily_distribution: [
      { date: "2026-04-01", model: "deepseek-r1", tokens: 42, requests: 3 },
      { date: "2026-04-01", model: "gpt-4o", tokens: 18, requests: 2 },
    ],
  }, new Date("2026-04-03T12:00:00Z"));

  assert.deepEqual(result.data, [
    { date: "2026-04-01", total_tokens: 42, total_interactions: 3 },
    { date: "2026-04-02", total_tokens: 0, total_interactions: 0 },
    { date: "2026-04-03", total_tokens: 0, total_interactions: 0 },
  ]);
  assert.deepEqual(result.model_daily_distribution, [
    { date: "2026-04-01", model: "deepseek-r1", tokens: 42, requests: 3, share: 70 },
    { date: "2026-04-01", model: "gpt-4o", tokens: 18, requests: 2, share: 30 },
    { date: "2026-04-02", model: "暂无模型", tokens: 0, requests: 0, share: 0 },
    { date: "2026-04-03", model: "暂无模型", tokens: 0, requests: 0, share: 0 },
  ]);
});
