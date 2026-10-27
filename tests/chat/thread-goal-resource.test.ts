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

test("new Goal clears the completed native record and starts fresh accounting", async () => {
  const f = replacementFixture(); await f.resource.refresh("one");
  await f.resource.create("one", "next");
  assert.deepEqual(f.calls, ["get", "get", "clear", "get", "set", "get"]);
  const next = f.resource.getSnapshot("one").goal!;
  assert.equal(next.objective, "next"); assert.equal(next.status, "active");
  assert.equal(next.createdAt, 100); assert.equal(next.timeUsedSeconds, 0);
  assert.equal(next.tokensUsed, 0); assert.equal(next.tokenBudget, null);
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

for (const failure of ["failClear", "unconfirmedClear"] as const) test(`new Goal is not sent after ${failure}`, async () => {
  const f = replacementFixture(); f.controls[failure] = true;
  await assert.rejects(f.resource.create("one", "next"));
  assert.equal(f.current()?.objective, "finished"); assert.equal(f.calls.includes("set"), false);
});

test("failed new Goal preserves a completed summary and draft retry without inventing server state", async () => {
  const f = replacementFixture(); f.controls.failSet = true;
  await assert.rejects(f.resource.create("one", "next"), /set unavailable/);
  assert.equal(f.resource.getSnapshot("one").goal, null);
  assert.equal(f.resource.getSnapshot("one").completedGoal?.objective, "finished");
  assert.equal(f.resource.getSnapshot("one").completedGoal?.timeUsedSeconds, 9000);
  f.controls.failSet = false; await f.resource.create("one", "next");
  assert.equal(f.current()?.timeUsedSeconds, 0);
  await f.resource.clear("one"); assert.equal(f.resource.getSnapshot("one").completedGoal, null);
});

test("unknown creation which completed before retry is confirmed without starting it again", async () => {
  const f = replacementFixture(); f.controls.lostSet = true; f.controls.finishOnSet = true;
  await assert.rejects(f.resource.create("one", "next"), /unknown/);
  f.controls.lostSet = false;
  await f.resource.create("one", "next");
  assert.equal(f.current()?.status, "complete"); assert.equal(f.calls.filter(c => c === "set").length, 1);
  assert.equal(f.calls.filter(c => c === "clear").length, 1);
});

test("Goal creation cannot continue after the connection changes during removal", async () => {
  const removed = deferred<{ cleared: boolean }>(); let sets = 0;
  const resource = new ThreadGoalResource({
    capability: () => ({ version: 1, read: true, write: true }),
    get: async () => ({ goal: goal("old", "complete") }),
    clear: () => removed.promise,
    set: async () => { sets++; return { goal: goal("new") }; },
  });
  const pending = resource.create("one", "new"); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(resource.create("one", "new"), /already in progress/);
  resource.reset(); removed.resolve({ cleared: true });
  await assert.rejects(pending, /connection changed/);
  assert.equal(sets, 0); assert.equal(resource.getSnapshot("one").goal, null);
});

test("hydrating or observing a completion never initiates a background clear", async () => {
  const f = replacementFixture(); await f.resource.refresh("one");
  f.resource.observe("one", goal("complete", "complete"));
  assert.equal(f.calls.includes("clear"), false);
  assert.equal(f.resource.getSnapshot("two").completedGoal, null);
  f.resource.reset(); assert.equal(f.resource.getSnapshot("one").completedGoal, null);
});
