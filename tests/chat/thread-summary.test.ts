import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { ConversationSummaryService, createWorkbenchPanelReactRuntime } from "@opencraft/workbench-panels-react";
import type { TimelineBlock, TimelineSnapshot } from "@opencraft/chat-core";
import { deriveThreadSummary } from "../../plugins/thread-summary/src/model";
import { presentSummaryFiles } from "../../plugins/thread-summary/src/file-presentation";
import { resolveSummaryPresentation } from "../../apps/workbench-web/src/components/conversation-summary-layout";

test("summary reserves space only after the reading column fits, and uses a spare gutter without reservation", () => {
  assert.equal(resolveSummaryPresentation(1127, 768, 360), "overlay");
  assert.equal(resolveSummaryPresentation(1128, 768, 360), "shift");
  assert.equal(resolveSummaryPresentation(1487, 768, 360), "shift");
  assert.equal(resolveSummaryPresentation(1488, 768, 360), "gutter");
  assert.equal(resolveSummaryPresentation(1280, 1000, 360), "overlay");
  assert.equal(resolveSummaryPresentation(1280, 500, 360), "gutter");
  for (const width of [0, -1, NaN, Infinity]) assert.equal(resolveSummaryPresentation(width, 768, 360), "overlay");
});

test("file presentation removes only shared directory segments and preserves disambiguation and extensions", () => {
  const display = presentSummaryFiles(["/workspace/project/src/a.ts", "/workspace/project/tests/a.ts", "/workspace/project/.env"]);
  assert.equal(display.root, "/workspace/project");
  assert.equal(display.rootLabel, "project");
  assert.deepEqual(display.files, [
    { name: "a.ts", stem: "a", extension: ".ts", directory: "src" },
    { name: "a.ts", stem: "a", extension: ".ts", directory: "tests" },
    { name: ".env", stem: ".env", extension: "", directory: "" },
  ]);
  assert.equal(presentSummaryFiles(["src/a.ts", "src-other/a.ts"]).root, "");
  assert.equal(presentSummaryFiles(["C:\\project\\src\\a.ts", "C:\\project\\tests\\a.ts"]).root, "C:/project");
  assert.equal(presentSummaryFiles(["/workspace/project/README"]).files[0]?.extension, "");
  assert.deepEqual(presentSummaryFiles([]).files, []);
});

function history(blocks: unknown[]): TimelineSnapshot {
  return { frames: [{ blocks, changeSummary: null }] } as unknown as TimelineSnapshot;
}
test("summary uses the latest structured plan and deduplicates changed paths", () => {
  const summary = deriveThreadSummary(history([
    { type: "todo", entries: [{ id: "old", text: "Old plan", status: "pending" }] },
    { type: "todo", entries: [{ id: "new", text: "Current plan", status: "in-progress" }] },
    { type: "patch", changes: [{ path: "a.ts", kind: "add" }] },
    { type: "turn-diff", files: [{ path: "a.ts" }, { path: "b.ts" }] },
    { type: "patch", changes: [{ path: "a.ts", kind: "modify" }] },
  ]));
  assert.equal(summary.steps[0]?.id, "new");
  assert.deepEqual(summary.files, [{ path: "a.ts", kind: "modify" }, { path: "b.ts", kind: "unknown" }]);
  assert.deepEqual(deriveThreadSummary(null), { steps: [], files: [], activities: [], hasHistory: false });
});
test("a completed spawn call does not complete the agent; terminal command updates remove active commands", () => {
  const agent = { type: "subagent", id: "spawn", agentId: null, label: "Research", action: "spawn", tool: "spawnAgent", senderThreadId: null,
    receiverThreadIds: ["child"], prompt: null, model: null, reasoningEffort: null, agentStates: {}, activityKind: "started", agentPath: null, status: "complete" };
  const timeline = history([{ type: "command-execution", id: "cmd", status: "running", command: "npm test" }, agent]);
  assert.equal(deriveThreadSummary(timeline).activities.find(a => a.threadId === "child")?.status, "unknown");
  const final = deriveThreadSummary(history([...(timeline.frames[0]!.blocks as TimelineBlock[]),
    { type: "command-execution", id: "cmd", status: "complete", command: "npm test" },
    { ...agent, agentStates: { child: { status: "running" } }, tool: "wait" },
  ]));
  assert.equal(final.activities.length, 1);
  assert.equal(final.activities[0]?.status, "running");
  assert.equal(deriveThreadSummary(history([{ ...agent, agentStates: { child: { status: "completed" } } }])).activities[0]?.status, "complete");
});
test("summary registration rejects conflicting ownership and stale disposers cannot revoke a replacement", async () => {
  const ctx = new Context();
  const fiber = ctx.plugin(ConversationSummaryService); await fiber;
  const service = ctx.conversationSummary;
  let changes = 0; const release = service.subscribe(() => changes++);
  const value = { id: "test", title: { id: "test", defaultMessage: "Test" }, Component: () => null };
  const dispose = service.register(value);
  assert.throws(() => service.register(value));
  assert.equal(service.getSnapshot(), value);
  dispose(); const replacement = service.register({ ...value, id: "next" }); dispose();
  assert.equal(service.getSnapshot()?.id, "next");
  replacement(); release(); await fiber.dispose();
  assert.equal(service.getSnapshot(), null); assert.equal(changes, 4);
});
test("trusted plugin lifecycle removes its contribution and releases the runtime", async () => {
  const { ThreadSummaryPlugin } = await import("../../plugins/thread-summary/src/index");
  const runtime = await createWorkbenchPanelReactRuntime();
  const fiber = await runtime.install(ThreadSummaryPlugin);
  assert.equal(runtime.context.conversationSummary.getSnapshot()?.id, "opencraft.thread-summary");
  await fiber.dispose();
  assert.equal(runtime.context.conversationSummary.getSnapshot(), null);
  await runtime.dispose();
});

test("renames open the new path and presentation-only agent IDs never become thread links", () => {
  assert.deepEqual(deriveThreadSummary(history([
    { type: "patch", changes: [{ path: "before.ts", kind: "modify" }] },
    { type: "patch", changes: [{ path: "before.ts", movePath: "after.ts", kind: "modify" }] },
  ])).files, [{ path: "after.ts", kind: "modify" }]);
  const summary = deriveThreadSummary(history([{ type: "subagent", id: "display-only", label: "Agent", agentId: null,
    receiverThreadIds: [], agentStates: {}, tool: null, activityKind: null, agentPath: null, status: "complete" }]));
  assert.deepEqual(summary.activities, []);
});
