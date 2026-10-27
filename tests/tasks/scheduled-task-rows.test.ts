import assert from "node:assert/strict";
import test from "node:test";
import { projectScheduledTaskRows } from "../../apps/workbench-web/src/runtime/scheduled-task-rows";

test("catalog includes schedules absent from paginated conversation metadata and separates Host identities", () => {
  const rows = projectScheduledTaskRows([
    { hostId: "host-a", schedules: [{ threadId: "same", status: "active", nextRunAt: 20, needsReview: false }, { threadId: "not-loaded", status: "paused", nextRunAt: 30, needsReview: false }] },
    { hostId: "host-b", schedules: [{ threadId: "same", status: "active", nextRunAt: 10, needsReview: false }] },
  ], [{ connectionHostId: "host-a", id: "same", title: "First Host conversation" }, { connectionHostId: "host-b", id: "same", title: "Second Host conversation" }]);
  assert.deepEqual(rows.map(row => row.title), ["Second Host conversation", "First Host conversation", "not-loaded"]);
  assert.equal(rows[2]?.status, "paused");
});

test("unresolved acceptance stays visible and takes priority even for a completed/deleted plan", () => {
  const rows = projectScheduledTaskRows([{ hostId: "server", schedules: [
    { threadId: "normal", status: "active", nextRunAt: 1, needsReview: false },
    { threadId: "uncertain", status: "deleted", nextRunAt: 10, needsReview: true },
  ] }], []);
  assert.equal(rows[0]?.threadId, "uncertain");
  assert.equal(rows[0]?.needsReview, true);
});
