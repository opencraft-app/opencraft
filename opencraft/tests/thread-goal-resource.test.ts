import assert from "node:assert/strict";
import { test } from "node:test";
import { ThreadGoalResource } from "../packages/workbench-runtime/src/thread-goal-resource.ts";
import type { ThreadGoal } from "@opencraft/appserver-protocol/generated/v2";

const goal = (objective: string, status: ThreadGoal["status"] = "active"): ThreadGoal => ({
  threadId: "one", objective, status, tokenBudget: null, tokensUsed: 3,
  timeUsedSeconds: 5, createdAt: 1, updatedAt: 2,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("Goal notification wins over a late hydration read", async () => {
  const first = deferred<{ goal: ThreadGoal | null }>();
  const resource = new ThreadGoalResource({
    capability: () => ({ version: 1, read: true, write: true }),
    get: () => first.promise,
    set: async () => ({ goal: goal("server") }),
    clear: async () => ({ cleared: true }),
  });
  const pending = resource.refresh("one");
  resource.observe("one", goal("new"));
  first.resolve({ goal: goal("old") });
  await pending;
  assert.equal(resource.getSnapshot("one").goal?.objective, "new");
});

test("Goal mutations are single-flight and confirm the refreshed Server state", async () => {
  const held = deferred<{ goal: ThreadGoal }>();
  let server: ThreadGoal | null = goal("before");
  const resource = new ThreadGoalResource({
    capability: () => ({ version: 1, read: true, write: true }),
    get: async () => ({ goal: server }),
    set: () => held.promise,
    clear: async () => { server = null; return { cleared: true }; },
  });
  await resource.refresh("one");
  const changing = resource.set("one", { objective: "after" });
  assert.equal(resource.getSnapshot("one").busy, true);
  await assert.rejects(resource.clear("one"), /already in progress/);
  server = goal("after");
  held.resolve({ goal: server });
  await changing;
  assert.equal(resource.getSnapshot("one").goal?.objective, "after");
  assert.equal(resource.getSnapshot("one").busy, false);
  await resource.clear("one");
  assert.equal(resource.getSnapshot("one").goal, null);
});

test("read-only Host rejects writes without changing the projection", async () => {
  const resource = new ThreadGoalResource({
    capability: () => ({ version: 1, read: true, write: false }),
    get: async () => ({ goal: goal("read only") }),
    set: async () => { throw new Error("not called"); },
    clear: async () => { throw new Error("not called"); },
  });
  await resource.refresh("one");
  await assert.rejects(resource.set("one", { status: "paused" }), /cannot change/);
  assert.equal(resource.getSnapshot("one").goal?.objective, "read only");
});

test("Goal change is not reported successful when confirmation read fails", async () => {
  let calls = 0;
  const resource = new ThreadGoalResource({
    capability: () => ({ version: 1, read: true, write: true }),
    get: async () => {
      if (++calls === 1) return { goal: goal("before") };
      throw new Error("confirmation unavailable");
    },
    set: async () => ({ goal: goal("after") }),
    clear: async () => ({ cleared: true }),
  });
  await resource.refresh("one");
  await assert.rejects(resource.set("one", { objective: "after" }), /confirmation unavailable/);
  assert.equal(resource.getSnapshot("one").phase, "error");
  assert.equal(resource.getSnapshot("one").goal?.objective, "before");
  assert.equal(resource.getSnapshot("one").busy, false);
});

test("reconnect fences late reads from the previous connection", async () => {
  const stale = deferred<{ goal: ThreadGoal | null }>();
  let calls = 0;
  const resource = new ThreadGoalResource({
    capability: () => ({ version: 1, read: true, write: true }),
    get: () => ++calls === 1 ? stale.promise : Promise.resolve({ goal: goal("new connection") }),
    set: async () => ({ goal: goal("new connection") }),
    clear: async () => ({ cleared: true }),
  });
  const unsubscribe = resource.subscribe("one", () => undefined);
  const oldRead = resource.refresh("one");
  resource.reset();
  await resource.refresh("one");
  stale.resolve({ goal: goal("old connection") });
  await oldRead;
  assert.equal(resource.getSnapshot("one").goal?.objective, "new connection");
  unsubscribe();
});
