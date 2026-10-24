import assert from "node:assert/strict";
import test from "node:test";
import { TasksEditorSession } from "../../plugins/tasks/src/editor-session";
import { taskConversationContext } from "../../apps/workbench-web/src/runtime/task-conversation-flow";
import type { TaskDetail } from "@opencraft/appserver-protocol";
const task: TaskDetail = { id: "a", title: "Harness", description: "Scenario", status: "backlog", kind: "harness", acceptanceCriteria: "Regressions pass", revision: 7, projectId: null, projectServerId: null, sortOrder: 0, createdAt: 1, updatedAt: 2, deletedAt: null, conversations: [] };
test("quick/full and dismissal share a draft with its original CAS baseline; explicit latest resets it", () => {
  const session = new TasksEditorSession(); session.open(task, task.status, "quick");
  session.set({ ...session.getSnapshot().draft!, title: "Unsaved", acceptanceCriteria: "New criteria" });
  const draft = session.getSnapshot().draft; session.full(); assert.equal(session.getSnapshot().draft, draft);
  session.close(); session.open({ ...task, revision: 8 });
  assert.equal(session.getSnapshot().draft, draft); assert.equal(session.getSnapshot().draft?.revision, 7);
  session.saved({ ...task, revision: 8 }); assert.equal(session.getSnapshot().draft?.title, "Harness");
  session.clear();
});
test("new title drafts retain a stable ID until accepted and use backlog only when not explicitly placed", () => {
  const session = new TasksEditorSession(); session.open(); const first = session.getSnapshot().draft!;
  assert.equal(first.status, "backlog"); session.close(); session.open(); assert.equal(session.getSnapshot().draft?.id, first.id);
  session.saved({ ...task, id: first.id }); session.close(); session.open(undefined, "in_progress");
  assert.notEqual(session.getSnapshot().draft?.id, first.id); assert.equal(session.getSnapshot().draft?.status, "in_progress");
});
test("native context includes authoritative planning and progress within a fixed text budget", () => {
  const value = taskConversationContext({ ...task, description: "x".repeat(16000), acceptanceCriteria: "y".repeat(16000) }, Array.from({ length: 40 }, (_, i) => ({ text: `${i}:` + "z".repeat(4000), createdAt: i + 1 })));
  assert.match(value, /Task ID: a · revision 7/); assert.match(value, /Type: harness/); assert.match(value, /Acceptance criteria:/); assert.match(value, /Recent progress:/); assert.ok(value.length < 10500); assert.equal(value.includes("3:zz"), false);
});

test("reopening a clean task uses the latest authority without a fabricated draft conflict", () => {
  const session = new TasksEditorSession(); session.open(task); session.close(); session.open({ ...task, title: "Remote edit", revision: 8 });
  assert.equal(session.getSnapshot().draft?.title, "Remote edit"); assert.equal(session.getSnapshot().draft?.revision, 8);
});
