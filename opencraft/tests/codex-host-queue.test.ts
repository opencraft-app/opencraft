import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { CodexHostQueue } from "../apps/opencraft-daemon/src/codex-host-queue.js";

test("Host queue claims survive restart as delivery-unknown and never re-enter the pending head", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-queue-store-"));
  try {
    const first = new CodexHostQueue(root);
    const item = first.add("thread-1", "message-1", [{ type: "text", text: "hello" }]);
    assert.equal(first.add("thread-1", "message-1", item.input).id, item.id);
    assert.throws(() => first.add("thread-1", "message-1", [{ type: "text", text: "changed" }]));
    assert.equal(first.claim("thread-1", item.id, "turn-1")?.state, "dispatching");
    assert.equal(first.claim("thread-1", item.id, "turn-1"), null);
    assert.throws(() => first.reorder("thread-1", []), /Reconcile in-flight/);
    first.close();

    const recovered = new CodexHostQueue(root);
    assert.equal(recovered.firstUnsettled("thread-1")?.state, "unknown");
    assert.equal(recovered.firstUnsettled("thread-1")?.pausedReason, "steer-delivery-unconfirmed");
    assert.equal(recovered.discardUnknown("thread-1", item.id, "wrong-turn"), false);
    assert.equal(recovered.discardUnknown("thread-1", item.id, "turn-1"), true);
    assert.deepEqual(recovered.list("thread-1"), []);
    recovered.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("accepted steer remains visible for reconciliation without blocking admission of the next queued item", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-queue-admission-"));
  try {
    const queue = new CodexHostQueue(root);
    const first = queue.add("thread-1", "message-1", [{ type: "text", text: "first" }]);
    const second = queue.add("thread-1", "message-2", [{ type: "text", text: "second" }]);
    assert.equal(queue.firstAwaitingAdmission("thread-1")?.id, first.id);
    queue.claim("thread-1", first.id, "turn-1");
    assert.equal(queue.firstAwaitingAdmission("thread-1")?.state, "dispatching");
    queue.settle("thread-1", first.id, "steering");
    assert.equal(queue.firstUnsettled("thread-1")?.id, first.id);
    assert.equal(queue.firstAwaitingAdmission("thread-1")?.id, second.id);
    queue.reorder("thread-1", [second.id]);
    queue.claim("thread-1", second.id, "turn-1");
    queue.settle("thread-1", second.id, "unknown", "steer-delivery-unconfirmed");
    assert.equal(queue.firstAwaitingAdmission("thread-1")?.id, second.id);
    assert.equal(queue.firstAwaitingAdmission("thread-1")?.state, "unknown");
    assert.throws(() => queue.reorder("thread-1", []), /Reconcile in-flight/);
    queue.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native queued rows migrate before Codex starts and replaying migration is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-queue-migrate-"));
  const nativeRoot = join(root, "runtime");
  try {
    await mkdir(nativeRoot);
    const native = new DatabaseSync(join(nativeRoot, "queue_1.sqlite"));
    native.exec("CREATE TABLE queued_items (id TEXT PRIMARY KEY, thread_id TEXT, payload_json TEXT, queue_order INTEGER, created_at_ms INTEGER, steering_turn_id TEXT)");
    native.prepare("INSERT INTO queued_items VALUES(?,?,?,?,?,?)").run("old-1", "thread-1",
      JSON.stringify({ UserInput: { content: [{ type: "text", text: "old" }], client_id: "client-old" } }), 1, 123, null);
    native.close();

    const queue = new CodexHostQueue(root);
    assert.equal(queue.migrateNativeQueue(nativeRoot), 1);
    assert.equal(queue.migrateNativeQueue(nativeRoot), 0);
    assert.equal(queue.firstUnsettled("thread-1")?.clientUserMessageId, "client-old");
    const after = new DatabaseSync(join(nativeRoot, "queue_1.sqlite"));
    assert.equal((after.prepare("SELECT COUNT(*) AS count FROM queued_items").get() as { count: number }).count, 0);
    after.close();
    queue.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("deleting a Thread retires its Host-owned queued inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-queue-delete-"));
  try {
    const queue = new CodexHostQueue(root);
    queue.add("thread-1", "message-1", [{ type: "text", text: "one" }]);
    queue.add("thread-1", "message-2", [{ type: "text", text: "two" }]);
    assert.equal(queue.discardThread("thread-1"), 2);
    assert.deepEqual(queue.list("thread-1"), []);
    queue.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
