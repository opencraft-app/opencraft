import test from "node:test";
import assert from "node:assert/strict";

import { ensureItems, ensureUsageLogsSummary } from "./page-null-guards.ts";

test("ensureItems returns an empty array for nullish values", () => {
  assert.deepEqual(ensureItems(null), []);
  assert.deepEqual(ensureItems(undefined), []);
});

test("ensureItems returns the original array when items exist", () => {
  const items = [{ id: "one" }, { id: "two" }];

  assert.equal(ensureItems(items), items);
});

test("ensureUsageLogsSummary falls back to zeros when summary is missing", () => {
  assert.deepEqual(ensureUsageLogsSummary(undefined), {
    total_requests: 0,
    total_tokens: 0,
  });

  assert.deepEqual(ensureUsageLogsSummary(null), {
    total_requests: 0,
    total_tokens: 0,
  });
});

test("ensureUsageLogsSummary preserves present fields and defaults missing ones", () => {
  assert.deepEqual(ensureUsageLogsSummary({ total_requests: 12 }), {
    total_requests: 12,
    total_tokens: 0,
  });
});
