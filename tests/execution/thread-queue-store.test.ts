import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { nodeSqlDatabase } from "@opencraft/sqlite-node";
import type { SqlDatabase } from "@opencraft/sql";
import test from "node:test";
import { THREAD_QUEUE_SCHEMA, ThreadQueueStore } from "../../packages/thread-queue/src/index.ts";

const text = (value: string) => [{ type: "text", text: value }];
function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(THREAD_QUEUE_SCHEMA);
  // The queue borrows the SQL port; the test owns the node:sqlite connection.
  return nodeSqlDatabase(db);
}

test("the shared queue works without any engine hooks: order, dedup, claim, settle and turn receipts", () => {
  const queue = new ThreadQueueStore(database());
  const first = queue.add("t", "c1", text("one")),
    second = queue.add("t", "c2", text("two"));
  assert.equal(queue.add("t", "c1", text("one")).id, first.id, "the same client message is queued once");
  assert.throws(() => queue.add("t", "c1", text("other")), /different input/u);
  assert.equal(first.executionSubmission, null);
  queue.reorder("t", [second.id, first.id]);
  assert.equal(queue.firstAwaitingAdmission("t")!.id, second.id);

  const claimed = queue.claim("t", second.id, null)!;
  assert.equal(claimed.state, "dispatching");
  assert.equal(claimed.delivery!.nativeAdmission, "pending");
  assert.equal(queue.settle("t", second.id, "delivered", null, "turn-1"), true);
  assert.equal(queue.find("t", second.id)!.delivery!.execution, "running");
  queue.deliveries.finish("t", "turn-1", "completed");
  assert.equal(queue.find("t", second.id)!.delivery!.execution, "completed");
  assert.deepEqual(queue.inputOutcomes("t"), { delivered: 1, discarded: 0 });
  assert.equal(queue.delete("t", first.id), true);
  assert.deepEqual(queue.pendingThreads(), []);
});

test("work left mid-dispatch by a previous process becomes unknown, never silently resent", () => {
  const db = database();
  const before = new ThreadQueueStore(db);
  const item = before.add("t", "c1", text("one"));
  before.claim("t", item.id, null);
  const after = new ThreadQueueStore(db);
  const recovered = after.find("t", item.id)!;
  assert.equal(recovered.state, "unknown");
  assert.equal(recovered.pausedReason, "steer-delivery-unconfirmed");
  assert.equal(recovered.delivery!.nativeAdmission, "unknown");
  assert.equal(after.firstAwaitingAdmission("t"), null, "an unknown user input waits for reconciliation");
});

test("inputs under the owner-reconciled prefix cannot be retried by users and block reordering", () => {
  const queue = new ThreadQueueStore(database(), { ownerReconciledPrefix: "actor-input:" });
  const owned = queue.add("t", "actor-input:r1", text("owned")),
    plain = queue.add("t", "c1", text("plain"));
  for (const row of [owned, plain]) {
    queue.claim("t", row.id, "turn-1");
    queue.settle("t", row.id, "unknown");
  }
  assert.equal(queue.requestRetry("t", owned.id, "turn-1"), false);
  assert.equal(queue.requestRetry("t", plain.id, "turn-1"), true);
  assert.equal(queue.firstAwaitingAdmission("t")!.id, owned.id, "the owner re-admits its own unknown input");
  queue.add("t", "c2", text("later"));
  assert.throws(() => queue.reorder("t", []), /Reconcile in-flight delivery/u);
  assert.throws(
    () => new ThreadQueueStore(database(), { ownerReconciledPrefix: "x%" }),
    /Invalid owner-reconciled prefix/u,
  );
});

test("engine hooks capture and project per-input submission metadata", () => {
  const captured: unknown[] = [];
  const queue = new ThreadQueueStore<string>(database(), {
    capture: (threadId, clientId, submission, existing) =>
      captured.push([threadId, clientId, submission, existing?.id ?? null]),
    submission: (_threadId, clientId) => `meta:${clientId}`,
  });
  const row = queue.add("t", "c1", text("one"), "lease");
  assert.equal(row.executionSubmission, "meta:c1");
  queue.add("t", "c1", text("one"));
  assert.deepEqual(captured, [
    ["t", "c1", "lease", null],
    ["t", "c1", undefined, row.id],
  ]);
});

test("the shared schema has the same shape the legacy Codex Host state database migrated to", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { OpenCraftHostStateDatabase } =
    await import("../../apps/opencraft-daemon/src/opencraft-host-state-database.ts");
  const directory = mkdtempSync(join(tmpdir(), "thread-queue-shape-"));
  const legacy = new OpenCraftHostStateDatabase(directory),
    shared = database();
  try {
    const shape = (db: SqlDatabase) =>
      Object.fromEntries(
        ["opencraft_host_queue", "opencraft_input_delivery", "opencraft_turn_delivery"].map((table) => [
          table,
          {
            columns: db
              .prepare(`PRAGMA table_info(${table})`)
              .all()
              .map((c) => [c.name, c.type, c.notnull, c.pk]),
            indexes: db
              .prepare(`PRAGMA index_list(${table})`)
              .all()
              .filter((i) => i.origin === "c")
              .map((i) => [
                i.name,
                db
                  .prepare(`PRAGMA index_info(${String(i.name)})`)
                  .all()
                  .map((c) => c.name),
              ])
              .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
            foreignKeys: db
              .prepare(`PRAGMA foreign_key_list(${table})`)
              .all()
              .map((f) => [f.table, f.from, f.to]),
          },
        ]),
      );
    assert.deepEqual(shape(shared), shape(legacy.sql));
  } finally {
    legacy.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
