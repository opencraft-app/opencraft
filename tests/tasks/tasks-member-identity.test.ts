import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openManagedDatabase } from "@opencraft/sqlite-node";
import { TASKS, type TasksSnapshot } from "@opencraft/appserver-protocol";
import { TasksService } from "../../plugins/tasks/src/server";
import { tasksMigrations } from "../../plugins/tasks/src/sqlite";

test("v2 member profile migration preserves tasks, links, responsibility and old member revisions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oc-member-v2-")), path = join(dir, "tasks.sqlite");
  const old = openManagedDatabase({ path, legacyPolicy: "reject", migrations: tasksMigrations.slice(0, 2) });
  old.database.exec("INSERT INTO task_members VALUES('person','Alex Chen',7); INSERT INTO tasks(id,title,description,status,sort_order,revision,created_at,updated_at,assignee_id) VALUES('task','Keep','Details','todo',3,9,10,20,'person'); INSERT INTO task_conversations VALUES('task','server','thread',10)");
  const before = old.database.prepare("SELECT * FROM tasks").all(), links = old.database.prepare("SELECT * FROM task_conversations").all(); old.database.close();
  const service = new TasksService(path);
  try {
    const state = service.handle(TASKS.list, {}) as TasksSnapshot;
    assert.deepEqual(state.members, [{ id: "person", name: "Alex Chen", revision: 7, identity: null }]);
    const db = new DatabaseSync(path);
    assert.deepEqual(db.prepare("SELECT * FROM tasks").all().map(({kind,acceptance_criteria,archived_at,...row}) => row), before.map(row => ({...row})));
    assert.deepEqual(db.prepare("SELECT * FROM task_conversations").all(), links);
    assert.throws(() => db.exec("UPDATE task_members SET identity_kind='employee'"), /constraint/i);
    db.close();
    assert.equal(state.tasks[0]?.assigneeId, "person");
  } finally { service.close(); await rm(dir, { recursive: true, force: true }); }
});

test("profile identity persists independently, legacy updates retain it and explicit null clears it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oc-member-profile-")), path = join(dir, "tasks.sqlite");
  let service = new TasksService(path);
  const member = () => (service.handle(TASKS.list, {}) as TasksSnapshot).members![0]!;
  try {
    service.handle(TASKS.members, { id: "local-member", name: "Alex Chen", expectedRevision: null, identity: { kind: "employee", id: "employee.alex" } });
    service.handle(TASKS.create, { id: "task", title: "Keep responsibility", description: "", status: "todo", projectId: null, projectServerId: null, assigneeId: "local-member" });
    const task = service.handle(TASKS.read, { id: "task" }); service.close(); service = new TasksService(path);
    assert.deepEqual(member().identity, { kind: "employee", id: "employee.alex" });
    service.handle(TASKS.members, { id: "local-member", name: "Renamed", expectedRevision: 1 });
    assert.deepEqual(member().identity, { kind: "employee", id: "employee.alex" });
    assert.throws(() => service.handle(TASKS.members, { id: "local-member", name: "Stale", expectedRevision: 1, identity: null }), { code: -32051 });
    assert.equal(member().revision, 2);
    service.handle(TASKS.members, { id: "local-member", name: "Renamed", expectedRevision: 2, identity: null });
    assert.equal(member().identity, null); assert.deepEqual(service.handle(TASKS.read, { id: "task" }), task);
  } finally { service.close(); await rm(dir, { recursive: true, force: true }); }
});

test("invalid identity structures fail before mutating a member", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oc-member-invalid-")), service = new TasksService(join(dir, "tasks.sqlite"));
  try {
    service.handle(TASKS.members, { id: "local", name: "Name", expectedRevision: null });
    const before = service.handle(TASKS.list, {});
    for (const identity of [[], "employee", {}, { kind: "employee" }, { kind: "employee", id: " " }, { kind: "employee", id: "x", token: "synthetic" }, { kind: "https://host", id: "x" }, { kind: "employee", id: "x".repeat(257) }]) {
      assert.throws(() => service.handle(TASKS.members, { id: "local", name: "Changed", expectedRevision: 1, identity }), { code: -32602 });
      assert.deepEqual(service.handle(TASKS.list, {}), before);
    }
  } finally { service.close(); await rm(dir, { recursive: true, force: true }); }
});
