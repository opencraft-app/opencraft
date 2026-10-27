import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openManagedDatabase, SqliteLifecycleError } from "@opencraft/sqlite-node";
import { TasksSqliteStore, tasksMigrations } from "../../plugins/tasks/src/sqlite";
import { tasksV1Migration } from "../../plugins/tasks/src/v1-schema";
import { tasksArchiveMigration } from "../../plugins/tasks/src/archive-schema";
const content = { title: "Retain", description: "Body", projectId: null, projectServerId: null };
test("archive writer applies declared v5 and strictly preserves existing v5 data while excluding archived tasks", async () => {
 const root = await mkdtemp(join(tmpdir(), "tasks-archive-reader-")), path = join(root, "tasks.sqlite");
 try {
  let store = new TasksSqliteStore(path); store.create({ ...content, id: "archived", status: "done" }); store.create({ ...content, id: "active", status: "done" });
  store.attach({id:"archived",expectedRevision:1,serverId:"s",threadId:"t"}); store.close();
  let db = new DatabaseSync(path); assert.equal(db.prepare("SELECT max(version) AS v FROM schema_migrations").get()?.v, 5); db.close();
  db = openManagedDatabase({ path, migrations: [...tasksMigrations,tasksV1Migration,tasksArchiveMigration] }).database;
  db.exec("UPDATE tasks SET archived_at=123 WHERE id='archived'");
  const before = db.prepare("SELECT * FROM tasks ORDER BY id").all(), ledger = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), links = db.prepare("SELECT * FROM task_conversations").all(); db.close();
  store = new TasksSqliteStore(path); assert.equal(store.outcome.appliedVersion,5);
  assert.deepEqual(store.list().tasks.map(t=>t.id), ["active"]);
  assert.equal(store.forConversation("s","t").tasks.length,0);
  assert.throws(()=>store.update({...content,id:"archived",expectedRevision:2}));
  assert.throws(()=>store.remove({id:"archived",expectedRevision:2}));
  assert.throws(()=>store.create({...content,id:"archived",status:"done"}));
  store.close(); db = new DatabaseSync(path);
  assert.deepEqual(db.prepare("SELECT * FROM tasks ORDER BY id").all(), before);
  assert.deepEqual(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(),ledger);
  assert.deepEqual(db.prepare("SELECT * FROM task_conversations").all(),links);
  db.exec("ALTER TABLE tasks ADD COLUMN unexpected TEXT"); db.close();
  assert.throws(()=>new TasksSqliteStore(path),(e:unknown)=>e instanceof SqliteLifecycleError && e.kind==='history-mismatch');
 } finally { await rm(root,{recursive:true,force:true}); }
});
