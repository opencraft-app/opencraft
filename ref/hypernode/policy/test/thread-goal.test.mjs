import assert from "node:assert/strict";
import test from "node:test";

import { ThreadGoalTable } from "../src/services/thread-goal.ts";

function inMemoryTable() {
  const values = new Map();
  const previous = globalThis.policyStore;
  globalThis.policyStore = {
    get: (namespace, key) => values.get(`${namespace}:${key}`) ?? null,
    set: (namespace, key, value) => values.set(`${namespace}:${key}`, value),
    delete: (namespace, key) => values.delete(`${namespace}:${key}`),
  };
  return {
    table: new ThreadGoalTable(null),
    restore: () => {
      if (previous === undefined) delete globalThis.policyStore;
      else globalThis.policyStore = previous;
    },
  };
}

test("thread goal lifecycle is stable and engine-neutral", () => {
  const { table, restore } = inMemoryTable();
  const originalNow = Date.now;
  try {
    Date.now = () => 1_000_000;
    const created = table.set({
      threadId: "thread-1",
      objective: "Ship the canonical timeline",
      tokenBudget: 200_000,
    });
    assert.deepEqual(created, {
      threadId: "thread-1",
      objective: "Ship the canonical timeline",
      status: "active",
      tokenBudget: 200_000,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1000,
      updatedAt: 1000,
    });

    Date.now = () => 1_060_000;
    const updated = table.set({ threadId: "thread-1", status: "blocked" });
    assert.equal(updated.objective, created.objective);
    assert.equal(updated.status, "blocked");
    assert.equal(updated.createdAt, 1000);
    assert.equal(updated.updatedAt, 1060);
    assert.deepEqual(table.get("thread-1"), updated);
    assert.equal(table.clear("thread-1"), true);
    assert.equal(table.clear("thread-1"), false);
    assert.equal(table.get("thread-1"), null);
  } finally {
    Date.now = originalNow;
    restore();
  }
});

test("thread goal creation requires an objective and validates protocol fields", () => {
  const { table, restore } = inMemoryTable();
  try {
    assert.throws(() => table.set({ threadId: "thread-1" }), /objective is required/);
    assert.throws(
      () => table.set({ threadId: "thread-1", objective: "x", tokenBudget: 0 }),
      /positive integer/,
    );
  } finally {
    restore();
  }
});
