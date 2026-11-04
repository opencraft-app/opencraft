import assert from "node:assert/strict";
import test from "node:test";
import { ConversationExecutionStatus } from "../../packages/app-host-server/src/conversation-execution-status.js";

const page = (status: unknown) => ({ data: [{ id: "thread", status }], nextCursor: "preserved" });
const active = { type: "active", activeFlags: [] };
const idle = { type: "idle" };

test("history and Turn activity cannot own execution status", () => {
  const projection = new ConversationExecutionStatus();
  projection.observe("turn/started", { threadId: "thread", turn: { id: "turn", status: "inProgress" } });
  projection.snapshot("thread/read", { thread: { id: "thread", status: active } }, projection.fence());
  assert.deepEqual(projection.project("thread/list", page(active)).data[0].status, { type: "notLoaded" });
  projection.observe("thread/status/changed", { threadId: "thread", status: active });
  assert.deepEqual(projection.project("thread/list", page({ type: "notLoaded" })).data[0].status, active);
  projection.observe("turn/completed", { threadId: "thread", turn: { status: "completed" } });
  assert.deepEqual(projection.status("thread"), active);
});

test("live owner status fences both in-flight and later cached directory replies", () => {
  const projection = new ConversationExecutionStatus(), before = projection.fence();
  const waiting = { type: "active", activeFlags: ["waitingOnApproval"] };
  projection.observe("thread/status/changed", { threadId: "thread", status: waiting });
  projection.snapshot("thread/list", page(idle), before);
  projection.snapshot("thread/list", page(idle), projection.fence());
  assert.deepEqual(projection.status("thread"), waiting);
  projection.observe("thread/status/changed", { threadId: "thread", status: idle });
  projection.snapshot("thread/list", page(active), before);
  assert.deepEqual(projection.status("thread"), idle);
  assert.equal(projection.project("thread/list", page(active)).nextCursor, "preserved");
});

test("source loss forgets live status and rejects old-incarnation snapshots", () => {
  const projection = new ConversationExecutionStatus(), before = projection.fence();
  projection.snapshot("thread/list", page(active), before);
  assert.deepEqual(projection.clear(), ["thread"]);
  projection.snapshot("thread/list", page(active), before);
  assert.deepEqual(projection.status("thread"), { type: "notLoaded" });
  projection.snapshot("thread/list", page(idle), projection.fence());
  assert.deepEqual(projection.status("thread"), idle);
});
