import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OrdinaryWorkspaceStore } from "../../apps/local-agent-host/src/ordinary-workspace-store";
const authority = { principalId: "alice", hostId: "host" };
function directory(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "workspace-worker-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test("SQL and schema opening never run in the caller's event loop", async (t) => {
  const root = directory(t);
  t.mock.method(DatabaseSync.prototype, "prepare", () => {
    throw Error("SQL on caller thread");
  });
  t.mock.method(DatabaseSync.prototype, "exec", () => {
    throw Error("SQL on caller thread");
  });
  const store = new OrdinaryWorkspaceStore(root, "deployment");
  try {
    assert.equal((await store.outcome).status, "fresh");
    const row = await store.admit(authority, "intent", "a".repeat(64));
    assert.equal((await store.read(authority, row.workspaceId)).workspaceId, row.workspaceId);
  } finally {
    await store.close();
  }
});
test("lock waits keep caller timers live and close drains accepted commits", async (t) => {
  const root = directory(t),
    store = new OrdinaryWorkspaceStore(root, "deployment");
  await store.outcome;
  const database = new DatabaseSync(join(root, "ordinary-workspaces.sqlite"));
  database.exec("BEGIN IMMEDIATE");
  const pending = store.admit(authority, "intent", "b".repeat(64));
  const closing = store.close();
  await assert.rejects(store.admit(authority, "late", "b".repeat(64)), /closing/);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(ticks >= 2, "main thread must remain responsive while worker waits for SQLite");
    database.exec("COMMIT");
    const row = await pending;
    await closing;
    const reopened = new OrdinaryWorkspaceStore(root, "deployment");
    try {
      assert.equal((await reopened.read(authority, row.workspaceId)).intentId, "intent");
    } finally {
      await reopened.close();
    }
  } finally {
    clearInterval(timer);
    if (database.isTransaction) database.exec("ROLLBACK");
    database.close();
    await closing;
  }
});
test("changed migration checksum is rejected without creating replacement data", async (t) => {
  const root = directory(t),
    store = new OrdinaryWorkspaceStore(root, "deployment");
  const row = await store.admit(authority, "intent", "c".repeat(64));
  await store.close();
  const database = new DatabaseSync(join(root, "ordinary-workspaces.sqlite"));
  database.exec("UPDATE schema_migrations SET checksum='changed' WHERE version=1");
  database.close();
  const reopened = new OrdinaryWorkspaceStore(root, "deployment");
  await assert.rejects(reopened.outcome);
  await assert.rejects(reopened.read(authority, row.workspaceId));
  await assert.rejects(reopened.close());
  const verify = new DatabaseSync(join(root, "ordinary-workspaces.sqlite"));
  try {
    assert.equal(verify.prepare("SELECT count(*) AS n FROM ordinary_workspaces").get()!.n, 1);
  } finally {
    verify.close();
  }
});
