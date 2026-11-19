import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { profileFor } from "./helpers.mjs";
const DAY = 86400000;
function clock(app, initial = Date.now()) {
  let now = initial;
  app.attention.now = () => now;
  app.routines.now = () => now;
  return (days) => {
    now = initial + days * DAY;
    return now;
  };
}
function routine(app, id = "routine") {
  return app.routines.add(id, {
    text: "daily note",
    intervalMs: DAY,
    startAt: Date.now() + 100000,
  });
}

test("guard first nudges, persists across reopen, then pauses schedules without duplicate notices", (t) => {
  const profile = profileFor(t);
  let store = new Store(profile);
  let app = store.app;
  const advance = clock(app),
    r = routine(app);
  for (let i = 0; i < 20; i++) app.attention.fired();
  advance(2);
  app.routines.tick();
  assert.equal(app.attention.status().nudged_at, null);
  advance(3);
  app.routines.tick();
  assert.ok(app.attention.status().nudged_at);
  assert.equal(app.status().routines[0].status, "active");
  const initial = app.attention.status().last_active_at;
  store.close();
  store = new Store(profile);
  t.after(() => store.close());
  app = store.app;
  clock(app, initial)(6);
  app.routines.tick();
  app.routines.tick();
  assert.equal(app.status().routines[0].status, "paused");
  const kinds = app.history.view().messages.map((m) => m.data.kind);
  assert.equal(kinds.filter((k) => k === "routine-guard-nudge").length, 1);
  assert.equal(kinds.filter((k) => k === "routine-guard-paused").length, 1);
  const resumed = app.routines.resume("resume", { routineId: r.routineId });
  assert.equal(resumed.status, "active");
  assert.equal(app.attention.status().paused_at, null);
});

test("explicit conversation view resets counters; model history reads do not", (t) => {
  const store = new Store(profileFor(t));
  t.after(() => store.close());
  const { app } = store,
    advance = clock(app);
  routine(app);
  for (let i = 0; i < 15; i++) app.attention.notified();
  advance(3);
  app.history.view();
  app.routines.tick();
  assert.ok(app.attention.status().nudged_at);
  app.dispatch({ op: "conversation", id: "view", params: {} });
  assert.equal(app.attention.status().unread_count, 0);
  assert.equal(app.attention.status().nudged_at, null);
  advance(7);
  app.routines.tick();
  assert.equal(app.status().routines[0].status, "active");
});

test("new user input cancels pending pause; snooze survives and expires", (t) => {
  const store = new Store(profileFor(t));
  t.after(() => store.close());
  const { app } = store,
    advance = clock(app);
  routine(app);
  for (let i = 0; i < 20; i++) app.attention.fired();
  advance(3);
  app.routines.tick();
  advance(5);
  app.reception.accept("user-returned", { text: "hello" });
  advance(6);
  app.routines.tick();
  assert.equal(app.status().routines[0].status, "active");
  for (let i = 0; i < 20; i++) app.attention.fired();
  app.attention.snooze("snooze", { durationMs: 7 * DAY });
  advance(10);
  app.routines.tick();
  assert.equal(app.attention.status().nudged_at, null);
  advance(14);
  app.routines.tick();
  assert.ok(app.attention.status().nudged_at);
});

test("guard notice and state rollback together when schedule pause fails", (t) => {
  const store = new Store(profileFor(t));
  t.after(() => store.close());
  const { app } = store,
    advance = clock(app);
  routine(app);
  for (let i = 0; i < 20; i++) app.attention.fired();
  advance(3);
  app.routines.tick();
  advance(6);
  const original = app.r.routines.save.bind(app.r.routines);
  app.r.routines.save = () => {
    throw new Error("injected");
  };
  assert.throws(() => app.routines.tick(), /injected/);
  assert.equal(app.attention.status().paused_at, null);
  assert.equal(app.history.view().messages.filter((m) => m.data.kind === "routine-guard-paused").length, 0);
  app.r.routines.save = original;
  app.routines.tick();
  assert.ok(app.attention.status().paused_at);
});
