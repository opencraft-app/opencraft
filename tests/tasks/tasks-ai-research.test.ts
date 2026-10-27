import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TASKS, type TaskDetail } from "@opencraft/appserver-protocol";
import { TasksService } from "../../plugins/tasks/src/server";

test("research triage retains schema, legacy edits, history and CAS without starting execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "tasks-research-")), path = join(root, "tasks.sqlite");
  let service = new TasksService(path);
  const content = { title: "Research scope", description: "Existing requirements", projectId: null, projectServerId: null };
  const read = () => service.handle(TASKS.read, { id: "research" }) as TaskDetail;
  try {
    service.handle(TASKS.create, { ...content, id: "research", status: "backlog" });
    const before = read();
    assert.equal(before.aiResearch, "unassessed"); assert.equal(before.aiResearchReason, "");
    const db = new DatabaseSync(path);
    const schema = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    const structure = db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
    service.handle(TASKS.properties, { id: "research", expectedRevision: 1, aiResearch: "proactive", aiResearchReason: "Repository and requirements suffice for read-only investigation." });
    assert.equal(read().revision, 2); assert.equal(read().status, "backlog"); assert.equal(read().assigneeId, null);
    assert.equal(read().conversations.length, 0); assert.equal(read().latestProgress, null);
    assert.throws(() => service.handle(TASKS.properties, { id: "research", expectedRevision: 1, aiResearch: "needs_decision", aiResearchReason: "Stale write" }), (e: any) => e.code === -32051);
    service.handle(TASKS.update, { ...content, title: "Legacy edit", id: "research", expectedRevision: 2 });
    assert.equal(read().aiResearch, "proactive");
    service.handle(TASKS.properties, { id: "research", expectedRevision: 3, priority: "high" });
    assert.equal(read().aiResearch, "proactive");
    service.close(); service = new TasksService(path);
    assert.equal(read().aiResearch, "proactive");
    service.handle(TASKS.properties, { id: "research", expectedRevision: 4, aiResearch: "needs_context", aiResearchReason: "Need the current integration contract." });
    const snapshot = service.handle(TASKS.list, {}) as { tasks: TaskDetail[] };
    assert.equal(snapshot.tasks[0]?.aiResearch, "needs_context");
    const events = service.handle(TASKS.events, { taskId: "research" }) as { events: Array<{ payload: any }> };
    assert.equal(events.events.filter(e => e.payload.aiResearch === "proactive").length, 1);
    assert.equal(events.events[0]?.payload.aiResearchReason, "Need the current integration contract.");
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), schema);
    assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(), structure);
    service.handle(TASKS.archive, { id: "research", expectedRevision: 5 });
    assert.throws(() => service.handle(TASKS.properties, { id: "research", expectedRevision: 6, aiResearch: "proactive", aiResearchReason: "Archived is read-only" }));
    assert.equal(read().aiResearch, "needs_context"); db.close();
  } finally { service.close(); await rm(root, { recursive: true, force: true }); }
});

test("invalid triage and missing rationale reject atomically; unsupported values do not change tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "tasks-research-input-"));
  const service = new TasksService(join(root, "tasks.sqlite"));
  try {
    service.handle(TASKS.create, { id: "task", title: "Investigate", description: "", status: "todo", projectId: null, projectServerId: null });
    const before = service.handle(TASKS.read, { id: "task" });
    for (const change of [{ aiResearch: true }, { aiResearch: "unknown" }, { aiResearch: "proactive" }, { aiResearch: "needs_decision", aiResearchReason: " " }, { aiResearchReason: "x".repeat(2049) }]) {
      assert.throws(() => service.handle(TASKS.properties, { id: "task", expectedRevision: 1, ...change }));
      assert.deepEqual(service.handle(TASKS.read, { id: "task" }), before);
    }
    service.handle(TASKS.properties, { id: "task", expectedRevision: 1, aiResearch: "needs_decision", aiResearchReason: "Choose the target users first." });
    service.handle(TASKS.properties, { id: "task", expectedRevision: 2, aiResearch: "needs_decision", aiResearchReason: "Choose the target users first." });
    assert.equal((service.handle(TASKS.read, { id: "task" }) as TaskDetail).revision, 2, "Identical reconciled assessment is a no-op");
  } finally { service.close(); await rm(root, { recursive: true, force: true }); }
});
