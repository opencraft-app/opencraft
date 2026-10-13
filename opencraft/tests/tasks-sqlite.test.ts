import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TASKS, type TasksSnapshot } from "@opencraft/appserver-protocol";
import { TasksSqliteStore } from "@opencraft/plugin-tasks/sqlite";
import { TasksService, TasksFault } from "@opencraft/plugin-tasks/server";
const content = {
  title: "Implement tasks",
  description: "Acceptance criteria",
  projectServerId: null,
  projectId: null,
};
test("structured rows persist many-to-many conversation identity across servers and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-tasks-")),
    path = join(root, "tasks.sqlite");
  let store = new TasksSqliteStore(path);
  try {
    await writeFile(
      join(root, "kanban.sqlite"),
      "old cards must remain untouched",
    );
    store.create({ ...content, id: "a", status: "todo" });
    store.create({ ...content, id: "b", status: "backlog" });
    store.attach({
      id: "a",
      expectedRevision: 1,
      serverId: "server-a",
      threadId: "same",
    });
    store.attach({
      id: "a",
      expectedRevision: 2,
      serverId: "server-b",
      threadId: "same",
    });
    store.attach({
      id: "b",
      expectedRevision: 1,
      serverId: "server-a",
      threadId: "same",
    });
    assert.equal(store.read("a").conversations.length, 2);
    assert.deepEqual(
      store
        .forConversation("server-a", "same")
        .tasks.map((t) => t.id)
        .sort(),
      ["a", "b"],
    );
    assert.deepEqual(
      store.forConversation("server-b", "same").tasks.map((t) => t.id),
      ["a"],
    );
    assert.equal(
      store
        .attach({
          id: "a",
          expectedRevision: 1,
          serverId: "server-a",
          threadId: "same",
        })
        .tasks.find((t) => t.id === "a")?.revision,
      3,
      "Repeated association is idempotent",
    );
    store.close();
    store = new TasksSqliteStore(path);
    assert.equal(
      store.read("a").status,
      "todo",
      "Conversation lifecycle does not change business status",
    );
    const db = new DatabaseSync(path, { readOnly: true });
    assert.deepEqual(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all()
        .map((row) => row.name),
      ["schema_migrations", "task_conversations", "tasks"],
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM task_conversations").get()?.n,
      3,
    );
    db.close();
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(
      await readFile(join(root, "kanban.sqlite"), "utf8"),
      "old cards must remain untouched",
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("two clients reject stale edits and atomically reorder only valid targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-tasks-cas-")),
    path = join(root, "tasks.sqlite");
  const a = new TasksSqliteStore(path),
    b = new TasksSqliteStore(path);
  try {
    for (const id of ["a", "b", "c"])
      a.create({ ...content, id, status: "todo" });
    a.move({ id: "c", expectedRevision: 1, status: "todo", beforeId: "a" });
    assert.deepEqual(
      b.list().tasks.map((t) => t.id),
      ["c", "a", "b"],
    );
    assert.throws(
      () =>
        b.update({ ...content, id: "a", title: "stale", expectedRevision: 1 }),
      (e) => e instanceof TasksFault && e.code === -32051,
    );
    const previous = a.list();
    assert.throws(
      () =>
        a.move({ id: "c", expectedRevision: 2, status: "done", beforeId: "a" }),
      (e) => e instanceof TasksFault && e.code === -32051,
    );
    assert.deepEqual(
      a.list(),
      previous,
      "Invalid target rolls back the transaction",
    );
    const task = a.read("a");
    a.move({
      id: "a",
      expectedRevision: task.revision,
      status: "done",
      beforeId: null,
    });
    assert.equal(b.read("a").status, "done");
    a.remove({ id: "a", expectedRevision: a.read("a").revision });
    assert.equal(
      b.list().tasks.some((t) => t.id === "a"),
      false,
    );
    assert.throws(
      () => a.create({ ...content, id: "a", status: "todo" }),
      (e) => e instanceof TasksFault && e.code === -32051,
      "Deleted IDs cannot revive records",
    );
  } finally {
    a.close();
    b.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("protocol validation rejects paths, incomplete identities and statuses without committing or notifying", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-tasks-rpc-"));
  let changes = 0;
  const service = new TasksService(join(root, "tasks.sqlite"), () => changes++);
  try {
    const call = (method: string, params: unknown) =>
      service.handle(method, params) as TasksSnapshot;
    for (const params of [
      { ...content, id: "a", status: "wrong" },
      { ...content, id: "a", status: "todo", projectId: "project" },
      { ...content, id: "a", status: "todo", path: "/tmp/private" },
    ])
      assert.throws(
        () => call(TASKS.create, params),
        (e) => e instanceof TasksFault && e.code === -32602,
      );
    assert.equal(call(TASKS.list, {}).tasks.length, 0);
    assert.equal(changes, 0);
    call(TASKS.create, { ...content, id: "a", status: "todo" });
    assert.equal(changes, 1);
    assert.equal(
      call(TASKS.create, { ...content, id: "a", status: "todo" }).tasks.length,
      1,
    );
    assert.throws(
      () =>
        call(TASKS.attach, {
          id: "a",
          expectedRevision: 1,
          serverId: "s",
          threadId: "",
        }),
      (e) => e instanceof TasksFault && e.code === -32602,
    );
    call(TASKS.attach, {
      id: "a",
      expectedRevision: 1,
      serverId: "s",
      threadId: "t",
    });
    call(TASKS.detach, {
      id: "a",
      expectedRevision: 2,
      serverId: "s",
      threadId: "t",
    });
    assert.equal(
      call(TASKS.forConversation, { serverId: "s", threadId: "t" }).tasks
        .length,
      0,
    );
    assert.throws(
      () => new TasksService(null).handle(TASKS.list, {}),
      (e) => e instanceof TasksFault && e.code === -32601,
    );
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("unknown or tampered migration history is rejected without overwriting rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-tasks-schema-")),
    path = join(root, "tasks.sqlite");
  const store = new TasksSqliteStore(path);
  store.create({ ...content, id: "keep", status: "todo" });
  store.close();
  const db = new DatabaseSync(path);
  db.exec("UPDATE schema_migrations SET checksum='tampered'");
  db.close();
  try {
    assert.throws(
      () => new TasksSqliteStore(path),
      /Unsupported Tasks database/,
    );
    const inspect = new DatabaseSync(path, { readOnly: true });
    assert.equal(inspect.prepare("SELECT id FROM tasks").get()?.id, "keep");
    inspect.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
