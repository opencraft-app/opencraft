import assert from "node:assert/strict";
import test from "node:test";

import {
  ThreadActivityTracker,
  ThreadWriteLeaseTable,
  editWarningMessage,
  formatEditAge,
} from "../src/services/thread-write-lease.js";

function connection(username, connectionId) {
  return {
    connectionId,
    identity: { id: `user:${username}`, username },
  };
}

test("one connection owns a thread write lease at a time", () => {
  const leases = new ThreadWriteLeaseTable();
  const alice = connection("alice", "alice-1");
  const bob = connection("bob", "bob-1");

  assert.equal(leases.acquire("thread-1", alice, "editing", 1_000).acquired, true);
  const conflict = leases.acquire("thread-1", bob, "running", 2_000);
  assert.equal(conflict.acquired, false);
  assert.equal(conflict.lease.holderUsername, "alice");
  assert.equal(leases.release("thread-1", bob), null);
  assert.equal(leases.release("thread-1", alice).holderUsername, "alice");
  assert.equal(leases.acquire("thread-1", bob, "running", 3_000).acquired, true);
});

test("different threads that share one workspace view share one writer lease", () => {
  const leases = new ThreadWriteLeaseTable();
  const alice = connection("alice", "alice-1");
  const bob = connection("bob", "bob-1");
  assert.equal(leases.acquire("thread-a", alice, "editing", 1_000, "workspace:main").acquired, true);
  const conflict = leases.acquire("thread-b", bob, "running", 2_000, "workspace:main");
  assert.equal(conflict.acquired, false);
  assert.equal(conflict.lease.threadId, "thread-a");
  assert.equal(leases.acquire("thread-b", bob, "running", 2_000, "workspace:fork-b").acquired, true);
});

test("editing leases expire after twenty seconds and heartbeats extend them", () => {
  const leases = new ThreadWriteLeaseTable({ editTtlMs: 20_000 });
  const alice = connection("alice", "alice-1");
  leases.acquire("thread-1", alice, "editing", 1_000);
  assert.equal(leases.get("thread-1", 20_999)?.holderUsername, "alice");
  assert.equal(leases.heartbeat("thread-1", alice, 10_000).renewed, true);
  assert.equal(leases.get("thread-1", 29_999)?.holderUsername, "alice");
  assert.equal(leases.get("thread-1", 30_000), null);
});

test("running leases do not expire while a turn is active", () => {
  const leases = new ThreadWriteLeaseTable();
  const alice = connection("alice", "alice-1");
  leases.acquire("thread-1", alice, "running", 1_000);
  assert.equal(leases.get("thread-1", 100_000)?.phase, "running");
});

test("a disconnected writer receives a bounded recovery window", () => {
  const leases = new ThreadWriteLeaseTable({ disconnectTtlMs: 20_000 });
  const alice = connection("alice", "alice-1");
  leases.acquire("thread-1", alice, "running", 1_000);
  leases.disconnect(alice, 5_000);
  assert.equal(leases.get("thread-1", 24_999)?.phase, "disconnected");
  assert.equal(leases.get("thread-1", 25_000), null);
});

test("lease table lists only unexpired active threads", () => {
  const leases = new ThreadWriteLeaseTable({ editTtlMs: 20_000 });
  const alice = connection("alice", "alice-1");
  const bob = connection("bob", "bob-1");
  leases.acquire("expired", alice, "editing", 1_000);
  leases.acquire("running", bob, "running", 2_000);
  assert.deepEqual(leases.list(21_000).map((lease) => lease.threadId), ["running"]);
});

test("last-editor warnings use stable human-readable relative time", () => {
  const now = 10 * 86_400_000;
  assert.equal(formatEditAge(now - 30_000, now), "不到 1 min");
  assert.equal(formatEditAge(now - 12 * 60_000, now), "12 min");
  assert.equal(formatEditAge(now - 3 * 3_600_000, now), "3 h");
  assert.equal(formatEditAge(now - 2 * 86_400_000, now), "2 d");
  assert.equal(editWarningMessage({ editorUsername: "alice", editedAtMs: now - 12 * 60_000 }, now),
    "此会话于 12 min 前被 alice 编辑。");
});

test("activity streak continues within fifteen minutes and resets after the gap", () => {
  const tracker = new ThreadActivityTracker();
  const lease = {
    threadId: "thread-1",
    holderPrincipalId: "user:alice",
    holderUsername: "alice",
  };
  assert.equal(tracker.observe(lease, 1_000).activeSinceMs, 1_000);
  assert.equal(tracker.observe(lease, 1_000 + 15 * 60_000).activeSinceMs, 1_000);
  assert.equal(tracker.observe(lease, 1_001 + 30 * 60_000).activeSinceMs, 1_001 + 30 * 60_000);
});
