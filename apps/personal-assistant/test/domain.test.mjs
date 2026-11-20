import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { profileFor, publishTestNote } from "./helpers.mjs";

test("input identity survives reopen; conflicting payload is refused", (t) => {
  const profile = profileFor(t);
  let store = new Store(profile);
  const first = store.submit("stable-id", { text: "original" });
  store.close();
  store = new Store(profile);
  try {
    const again = store.submit("stable-id", { text: "original" });
    assert.equal(again.workId, first.workId);
    assert.equal(again.duplicate, true);
    assert.throws(
      () => store.submit("stable-id", { text: "other" }),
      /different payload/,
    );
    assert.equal(store.status().works.length, 1);
  } finally {
    store.close();
  }
});

test("failed command rolls back and can reuse its uncommitted input identity", (t) => {
  const s = new Store(profileFor(t));
  t.after(() => s.close());
  assert.throws(
    () => s.amend("amend", { workId: "missing", text: "change" }),
    /Unknown work/,
  );
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM input").get().n, 0);
  const w = s.submit("create", { text: "work" });
  assert.equal(
    s.amend("amend", { workId: w.workId, text: "change" }).revision,
    2,
  );
});

test("result persistence and delivery acceptance are distinct completion levels", async (t) => {
  const s = new Store(profileFor(t));
  t.after(() => s.close());
  const a = s.submit("one", { text: "work" }),
    w = s.work(a.workId);
  s.started(w);
  await publishTestNote(s, w, "real result");
  s.completedExecution(w, "real result");
  assert.equal(s.work(w.id).status, "awaiting_delivery");
  const [d] = s.deliveries();
  s.deliveryFailed(d, new Error("offline"));
  assert.equal(s.work(w.id).status, "awaiting_delivery");
  s.deliveryAccepted(d);
  assert.equal(s.work(w.id).status, "completed");
  assert.equal(s.detail(w.id).results.length, 1);
});

test("amend fences old execution and withdraws its pending delivery", async (t) => {
  const s = new Store(profileFor(t));
  t.after(() => s.close());
  const a = s.submit("one", { text: "original" }),
    old = s.work(a.workId);
  await publishTestNote(s, old, "old result");
  s.completedExecution(old, "old result");
  s.amend("change", { workId: old.id, text: "new scope", expectedRevision: 1 });
  assert.throws(() => s.completedExecution(old, "late"), /superseded/);
  assert.equal(s.detail(old.id).deliveries[0].status, "withdrawn");
  assert.throws(
    () =>
      s.amend("stale", { workId: old.id, text: "stale", expectedRevision: 1 }),
    /Stale/,
  );
});

test("cancel preserves produced result and stops pending delivery", async (t) => {
  const s = new Store(profileFor(t));
  t.after(() => s.close());
  const a = s.submit("one", { text: "work" }),
    w = s.work(a.workId);
  await publishTestNote(s, w, "produced");
  s.completedExecution(w, "produced");
  s.cancel("stop", { workId: w.id });
  assert.equal(s.work(w.id).status, "cancelled");
  assert.equal(s.detail(w.id).results[0].text, "produced");
  assert.equal(s.detail(w.id).deliveries[0].status, "withdrawn");
  assert.throws(
    () => s.amend("revive", { workId: w.id, text: "revive" }),
    /Cancelled/,
  );
});

test("explicit memory correction and forget retain revision and block stale updates", (t) => {
  const s = new Store(profileFor(t));
  t.after(() => s.close());
  s.memoryCommand("m1", "memory.set", { key: "city", value: "上海" });
  s.memoryCommand("m2", "memory.set", {
    key: "city",
    value: "北京",
    expectedRevision: 1,
  });
  assert.equal(s.memories()[0].value, "北京");
  assert.throws(
    () =>
      s.memoryCommand("m3", "memory.set", {
        key: "city",
        value: "旧值",
        expectedRevision: 1,
      }),
    /Stale/,
  );
  s.memoryCommand("m4", "memory.forget", { key: "city", expectedRevision: 2 });
  assert.deepEqual(s.memories(), []);
  assert.equal(s.memoryEpoch(), 3);
});

test("execution context is immutable across reopen and memory changes", (t) => {
  const s = new Store(profileFor(t));
  t.after(() => s.close());
  s.memoryCommand("m1", "memory.set", { key: "city", value: "上海" });
  const a = s.submit("one", { text: "work" }),
    w = s.work(a.workId),
    original = s.executionContext(w);
  s.memoryCommand("m2", "memory.set", { key: "city", value: "北京" });
  assert.deepEqual(s.executionContext(w), original);
  assert.notEqual(original.memoryEpoch, s.memoryEpoch());
});

test("routine persists one coalesced occurrence, avoids overlap, and stops at maxRuns", async (t) => {
  const s = new Store(profileFor(t));
  t.after(() => s.close());
  const now = Date.now();
  const r = s.addRoutine("r", {
    text: "check",
    intervalMs: 1000,
    startAt: now - 10000,
    maxRuns: 2,
  });
  s.tick(now);
  s.tick(now + 100000);
  assert.equal(s.status().works.length, 1);
  assert.equal(s.status().routines[0].created_count, 1);
  const w = s.status().works[0];
  await publishTestNote(s, w, "result");
  s.completedExecution(w, "result");
  s.deliveryAccepted(s.deliveries()[0]);
  s.tick(now + 200000);
  s.tick(now + 300000);
  assert.equal(s.status().works.length, 2);
  assert.equal(s.status().routines[0].status, "exhausted");
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM occurrence").get().n, 2);
  assert.ok(r.routineId);
});

test("paused and expired routines invalidate queued occurrences before any action", (t) => {
  const s = new Store(profileFor(t));
  t.after(() => s.close());
  const now = Date.now();
  const r = s.addRoutine("r", {
    text: "check",
    intervalMs: 1000,
    startAt: now - 1,
  });
  s.tick(now);
  const w = s.status().works[0];
  s.pauseRoutine("pause", { routineId: r.routineId });
  assert.equal(s.work(w.id).status, "cancelled");
  assert.throws(() => s.assertCurrent(w));
  s.addRoutine("expired", {
    text: "late",
    intervalMs: 1000,
    startAt: now - 10000,
    expiresAt: now - 1000,
  });
  s.tick(now);
  assert.equal(s.status().works.length, 1);
  assert.equal(
    s.status().routines.find((x) => x.text === "late").status,
    "expired",
  );
});
