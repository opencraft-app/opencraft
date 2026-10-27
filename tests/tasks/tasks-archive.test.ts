import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openManagedDatabase } from "@opencraft/sqlite-node";
import { TASKS, type TasksRequestPort, type TaskArchivePage } from "@opencraft/appserver-protocol";
import { TasksSqliteStore, tasksMigrations } from "../../plugins/tasks/src/sqlite";
import { tasksV1Migration } from "../../plugins/tasks/src/v1-schema";
import { TasksService } from "../../plugins/tasks/src/server";
import { TasksArchiveController } from "../../plugins/tasks/src/archive-controller";
import { TasksController } from "../../plugins/tasks/src/controller";
const content = { title: "Archive fixture", description: "Original body", projectId: null, projectServerId: null };
async function fixture(fn: (store: TasksSqliteStore, path: string, advance: (days: number) => void) => Promise<void> | void) {
  const root = await mkdtemp(join(tmpdir(), "tasks-archive-")), path = join(root, "tasks.sqlite");
  let now = 1000000000;
  const store = new TasksSqliteStore(path, () => now);
  try { await fn(store, path, days => { now += days * 86400000; }); }
  finally { store.close(); await rm(root, { recursive: true, force: true }); }
}
test("archive retains content, original status, member, associations and history across restart and expiry; restore appends to original column", async () => {
  await fixture((store, path, advance) => {
    store.create({ ...content, id: "retained", status: "done", kind: "harness", acceptanceCriteria: "A durable record" });
    store.attach({ id: "retained", expectedRevision: 1, serverId: "s", threadId: "t" });
    store.progress({ taskId: "retained", eventId: "proof", text: "Verified" });
    const before = store.read("retained");
    store.archive({ id: "retained", expectedRevision: before.revision }, true);
    assert.equal(store.list().tasks.length, 0);
    assert.equal(store.list().recycled?.length, 0);
    assert.equal(store.forConversation("s", "t").tasks.length, 0);
    assert.throws(() => store.update({ ...content, id: "retained", expectedRevision: before.revision + 1 }), (e: any) => e.code === -32052);
    assert.throws(() => store.move({ id: "retained", expectedRevision: before.revision + 1, status: "todo", beforeId: null }));
    assert.throws(() => store.remove({ id: "retained", expectedRevision: before.revision + 1 }));
    assert.throws(() => store.progress({ taskId: "retained", eventId: "invalid", text: "Must remain read-only" }));
    assert.throws(() => store.detach({ id: "retained", expectedRevision: before.revision + 1, serverId: "s", threadId: "t" }));
    assert.throws(() => store.create({ ...content, id: "retained", status: "todo" }));
    advance(3650);
    const other = new TasksSqliteStore(path);
    try {
      const archived = other.archives({}).tasks[0]!;
      assert.deepEqual({ ...archived, revision: before.revision, updatedAt: before.updatedAt, archivedAt: null }, before);
      const events = other.events({ taskId: "retained" });
      assert.equal(events.events[0]?.payload.archived, true);
      assert.equal(other.read("retained").conversations[0]?.threadId, "t");
      assert.throws(() => other.archive({ id: "retained", expectedRevision: before.revision }, false), (e: any) => e.code === -32051);
    } finally { other.close(); }
    store.create({ ...content, id: "tail", status: "done" });
    const archived = store.read("retained");
    store.archive({ id: "retained", expectedRevision: archived.revision }, false);
    const restored = store.read("retained");
    assert.equal(restored.archivedAt, null); assert.equal(restored.status, "done");
    assert.ok(restored.sortOrder > store.read("tail").sortOrder);
    assert.equal(restored.latestProgress?.text, "Verified"); assert.equal(restored.conversations.length, 1);
    assert.equal(store.archives({}).tasks.length, 0);
  });
});
test("archive search is literal, case-insensitive for ASCII, includes Chinese and criteria; tied timestamps paginate without duplicates", async () => {
  await fixture(store => {
    for (const id of ["a", "b", "c", "d", "e"]) {
      store.create({ ...content, id, title: id === "a" ? "增长 Alpha 100%_" : content.title, status: "done", acceptanceCriteria: id === "b" ? "Special acceptance" : "" });
      store.archive({ id, expectedRevision: 1 }, true);
    }
    const ids: string[] = []; let before;
    do { const page = store.archives({ limit: 2, before }); ids.push(...page.tasks.map(task => task.id)); before = page.nextCursor ?? undefined; } while (before);
    assert.deepEqual(ids, ["e", "d", "c", "b", "a"]);
    for (const search of ["增长", "alpha", "%_"]) assert.deepEqual(store.archives({ search }).tasks.map(t => t.id), ["a"]);
    assert.deepEqual(store.archives({ search: "SPECIAL" }).tasks.map(t => t.id), ["b"]);
    assert.equal(store.archives({ search: "unmatched" }).tasks.length, 0);
  });
});
test("v4 migration adds nullable archive column without rewriting existing rows, associations, events or migration checksums", async () => {
  const root = await mkdtemp(join(tmpdir(), "tasks-v5-")), path = join(root, "tasks.sqlite");
  try {
    const old = openManagedDatabase({ path, migrations: [...tasksMigrations, tasksV1Migration] }).database;
    old.exec("INSERT INTO tasks(id,title,description,status,sort_order,revision,created_at,updated_at) VALUES('old','Old','Body','done',9,3,10,20)");
    const rows = old.prepare("SELECT * FROM tasks").all().map(row => ({ ...row }));
    const ledger = old.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all().map(row => ({ ...row })); old.close();
    const store = new TasksSqliteStore(path); const db = new DatabaseSync(path);
    assert.equal(store.outcome.appliedVersion, 5);
    assert.deepEqual(db.prepare("SELECT * FROM tasks").all().map(({ archived_at, ...row }) => row), rows);
    assert.deepEqual(db.prepare("SELECT version,name,checksum FROM schema_migrations WHERE version<5 ORDER BY version").all().map(row => ({ ...row })), ledger);
    assert.equal(store.read("old").archivedAt, null); assert.equal(store.list().tasks[0]?.status, "done");
    db.close(); store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("archive RPC validates bounds and cursor, rejects caller identity; old authorities cannot issue archive writes", async () => {
  await fixture(async (store, path) => {
    const service = new TasksService(path, () => {}, store);
    for (const params of [{ limit: 0 }, { limit: 101 }, { search: "x".repeat(201) }, { before: { archivedAt: -1, id: "a" } }, { before: { archivedAt: 1, id: "a", unknown: true } }, { actor: "forged" }]) {
      assert.throws(() => service.handle(TASKS.archives, params), (e: any) => e.code === -32602);
    }
    const writes: string[] = [];
    const model = new TasksController({ request: (async (method: string) => {
      if (method === TASKS.capabilities) return { version: 1, storage: "sqlite-rows" };
      if (method !== TASKS.list) writes.push(method);
      return { tasks: [] };
    }) as TasksRequestPort["request"] });
    await model.start(); assert.equal(model.getSnapshot().archive, false);
    assert.equal(await model.mutate(TASKS.archive, { id: "a", expectedRevision: 1 }), false);
    assert.deepEqual(writes, []); model.dispose();
  });
});
test("late archive searches, failed next pages and disposed projections cannot replace the latest query", async () => {
  const requests: { params: any; resolve(page: TaskArchivePage): void; reject(error: Error): void }[] = [];
  const model = new TasksArchiveController({ request: ((_method: string, params: any) => new Promise((resolve, reject) => requests.push({ params, resolve, reject }))) as TasksRequestPort["request"] });
  const old = model.search("old"), current = model.search("new");
  requests[1]!.resolve({ tasks: [], nextCursor: { archivedAt: 10, id: "n" } }); await current;
  requests[0]!.resolve({ tasks: [], nextCursor: { archivedAt: 1, id: "old" } }); await old;
  assert.equal(model.getSnapshot().query, "new"); assert.equal(model.getSnapshot().nextCursor?.id, "n");
  const older = model.refresh(true); requests[2]!.reject(new Error("offline")); await older;
  assert.equal(model.getSnapshot().error, true); assert.equal(model.getSnapshot().nextCursor?.id, "n");
  const late = model.search("last"); model.dispose(); const disposed = model.getSnapshot();
  requests[3]!.resolve({ tasks: [], nextCursor: null }); await late; assert.equal(model.getSnapshot(), disposed);
});
test("archival frees active capacity and stale restore cannot exceed 1000 active tasks", async () => {
  await fixture((store, path) => {
    store.create({ ...content, id: "space", status: "done" });
    store.archive({ id: "space", expectedRevision: 1 }, true);
    const db = new DatabaseSync(path);
    db.exec("WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<1000) INSERT INTO tasks(id,title,description,status,sort_order,revision,created_at,updated_at) SELECT 'capacity-'||v,'Capacity','','todo',v,1,1,1 FROM n"); db.close();
    assert.throws(() => store.archive({ id: "space", expectedRevision: 2 }, false), (e: any) => e.code === -32054);
    assert.equal(store.read("space").revision, 2);
    store.archive({ id: "capacity-1", expectedRevision: 1 }, true);
    store.archive({ id: "space", expectedRevision: 2 }, false);
    assert.equal(store.list().tasks.length, 1000);
    assert.equal(store.archives({}).tasks[0]?.id, "capacity-1");
  });
});
test("lost archive and restore acknowledgements read current state without replaying writes", async () => {
  await fixture(async (store, path) => {
    store.create({ ...content, id: "ack", status: "done" });
    const service = new TasksService(path, () => {}, store), writes: string[] = [];
    const model = new TasksController({ request: (async (method: string, params: unknown) => {
      const result = service.handle(method, params);
      if (method === TASKS.archive || method === TASKS.unarchive) { writes.push(method); throw new Error("acknowledgement lost"); }
      return result;
    }) as TasksRequestPort["request"] });
    await model.start();
    assert.equal(await model.mutate(TASKS.archive, { id: "ack", expectedRevision: 1 }), false);
    assert.equal(model.getSnapshot().tasks.length, 0); assert.ok(store.read("ack").archivedAt);
    assert.equal(await model.mutate(TASKS.unarchive, { id: "ack", expectedRevision: 2 }), false);
    assert.equal(model.getSnapshot().tasks[0]?.id, "ack"); assert.equal(store.read("ack").revision, 3);
    assert.deepEqual(writes, [TASKS.archive, TASKS.unarchive]); model.dispose();
  });
});
