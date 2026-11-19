import assert from "node:assert/strict";
import { test } from "node:test";
import { ThreadGoalResource } from "../../packages/workbench-runtime/src/thread-goal-resource.ts";
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

test("Goal write acknowledgement succeeds without a confirmation read", async () => {
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
  await resource.set("one", { objective: "after" });
  assert.equal(calls, 1);
  assert.equal(resource.getSnapshot("one").phase, "ready");
  assert.equal(resource.getSnapshot("one").goal?.objective, "after");
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


function replacementFixture() {
  let current: ThreadGoal | null = { ...goal("finished", "complete"), tokensUsed: 1234, timeUsedSeconds: 9000, tokenBudget: 10000 };
  const calls: string[] = [];
  const controls = { failClear: false, unconfirmedClear: false, failSet: false, lostSet: false, failRead: false, finishOnSet: false };
  const resource = new ThreadGoalResource({
    capability: () => ({ version: 1, read: true, write: true }),
    get: async () => { calls.push("get"); if (controls.failRead) throw new Error("read unavailable"); return { goal: current }; },
    clear: async () => { calls.push("clear"); if (controls.failClear) throw new Error("clear unavailable"); if (!controls.unconfirmedClear) current = null; return { cleared: !controls.unconfirmedClear }; },
    set: async (threadId, change) => {
      calls.push("set");
      if (controls.failSet) throw new Error("set unavailable");
      // Native AppServer edits a present Goal; only absence starts fresh usage.
      current = current ? { ...current, ...change } : { ...goal(change.objective!, "active"), threadId, ...change, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 100, updatedAt: 100 };
      if (controls.finishOnSet) current = { ...current, status: "complete" };
      if (controls.lostSet) throw new Error("write outcome unknown");
      return { goal: current };
    },
  });
  return { resource, controls, calls, current: () => current, change: (change: Partial<ThreadGoal>) => { current = { ...current!, ...change }; } };
}

test("completed replacement preserves the native record without any writes", async () => {
  const f = replacementFixture(); await f.resource.refresh("one");
  await assert.rejects(f.resource.create("one", "next"), { code: "atomicReplacementRequired" });
  assert.deepEqual(f.calls, ["get", "get"]);
  assert.equal(f.current()?.objective, "finished");
  assert.equal(f.current()?.tokensUsed, 1234);
});

test("editing and pausing/resuming the current Goal retain accounting", async () => {
  const f = replacementFixture(); f.change({ status: "active" });
  await f.resource.set("one", { objective: "edited" });
  await f.resource.set("one", { status: "paused" });
  await f.resource.set("one", { status: "active" });
  assert.equal(f.current()?.timeUsedSeconds, 9000); assert.equal(f.current()?.tokensUsed, 1234);
  assert.equal(f.calls.includes("clear"), false);
  await assert.rejects(f.resource.create("one", "another"), /unfinished/);
  assert.equal(f.current()?.objective, "edited");
});

test("lost write response is unknown, not a confirmed failure, and is not replayed", async () => {
  const f = replacementFixture(); f.controls.lostSet = true;
  await assert.rejects(f.resource.set("one", { objective: "saved" }), { code: "outcomeUnknown" });
  assert.equal(f.current()?.objective, "saved");
  assert.equal(f.calls.filter(c => c === "set").length, 1);
  assert.equal(f.resource.getSnapshot("one").busy, false);
});

test("acknowledged write after reconnect does not overwrite the new connection", async () => {
  const held = deferred<{ goal: ThreadGoal }>();
  const resource = new ThreadGoalResource({
    capability: () => ({ version: 1, read: true, write: true }),
    get: async () => ({ goal: goal("new host") }),
    set: () => held.promise,
    clear: async () => ({ cleared: true }),
  });
  const pending = resource.set("one", { objective: "old host" });
  resource.reset(); await resource.refresh("one");
  held.resolve({ goal: goal("old host") }); await pending;
  assert.equal(resource.getSnapshot("one").goal?.objective, "new host");
});

test("notification during a write wins over its older acknowledgement", async () => {
  const held = deferred<{ goal: ThreadGoal }>();
  const resource = new ThreadGoalResource({
    capability: () => ({ version: 1, read: true, write: true }),
    get: async () => ({ goal: null }), set: () => held.promise,
    clear: async () => ({ cleared: true }),
  });
  const pending = resource.set("one", { objective: "next" });
  resource.observe("one", goal("next", "complete"));
  held.resolve({ goal: goal("next") }); await pending;
  assert.equal(resource.getSnapshot("one").goal?.status, "complete");
});

test("hydrating or observing a completion never initiates a background clear", async () => {
  const f = replacementFixture(); await f.resource.refresh("one");
  f.resource.observe("one", goal("complete", "complete"));
  assert.equal(f.calls.includes("clear"), false);
  assert.equal(f.resource.getSnapshot("two").completedGoal, null);
  f.resource.reset(); assert.equal(f.resource.getSnapshot("one").completedGoal, null);
});
