import { SqliteLifecycleError } from "@opencraft/sqlite-node";
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
      ["schema_migrations", "sqlite_sequence", "task_conversations", "task_events", "task_members", "tasks"],
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
      (error) => error instanceof SqliteLifecycleError && error.kind === "history-mismatch",
    );
    const inspect = new DatabaseSync(path, { readOnly: true });
    assert.equal(inspect.prepare("SELECT id FROM tasks").get()?.id, "keep");
    inspect.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recycle restores full identity and associations across restart, rejects stale clients and expires at seven days", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-tasks-recycle-"));
  const path = join(root, "tasks.sqlite");
  const week = 7 * 24 * 60 * 60 * 1000;
  let now = 1_800_000_000_000;
  let store = new TasksSqliteStore(path, () => now);
  try {
    store.create({ ...content, id: "a", status: "in_progress", projectServerId: "s", projectId: "p" });
    store.attach({ id: "a", expectedRevision: 1, serverId: "s", threadId: "thread" });
    const original = store.read("a");
    store.remove({ id: "a", expectedRevision: original.revision });
    assert.equal(store.list().tasks.length, 0);
    assert.equal(store.forConversation("s", "thread").tasks.length, 0);
    assert.throws(() => store.read("a"), (e) => e instanceof TasksFault && e.code === -32052);
    const deleted = store.list().recycled![0];
    assert.equal(deleted.deletedAt, now);
    assert.deepEqual(deleted.conversations, original.conversations);
    store.close(); store = new TasksSqliteStore(path, () => now);
    store.create({ ...content, id: "b", status: "in_progress" });
    assert.throws(() => store.restore({ id: "a", expectedRevision: original.revision }), (e) => e instanceof TasksFault && e.code === -32051);
    now += week - 1;
    const restored = store.restore({ id: "a", expectedRevision: deleted.revision });
    assert.equal(restored.recycled!.length, 0);
    const task = store.read("a");
    assert.equal(task.id, original.id); assert.equal(task.title, original.title); assert.equal(task.description, original.description);
    assert.equal(task.projectId, "p"); assert.equal(task.status, "in_progress"); assert.equal(task.createdAt, original.createdAt);
    assert.deepEqual(task.conversations, original.conversations); assert.equal(task.deletedAt, null);
    assert.equal(task.revision, deleted.revision + 1);
    assert.ok(task.sortOrder > store.read("b").sortOrder);
    assert.equal(store.forConversation("s", "thread").tasks[0].id, "a");
    assert.throws(() => store.restore({ id: "a", expectedRevision: deleted.revision }), (e) => e instanceof TasksFault);
    store.remove({ id: "a", expectedRevision: task.revision });
    const again = store.list().recycled![0];
    now += week;
    assert.equal(store.list().recycled!.length, 0);
    assert.throws(() => store.restore({ id: "a", expectedRevision: again.revision }), (e) => e instanceof TasksFault && e.code === -32052);
    assert.throws(() => store.create({ ...content, id: "a", status: "todo" }), (e) => e instanceof TasksFault && e.code === -32051);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("restore observes workspace capacity without losing recoverable rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-tasks-recycle-capacity-"));
  const store = new TasksSqliteStore(join(root, "tasks.sqlite"));
  try {
    store.create({ ...content, id: "deleted", status: "todo" });
    store.remove({ id: "deleted", expectedRevision: 1 });
    // Seed the authority directly to avoid quadratic snapshot work in setup.
    const db = new DatabaseSync(join(root, "tasks.sqlite"));
    const insert = db.prepare("INSERT INTO tasks(id,title,description,status,project_server_id,project_id,sort_order,revision,created_at,updated_at,deleted_at) VALUES(?, 'Task', '', 'todo', NULL, NULL, ?, 1, 1, 1, NULL)");
    db.exec("BEGIN"); for (let i=0;i<1000;i++) insert.run(`active-${i}`,i); db.exec("COMMIT"); db.close();
    const deleted = store.list().recycled![0];
    assert.throws(() => store.restore({ id: "deleted", expectedRevision: deleted.revision }), (e) => e instanceof TasksFault && e.code === -32054);
    assert.equal(store.list().recycled![0].revision, deleted.revision);
    store.remove({ id: "active-0", expectedRevision: 1 });
    store.restore({ id: "deleted", expectedRevision: deleted.revision });
    assert.equal(store.list().tasks.length, 1000);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("restore RPC validates revision and publishes the same domain change", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-tasks-restore-rpc-"));
  let changed=0; const service = new TasksService(join(root,"tasks.sqlite"),()=>changed++);
  try {
    assert.equal((service.handle(TASKS.capabilities,{}) as any).recycleBinRetentionMs,7*86400000);
    service.handle(TASKS.create,{...content,id:"a",status:"todo"});
    service.handle(TASKS.remove,{id:"a",expectedRevision:1});
    assert.throws(()=>service.handle(TASKS.restore,{id:"a",expectedRevision:0}),e=>e instanceof TasksFault&&e.code===-32602);
    assert.equal(changed,2);
    const snapshot=service.handle(TASKS.restore,{id:"a",expectedRevision:2}) as TasksSnapshot;
    assert.equal(snapshot.tasks[0].id,"a");assert.equal(snapshot.recycled!.length,0);assert.equal(changed,3);
  } finally {service.close();await rm(root,{recursive:true,force:true});}
});

test("recycle preserves v3 task properties and member identities", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tasks-recycle-v3-"));
  const store = new TasksSqliteStore(join(dir, "tasks.sqlite"));
  try {
    store.member({id:"owner",name:"Owner",expectedRevision:null,identity:{kind:"employee",id:"employee-1"}});
    store.create({id:"recover-properties",title:"Keep fields",description:"Full description",status:"todo",projectServerId:null,projectId:null,assigneeId:"owner",priority:"urgent",dueDate:"2026-12-31"});
    const removed=store.remove({id:"recover-properties",expectedRevision:1}).recycled!.find(task=>task.id==="recover-properties")!;
    const restored=store.restore({id:removed.id,expectedRevision:removed.revision});
    const task=restored.tasks.find(task=>task.id===removed.id)!;
    assert.equal(task.assigneeId,"owner");assert.equal(task.priority,"urgent");assert.equal(task.dueDate,"2026-12-31");assert.equal(task.description,"Full description");
    assert.deepEqual(restored.members?.find(member=>member.id==="owner")?.identity,{kind:"employee",id:"employee-1"});
  } finally {store.close();await rm(dir,{recursive:true,force:true});}
});
