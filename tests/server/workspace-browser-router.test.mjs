import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createWorkspaceBrowserRouter } from "../../apps/headless-server/src/workspaces/workspace-browser-router.mjs";
const tick = () => new Promise((resolve) => setImmediate(resolve));
function lease() {
  const sent = [];
  let alive = true,
    connects = 0,
    kills = 0;
  const peer = Object.assign(new EventEmitter(), {
    connected: true,
    automationCancellation: 1,
    automationNavigation: 1,
    send(m, cb) {
      sent.push(m);
      cb?.();
    },
    kill() {
      kills++;
    },
  });
  const target = {
    assertCurrent() {
      if (!alive) throw Error("retired");
    },
    async connect() {
      connects++;
      return peer;
    },
  };
  return {
    target,
    peer,
    sent,
    revoke() {
      alive = false;
    },
    get connects() {
      return connects;
    },
    get kills() {
      return kills;
    },
  };
}
const message = (id, page) => ({ id, page, method: "snapshot" });
test("lazy router isolates two leases, correlates replies and fences foreign events", async () => {
  const a = lease(),
    b = lease();
  const r = createWorkspaceBrowserRouter({ resolve: async (p) => (p === "a" ? a.target : b.target) });
  assert.equal(r.inventoryComplete, false);
  assert.equal(a.connects, 0);
  const got = [];
  r.on("message", (m) => got.push(m));
  r.send(message("1", "a"));
  r.send(message("2", "b"));
  await tick();
  assert.equal(a.connects, 1);
  assert.equal(b.connects, 1);
  a.peer.emit("message", { type: "result", id: "2", value: "foreign" });
  a.peer.emit("message", { type: "frame", page: "b", bytes: "foreign" });
  assert.equal(got.length, 0);
  b.peer.emit("message", { type: "result", id: "2", value: "owned" });
  a.peer.emit("message", { type: "frame", page: "a", bytes: "owned" });
  assert.equal(got.length, 2);
  r.send(message("3", "a"));
  await tick();
  assert.equal(a.connects, 1);
  await r.close();
  assert.equal(r.connected, false);
  assert.equal(a.kills, 1);
  assert.equal(b.kills, 1);
});
test("retired authority suppresses frames and retires all transports without replay", async () => {
  const a = lease();
  const r = createWorkspaceBrowserRouter({ resolve: async () => a.target });
  let frames = 0,
    exits = 0;
  r.on("message", () => frames++);
  r.on("exit", () => exits++);
  r.send(message("1", "a"));
  await tick();
  a.revoke();
  a.peer.emit("message", { type: "frame", page: "a", bytes: "secret" });
  assert.equal(frames, 0);
  assert.equal(exits, 1);
  assert.equal(a.sent.length, 1);
  await r.close();
});
test("closing during lazy attachment kills late peer before dispatch", async () => {
  const a = lease();
  let release;
  a.target.connect = () => new Promise((resolve) => (release = () => resolve(a.peer)));
  const r = createWorkspaceBrowserRouter({ resolve: async () => a.target });
  r.send(message("1", "a"));
  await tick();
  const closed = r.close();
  release();
  await closed;
  await tick();
  assert.equal(a.sent.length, 0);
  assert.equal(a.kills, 1);
});
test("cancel before admission completes prevents native execution", async () => {
  const a = lease();
  let release;
  const r = createWorkspaceBrowserRouter({
    resolve: () => new Promise((resolve) => (release = () => resolve(a.target))),
  });
  r.send({ ...message("1", "a"), method: "automation" });
  r.send({ id: "cancel", page: "a", method: "cancelAutomation", input: { requestId: "1" } });
  release();
  await tick();
  assert.equal(a.sent.length, 0);
  assert.equal(r.connected, false);
  await r.close();
});
test("missing capability fails without a local fallback", async () => {
  const a = lease();
  a.peer.automationNavigation = 0;
  const r = createWorkspaceBrowserRouter({ resolve: async () => a.target });
  r.send(message("1", "a"));
  await tick();
  assert.equal(a.sent.length, 0);
  assert.equal(r.connected, false);
  await r.close();
});
test("request is snapshotted and pending budget is bounded", async () => {
  const a = lease();
  let release;
  const r = createWorkspaceBrowserRouter({
    maxPending: 1,
    resolve: () => new Promise((resolve) => (release = () => resolve(a.target))),
  });
  const m = message("1", "a");
  r.send(m);
  m.page = "foreign";
  let rejected = false;
  r.send(message("2", "b"), (e) => (rejected = Boolean(e)));
  assert.equal(rejected, true);
  release();
  await tick();
  assert.equal(a.sent[0].page, "a");
  await r.close();
});
test("owner disconnect rejects attachment lifetime and ignores late replies", async () => {
  const a = lease();
  const r = createWorkspaceBrowserRouter({ resolve: async () => a.target });
  let replies = 0;
  r.on("message", () => replies++);
  r.send(message("1", "a"));
  await tick();
  a.peer.emit("exit");
  a.peer.emit("message", { type: "result", id: "1", value: "late" });
  assert.equal(replies, 0);
  assert.equal(r.connected, false);
  await r.close();
});

test("concurrent changed incarnation cannot replace a page route after attachment await", async () => {
  const a = lease(),
    b = lease();
  let release,
    calls = 0;
  a.target.connect = () => new Promise((resolve) => (release = () => resolve(a.peer)));
  const r = createWorkspaceBrowserRouter({ resolve: async () => (++calls === 1 ? a.target : b.target) });
  r.send(message("1", "same"));
  await tick();
  r.send(message("2", "same"));
  await tick();
  assert.equal(b.sent.length, 1);
  release();
  await tick();
  assert.equal(a.sent.length, 0);
  assert.equal(r.connected, false);
  await r.close();
});
test("unanswered requests retire the transport rather than leak pending correlations", async () => {
  const a = lease();
  const r = createWorkspaceBrowserRouter({ resolve: async () => a.target, timeoutMs: 5 });
  r.send(message("1", "a"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(r.connected, false);
  assert.equal(a.kills, 1);
  await r.close();
});

test("shared close drain reports underlying proxy cleanup failure", async () => {
  const a = lease();
  a.peer.close = async () => {
    throw Error("proxy cleanup");
  };
  const r = createWorkspaceBrowserRouter({ resolve: async () => a.target });
  r.send(message("1", "a"));
  await tick();
  const closed = r.close();
  assert.strictEqual(r.close(), closed);
  await assert.rejects(closed, /cleanup unconfirmed/);
});
test("late rejected attachment still drains its returned peer", async () => {
  const a = lease();
  let release,
    drains = 0;
  a.peer.close = async () => {
    drains++;
  };
  a.target.connect = () => new Promise((resolve) => (release = () => resolve(a.peer)));
  const r = createWorkspaceBrowserRouter({ resolve: async () => a.target });
  r.send(message("1", "a"));
  await tick();
  const closing = r.close();
  release();
  await closing;
  assert.equal(drains, 1);
  assert.equal(a.sent.length, 0);
});

test("old replies cannot borrow a refreshed route guard", async () => {
  const a = lease();
  let revision = 1;
  const got = [];
  const r = createWorkspaceBrowserRouter({
    resolve: async () => a.target,
    captureRoute: () => {
      const captured = revision;
      return () => {
        if (captured !== revision) throw Error("route changed");
      };
    },
  });
  r.on("message", (m) => got.push(m));
  r.send(message("old", "a"));
  await tick();
  revision = 2;
  r.send(message("new", "a"));
  await tick();
  a.peer.emit("message", { type: "result", id: "old", value: "must-not-leak" });
  a.peer.emit("message", { type: "result", id: "new", value: "new" });
  assert.equal(got[0].value, undefined);
  assert.equal(got[0].error.outcome, "unknown");
  assert.equal(got[1].value, "new");
  await r.close();
});
test("route changed while owner attachment waits prevents native dispatch", async () => {
  const a = lease();
  let release,
    valid = true;
  a.target.connect = () => new Promise((resolve) => (release = () => resolve(a.peer)));
  const r = createWorkspaceBrowserRouter({
    resolve: async () => a.target,
    captureRoute: () => () => {
      if (!valid) throw Error("changed");
    },
  });
  r.send(message("1", "a"));
  await tick();
  valid = false;
  release();
  await tick();
  assert.equal(a.sent.length, 0);
  assert.equal(r.connected, false);
  await r.close();
});

test("unsolicited frames are dropped after their durable route becomes invalid", async () => {
  const a = lease();
  let valid = true,
    frames = 0;
  const r = createWorkspaceBrowserRouter({
    resolve: async () => a.target,
    captureRoute: () => {
      if (!valid) throw Error("removed");
      return () => {
        if (!valid) throw Error("removed");
      };
    },
  });
  r.on("message", () => frames++);
  r.send(message("1", "a"));
  await tick();
  valid = false;
  a.peer.emit("message", { type: "frame", page: "a", bytes: "private" });
  assert.equal(frames, 0);
  await r.close();
});

test("proved stale preparation rejects only that request without poisoning another admitted close", async () => {
  const a = lease();
  let changed = true;
  const replies = [];
  const r = createWorkspaceBrowserRouter({
    resolve: async () => {
      if (changed) throw Object.assign(Error("stale"), { code: "BROWSER_ROUTE_STALE", outcome: "not-dispatched" });
      return a.target;
    },
  });
  r.on("message", (message) => replies.push(message));
  r.send(message("old", "a"));
  await tick();
  assert.equal(r.connected, true);
  assert.equal(a.connects, 0);
  assert.equal(replies[0].error.outcome, "not-dispatched");
  changed = false;
  r.send({ ...message("close", "a"), method: "close" });
  await tick();
  assert.equal(a.sent.length, 1);
  assert.equal(a.sent[0].id, "close");
  await r.close();
});
