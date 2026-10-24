import assert from "node:assert/strict";
import { test } from "node:test";
import { ThreadGoalResource } from "../../packages/workbench-runtime/src/thread-goal-resource.ts";
import { observeSidebarThreadGoals, sidebarGoalSignature } from "../../apps/workbench-web/src/runtime/sidebar-thread-goals.ts";
import type { ThreadGoal } from "@opencraft/appserver-protocol/generated/v2";

const goal = (threadId: string, status: ThreadGoal["status"] = "active"): ThreadGoal => ({ threadId, objective: "Synthetic goal", status,
  tokenBudget: null, tokensUsed: 1, timeUsedSeconds: 2, createdAt: 1, updatedAt: 2 });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function harness(ids = ["one"], unsupportedIds: readonly string[] = []) {
  const calls: string[] = [], releases: Array<() => void> = [];
  let current = true, read = true, concurrency = 0, maximum = 0;
  const goals = new ThreadGoalResource({
    capability: id => read && !unsupportedIds.includes(id ?? "") ? { version: 1, read: true, write: false } : null,
    get: async id => { calls.push(id); maximum = Math.max(maximum, ++concurrency);
      await new Promise<void>(resolve => releases.push(resolve)); concurrency--; return { goal: goal(id) }; },
    set: async () => { throw new Error("No mutation allowed"); }, clear: async () => { throw new Error("No mutation allowed"); },
  });
  const source = { goals, threadIds: ids, isCurrent: () => current };
  return { goals, calls, source, releases, maximum: () => maximum, revoke: () => { current = false; }, unsupported: () => { read = false; },
    flush: async () => { while (releases.length) { releases.splice(0).forEach(resolve => resolve()); await tick(); } } };
}

test("sidebar hydrates at most 50 rows and 3 concurrent reads, including observer replacement", async () => {
  const h = harness(Array.from({ length: 60 }, (_, i) => String(i)));
  const stop = observeSidebarThreadGoals(h.source, () => {});
  assert.equal(h.calls.length, 3); stop();
  const stopNext = observeSidebarThreadGoals(h.source, () => {});
  assert.equal(h.calls.length, 3); await h.flush(); stopNext();
  assert.equal(h.calls.length, 50); assert.equal(h.maximum(), 3);
});

test("revocation and disposal stop queued reads without connecting or mutating a Thread", async () => {
  for (const dispose of [true, false]) {
    const h = harness(["one", "two", "three", "four"]);
    const stop = observeSidebarThreadGoals(h.source, () => {});
    if (dispose) stop(); else h.revoke();
    await h.flush(); stop(); assert.equal(h.calls.length, 3);
    if (!dispose) assert.equal(sidebarGoalSignature([h.source]), "");
  }
});

test("capability absence and stale Host admission do not read Goal metadata", () => {
  for (const revoke of [true, false]) {
    const h = harness(); if (revoke) h.revoke(); else h.unsupported();
    const stop = observeSidebarThreadGoals(h.source, () => {});
    assert.equal(h.calls.length, 0); assert.equal(sidebarGoalSignature([h.source]), ""); stop();
  }
});

test("mixed-engine catalog skips unsupported idle Threads before scheduling any read", async () => {
  const h = harness(["pi_one", "one", "pi_two", "two", "three", "four"], ["pi_one", "pi_two"]);
  const scheduled: string[] = [];
  const refresh = h.goals.refresh.bind(h.goals);
  h.goals.refresh = (id, force) => { scheduled.push(id); return refresh(id, force); };
  const stop = observeSidebarThreadGoals(h.source, () => {});
  try {
    // Assert before yielding: the broken scheduler's no-op promises can starve
    // timers forever. finally disposes it even when this negative control fails.
    assert.deepEqual(scheduled, ["one", "two", "three"]);
    await h.flush();
    await tick();
    assert.deepEqual(scheduled, ["one", "two", "three", "four"]);
    assert.equal(h.maximum(), 3);
    assert.equal(h.goals.getSnapshot("pi_one").phase, "idle");
    assert.equal(sidebarGoalSignature([h.source]), "010111");
  } finally { stop(); }
});

test("an all-unsupported catalog stays idle without scheduling no-op reads or stale activity", async () => {
  const h = harness(["pi_one"], ["pi_one"]);
  h.goals.observe("pi_one", goal("pi_one"));
  let scheduled = 0;
  const refresh = h.goals.refresh.bind(h.goals);
  h.goals.refresh = (id, force) => { scheduled++; return refresh(id, force); };
  const stop = observeSidebarThreadGoals(h.source, () => {});
  try {
    assert.equal(sidebarGoalSignature([h.source]), "0");
    h.goals.reset();
    assert.equal(scheduled, 0);
    await tick();
    assert.equal(scheduled, 0);
  } finally { stop(); }
});

test("native updates, pause, completion and clear change the mode while counters do not", async () => {
  const h = harness(), other = harness();
  const stop = observeSidebarThreadGoals(h.source, () => {}); await h.flush();
  assert.equal(sidebarGoalSignature([h.source, other.source]), "1|0");
  h.goals.observe("one", { ...goal("one"), tokensUsed: 400 });
  assert.equal(sidebarGoalSignature([h.source, other.source]), "1|0");
  for (const status of ["paused", "blocked", "usageLimited", "budgetLimited", "complete"] as const) {
    h.goals.observe("one", goal("one", status)); assert.equal(sidebarGoalSignature([h.source]), "0");
  }
  h.goals.observe("one", goal("one")); assert.equal(sidebarGoalSignature([h.source]), "1");
  h.goals.observe("one", null); assert.equal(sidebarGoalSignature([h.source]), "0"); stop();
});

test("reset invalidates catalog-only cache and rehydrates from the new connection", async () => {
  const h = harness(); const stop = observeSidebarThreadGoals(h.source, () => {}); await h.flush();
  assert.equal(sidebarGoalSignature([h.source]), "1");
  h.goals.reset(); assert.equal(sidebarGoalSignature([h.source]), "0");
  await h.flush(); assert.equal(h.calls.length, 2); assert.equal(sidebarGoalSignature([h.source]), "1");
  stop(); h.goals.reset(); assert.equal(h.goals.getSnapshot("one").phase, "idle");
});

test("failed hydration is quiet and does not retry on another row notification", async () => {
  let calls = 0;
  const goals = new ThreadGoalResource({ capability: () => ({ version: 1, read: true, write: false }),
    get: async () => { calls++; throw new Error("Unavailable"); }, set: async () => { throw 0; }, clear: async () => { throw 0; } });
  const source = { goals, threadIds: ["one"], isCurrent: () => true };
  const stop = observeSidebarThreadGoals(source, () => {}); await tick();
  goals.observe("other", goal("other")); await tick();
  assert.equal(calls, 1); assert.equal(sidebarGoalSignature([source]), "0"); stop();
});

test("durably active but disarmed Goal does not advertise autonomous activity", () => {
  const h = harness();
  const disarmed = { ...goal("one"), execution: { activation: "disarmed" } };
  h.goals.observe("one", disarmed);
  assert.equal(sidebarGoalSignature([h.source]), "0");
  h.goals.observe("one", { ...goal("one"), execution: { activation: "armed" } });
  assert.equal(sidebarGoalSignature([h.source]), "1");
});
