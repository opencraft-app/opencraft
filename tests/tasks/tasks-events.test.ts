import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TASKS, TASK_KINDS, type TaskDetail, type TaskEvent, type TaskEventsPage } from "@opencraft/appserver-protocol";
import { TasksService } from "../../plugins/tasks/src/server";
import { TasksSqliteStore } from "../../plugins/tasks/src/sqlite";
const content = { title: "Ship", description: "Body", projectId: null, projectServerId: null };
test("progress has stable global IDs, trusted provenance, content-independent revision and exact reconciliation beyond page one", async () => {
  const root = await mkdtemp(join(tmpdir(), "tasks-events-"));
  const service = new TasksService(join(root, "tasks.sqlite"));
  try {
    service.handle(TASKS.create, { ...content, id: "a", status: "todo", kind: "growth", acceptanceCriteria: "Measure activation" });
    const task = service.handle(TASKS.read, { id: "a" }) as TaskDetail;
    const context = { actor: null, channel: "agent" } as const;
    const event = service.handle(TASKS.progress, { taskId: "a", eventId: "original", text: "Experiment started" }, context) as TaskEvent;
    for (let i = 0; i < 35; i++) service.handle(TASKS.progress, { taskId: "a", eventId: `later-${i}`, text: `${i}` });
    assert.deepEqual(service.handle(TASKS.progress, { taskId: "a", eventId: "original", text: "Experiment started" }), event);
    assert.equal(event.actor, null); assert.equal(event.channel, "agent"); assert.equal(event.taskRevision, task.revision);
    assert.throws(() => service.handle(TASKS.progress, { taskId: "a", eventId: "original", text: "Different" }), { code: -32051 });
    const current = service.handle(TASKS.read, { id: "a" }) as TaskDetail;
    assert.equal(current.revision, task.revision); assert.equal(current.updatedAt, task.updatedAt);
    assert.equal(current.latestProgress?.text, "34");
    const head = service.handle(TASKS.events, { taskId: "a" }) as TaskEventsPage;
    assert.equal(head.events.length, 20); assert.ok(head.nextBeforeSeq);
    assert.equal(head.events.some(e => e.eventId === "original"), false);
    assert.deepEqual(service.handle(TASKS.event, { taskId: "a", eventId: "original" }), event);
    const older = service.handle(TASKS.events, { taskId: "a", beforeSeq: head.nextBeforeSeq!, limit: 100 }) as TaskEventsPage;
    assert.equal(new Set([...head.events, ...older.events].map(e => e.seq)).size, 37);
    assert.equal(older.nextBeforeSeq, null);
    assert.throws(() => service.handle(TASKS.events, { taskId: "a", limit: 101 }), { code: -32602 });
    assert.throws(() => service.handle(TASKS.progress, { taskId: "a", eventId: "fake", text: "x", actor: { id: "owner" } }), { code: -32602 });
    assert.throws(() => service.handle(TASKS.progress, { taskId: "a", eventId: "long", text: "x".repeat(4097) }), { code: -32602 });
    service.handle(TASKS.remove, { id: "a", expectedRevision: task.revision });
    assert.throws(() => service.handle(TASKS.progress, { taskId: "a", eventId: "deleted", text: "x" }), { code: -32052 });
  } finally { service.close(); await rm(root, { recursive: true, force: true }); }
});

test("domain writes and events roll back together; ordering and duplicate links do not invent business changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "tasks-events-atomic-")), path = join(root, "tasks.sqlite");
  const store = new TasksSqliteStore(path);
  try {
    store.create({ ...content, id: "a", status: "todo" }); store.create({ ...content, id: "b", status: "todo" });
    store.move({ id: "b", expectedRevision: 1, status: "todo", beforeId: "a" });
    assert.equal(store.events({ taskId: "b" }).events.length, 1);
    store.move({ id: "a", expectedRevision: store.read("a").revision, status: "in_progress", beforeId: null });
    store.attach({ id: "a", expectedRevision: store.read("a").revision, serverId: "s", threadId: "t" });
    store.attach({ id: "a", expectedRevision: 1, serverId: "s", threadId: "t" });
    assert.deepEqual(store.events({ taskId: "a" }).events.map(e => e.type), ["linked", "status_changed", "created"]);
    const before = store.read("a"), events = store.events({ taskId: "a" });
    const db = new DatabaseSync(path); db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON task_events BEGIN SELECT RAISE(ABORT,'event failure'); END");
    assert.throws(() => store.update({ ...content, title: "Must roll back", id: "a", expectedRevision: before.revision }));
    db.exec("DROP TRIGGER fail_event"); db.close();
    assert.deepEqual(store.read("a"), before); assert.deepEqual(store.events({ taskId: "a" }), events);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("fixed kinds and omission preserve unknown read kinds without inventing type configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "tasks-kinds-")), path = join(root, "tasks.sqlite");
  const service = new TasksService(path);
  try {
    for (const [i, kind] of TASK_KINDS.entries()) service.handle(TASKS.create, { ...content, id: String(i), status: "backlog", kind });
    assert.throws(() => service.handle(TASKS.create, { ...content, id: "invalid", status: "backlog", kind: "custom" }), { code: -32602 });
    const db = new DatabaseSync(path); db.prepare("UPDATE tasks SET kind='future-kind' WHERE id='0'").run(); db.close();
    service.handle(TASKS.update, { ...content, id: "0", expectedRevision: 1 });
    assert.equal((service.handle(TASKS.read, { id: "0" }) as TaskDetail).kind, "future-kind");
  } finally { service.close(); await rm(root, { recursive: true, force: true }); }
});
