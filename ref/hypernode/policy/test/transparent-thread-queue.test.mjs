import assert from "node:assert/strict";
import test from "node:test";
import { ThreadQueueStore } from "../src/services/transparent-thread-queue.ts";

function store() {
  let sequence = 0;
  let now = 100;
  return new ThreadQueueStore(
    { available: false, sql: null, transactionSync: (callback) => callback() },
    () => `submission-${++sequence}`,
    () => ++now,
  );
}

test("queued submissions are idempotent by client user-message id", () => {
  const queue = store();
  const first = queue.add("thread-1", "client-1", "user-1", [
    { type: "text", text: "hello" },
  ]);
  const retry = queue.add("thread-1", "client-1", "user-1", [
    { type: "text", text: "must not replace the original" },
  ]);

  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.deepEqual(retry.submission, first.submission);
  assert.equal(queue.pending("thread-1").length, 1);

  queue.markDispatched("thread-1", first.submission.id);
  const lateRetry = queue.add("thread-1", "client-1", "user-1", []);
  assert.equal(lateRetry.created, false);
  assert.equal(lateRetry.submission.state, "dispatched");
  assert.deepEqual(queue.pending("thread-1"), []);
});

test("queued submissions support edit, reorder, delete and actor recovery", () => {
  const queue = store();
  const first = queue.add("thread-1", "client-1", "user-1", []).submission;
  const second = queue.add("thread-1", "client-2", "user-1", []).submission;

  assert.equal(queue.reorder("thread-1", [second.id, first.id]), true);
  assert.deepEqual(
    queue.pending("thread-1").map((row) => row.id),
    [second.id, first.id],
  );
  assert.equal(queue.reorder("thread-1", [first.id]), false);

  const updated = queue.update("thread-1", second.id, [
    { type: "text", text: "changed" },
  ]);
  assert.deepEqual(updated.input, [{ type: "text", text: "changed" }]);
  assert.deepEqual(queue.pendingThreadsForActor("user-1"), ["thread-1"]);

  assert.equal(queue.delete("thread-1", second.id), true);
  assert.equal(queue.delete("thread-1", second.id), false);
  assert.deepEqual(
    queue.pending("thread-1").map((row) => row.id),
    [first.id],
  );
});

test("an interrupted queue remains paused until an explicit resume", () => {
  const queue = store();
  queue.add("thread-1", "client-1", "user-1", []);
  assert.equal(queue.isPaused("thread-1"), false);
  queue.pauseAfterInterruption("thread-1");
  assert.equal(queue.isPaused("thread-1"), true);
  assert.equal(queue.pending("thread-1").length, 1);
  queue.resume("thread-1");
  assert.equal(queue.isPaused("thread-1"), false);
});

test("an empty queue cannot retain a stale interruption pause", () => {
  const queue = store();
  queue.pauseAfterInterruption("thread-empty");
  assert.equal(queue.isPaused("thread-empty"), false);

  const pending = queue.add("thread-1", "client-1", "user-1", []).submission;
  queue.pauseAfterInterruption("thread-1");
  assert.equal(queue.isPaused("thread-1"), true);
  assert.equal(queue.delete("thread-1", pending.id), true);
  assert.equal(queue.isPaused("thread-1"), false);
});
