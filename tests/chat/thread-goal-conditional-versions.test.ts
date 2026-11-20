import assert from "node:assert/strict";
import { test } from "node:test";
import { ThreadGoalResource } from "../../packages/workbench-runtime/src/thread-goal-resource.ts";
import type { ThreadGoal } from "@opencraft/appserver-protocol/generated/v2";
const goal = (objective: string): ThreadGoal => ({ threadId: "one", objective, status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 });
const capability = () => ({ version: 1 as const, read: true, write: true });

test("conditional write keeps the editor's version rather than rebasing to a newer read", async () => {
  let current = goal("original"); let version = "1"; const writes: unknown[] = [];
  const r = new ThreadGoalResource({ capability, get: async () => ({ goal: current, version }), clear: async () => ({ cleared: true }), set: async (_id, change) => {
    writes.push(change); throw { code: -32009, data: { reason: "goal_version_conflict" } };
  }});
  await r.refresh("one"); const captured = r.getSnapshot("one").version;
  current = goal("another writer"); version = "2"; await r.refresh("one", true);
  await assert.rejects(r.set("one", { objective: "draft", expectedVersion: captured }), { code: "conflict" });
  assert.deepEqual(writes, [{ objective: "draft", expectedVersion: "1" }]);
  assert.equal(r.getSnapshot("one").goal?.objective, "another writer");
});

test("versioned absence uses the native create guard and an ACK does not wait for readback", async () => {
  let current: ThreadGoal | null = null; let version = "2"; let writes = 0;
  const r = new ThreadGoalResource({ capability, get: async () => ({ goal: current, version }), clear: async () => ({ cleared: true }), set: async (_id, change) => {
    writes++; assert.equal(change.expectedVersion, "2"); current = goal(change.objective!); version = "3"; return { goal: current };
  }});
  await r.refresh("one"); await r.create("one", "new", "2");
  assert.equal(writes, 1); assert.equal(r.getSnapshot("one").goal?.objective, "new");
});

test("an old editor cannot silently downgrade after reconnecting to a legacy host", async () => {
  let version: string | undefined = "1"; let writes = 0;
  const r = new ThreadGoalResource({ capability, get: async () => ({ goal: goal("current"), version }), set: async () => { writes++; return { goal: goal("bad") }; }, clear: async () => ({ cleared: true }) });
  await r.refresh("one"); r.reset(); version = undefined; await r.refresh("one");
  await assert.rejects(r.set("one", { objective: "draft", expectedVersion: "1" }), { code: "versionRequired" });
  assert.equal(writes, 0);
});

test("version-aware host cannot lose its token and fall back to an unconditional write", async () => {
  let version: string | undefined = "1"; let writes = 0;
  const r = new ThreadGoalResource({ capability, get: async () => ({ goal: goal("current"), version }), set: async () => { writes++; return { goal: goal("bad") }; }, clear: async () => ({ cleared: true }) });
  await r.refresh("one"); version = undefined;
  await assert.rejects(r.refresh("one", true), { code: "versionRequired" });
  await assert.rejects(r.set("one", { objective: "draft", expectedVersion: null }), { code: "versionRequired" });
  await assert.rejects(r.set("one", { objective: "draft", expectedVersion: "1" }), { code: "versionRequired" });
  assert.equal(writes, 0);
});

test("legacy hosts retain their request shape, without a null precondition", async () => {
  const writes: unknown[] = [];
  const r = new ThreadGoalResource({ capability, get: async () => ({ goal: goal("old") }), set: async (_id, change) => { writes.push(change); return { goal: goal("new") }; }, clear: async () => ({ cleared: true }) });
  await r.refresh("one"); await r.set("one", { objective: "new", expectedVersion: null });
  assert.deepEqual(writes, [{ objective: "new" }]);
});

for (const version of ["", "01", "-1", "9223372036854775808"]) test(`invalid native version is never accepted: ${version}`, async () => {
  let writes = 0;
  const r = new ThreadGoalResource({ capability, get: async () => ({ goal: null, version }), set: async () => { writes++; return { goal: goal("not called") }; }, clear: async () => ({ cleared: true }) });
  await assert.rejects(r.refresh("one"), { code: "versionRequired" });
  await assert.rejects(r.set("one", { objective: "draft", expectedVersion: null }), { code: "versionRequired" });
  assert.equal(writes, 0);
});

test("stale hydration waits for the newest pending read instead of invalidating it again", async () => {
  let reads = 0;
  let resolveA!: (value: { goal: ThreadGoal; version: string }) => void;
  let resolveB!: (value: { goal: ThreadGoal; version: string }) => void;
  const a = new Promise<{ goal: ThreadGoal; version: string }>(resolve => { resolveA = resolve; });
  const b = new Promise<{ goal: ThreadGoal; version: string }>(resolve => { resolveB = resolve; });
  const r = new ThreadGoalResource({ capability, get: () => {
    reads++; return reads === 2 ? a : reads === 3 ? b : Promise.resolve({ goal: goal("current"), version: "2" });
  }, set: async () => ({ goal: goal("unused") }), clear: async () => ({ cleared: true }) });
  await r.refresh("one");
  const oldRead = r.refresh("one", true), newest = r.refresh("one", true);
  resolveA({ goal: goal("old"), version: "1" }); await oldRead;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 3);
  resolveB({ goal: goal("current"), version: "2" }); await newest;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 4); assert.equal(r.getSnapshot("one").version, "2");
});

test("a hot-upgraded native host cannot accept an unversioned write from a legacy cache", async () => {
  let upgraded = false, mutations = 0;
  const r = new ThreadGoalResource({ capability,
    get: async () => ({ goal: goal("current"), ...(upgraded ? { version: "1" } : {}) }),
    set: async (_id, change) => {
      if (change.expectedVersion !== "1") throw { code: -32010, data: { reason: "goal_version_required" } };
      mutations++; return { goal: goal(change.objective!) };
    }, clear: async () => ({ cleared: true }),
  });
  await r.refresh("one"); upgraded = true;
  await assert.rejects(r.set("one", { objective: "draft", expectedVersion: null }), { code: "versionRequired" });
  assert.equal(mutations, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(r.getSnapshot("one").version, "1");
  await assert.rejects(r.set("one", { objective: "draft", expectedVersion: null }), { code: "versionRequired" });
  assert.equal(mutations, 0);
  await r.set("one", { objective: "reviewed", expectedVersion: "1" });
  assert.equal(mutations, 1);
});
