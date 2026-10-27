import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openManagedDatabase, SqliteLifecycleError } from "@opencraft/sqlite-node";
import { TasksSqliteStore, tasksMigrations } from "../../plugins/tasks/src/sqlite";

test("v3 upgrade preserves every prior column and ledger; legacy edits preserve V1 planning and progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "tasks-upgrade-")), path = join(root, "tasks.sqlite");
  const content = { title: "Existing", description: "Original body", projectId: null, projectServerId: null };
  try {
    const old = openManagedDatabase({ path, migrations: tasksMigrations });
    old.database.exec("INSERT INTO tasks(id,title,description,status,sort_order,revision,created_at,updated_at) VALUES('existing','Existing','Original body','todo',7,1,10,20)");
    const before = old.database.prepare("SELECT * FROM tasks").all().map(row => ({ ...row }));
    const ledger = old.database.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all().map(row => ({ ...row }));
    old.database.close();
    const store = new TasksSqliteStore(path);
    assert.equal(store.outcome.appliedVersion, 5);
    const db = new DatabaseSync(path);
    assert.deepEqual(db.prepare("SELECT * FROM tasks").all().map(({ kind, acceptance_criteria, archived_at, ...row }) => row), before);
    assert.deepEqual(db.prepare("SELECT version,name,checksum FROM schema_migrations WHERE version<4 ORDER BY version").all().map(row => ({ ...row })), ledger);
    assert.equal(db.prepare("SELECT count(*) AS n FROM task_events").get()?.n, 0, "Existing tasks do not gain fabricated history");
    store.update({ ...content, id: "existing", expectedRevision: 1, kind: "harness", acceptanceCriteria: "Agent checks pass" });
    store.progress({ taskId: "existing", eventId: "progress-1", text: "Harness ready" });
    store.update({ ...content, title: "Edited by legacy client", id: "existing", expectedRevision: 2 });
    store.remove({ id: "existing", expectedRevision: 3 });
    store.restore({ id: "existing", expectedRevision: 4 });
    const restored = store.read("existing");
    assert.equal(restored.kind, "harness"); assert.equal(restored.acceptanceCriteria, "Agent checks pass");
    assert.equal(restored.latestProgress?.text, "Harness ready"); assert.equal(restored.revision, 5);
    db.close(); store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("V1 still rejects tampered or unrecognized future schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "tasks-upgrade-invalid-")), path = join(root, "tasks.sqlite");
  try {
    const store = new TasksSqliteStore(path); store.close();
    const db = new DatabaseSync(path);
    db.exec("ALTER TABLE tasks ADD COLUMN unexpected TEXT"); db.close();
    assert.throws(() => new TasksSqliteStore(path), (e: unknown) => e instanceof SqliteLifecycleError && e.kind === "history-mismatch");
  } finally { await rm(root, { recursive: true, force: true }); }
});
