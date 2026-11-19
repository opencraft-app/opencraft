import assert from "node:assert/strict";
import test from "node:test";
import {
  createConversationKey,
  createDefaultTimelineProjectorRegistry,
  projectTimeline,
  deriveSubagentActivitySummary,
  subagentInlineStatusLabel,
  type SubagentTimelineBlock,
  type TimelineSourceItem,
} from "@opencraft/chat-core";

function blocks(items: readonly TimelineSourceItem[]): readonly SubagentTimelineBlock[] {
  return projectTimeline(
    {
      key: createConversationKey("host", "parent"),
      revision: 1,
      authoritative: true,
      phase: "ready",
      turns: [{ id: "turn", status: "streaming", items }],
    },
    createDefaultTimelineProjectorRegistry(),
  )
    .frames.flatMap((frame) => frame.blocks)
    .filter((block) => block.type === "subagent");
}
function spawn(id: string, status: string, receipt?: unknown): TimelineSourceItem {
  return {
    id,
    type: "dynamicToolCall",
    payload: {
      tool: "thread_spawn",
      namespace: null,
      status,
      arguments: { title: "Review " + id, prompt: "Check permissions" },
      contentItems: receipt ? [{ type: "inputText", text: JSON.stringify(receipt) }] : [],
    },
  };
}

test("pending creation has a task identity, never a synthetic Thread; receipt preserves its key", () => {
  const pending = deriveSubagentActivitySummary(blocks([spawn("first", "inProgress")]));
  assert.equal(pending.status, "starting");
  assert.equal(pending.members[0]!.displayName, "Review first");
  assert.equal(pending.members[0]!.threadId, null);
  const active = deriveSubagentActivitySummary(
    blocks([spawn("first", "completed", { threadId: "child", status: "active" })]),
  );
  assert.equal(active.status, "working");
  assert.equal(active.members[0]!.threadId, "child");
  assert.equal(active.members[0]!.key, pending.members[0]!.key);
  assert.deepEqual(
    deriveSubagentActivitySummary(blocks([spawn("first", "inProgress")])),
    pending,
    "replay preserves pending presentation",
  );
});

test("mixed pending and resolved creations keep source order and stable membership", () => {
  const first = spawn("first", "inProgress");
  const second = spawn("second", "completed", { threadId: "second-child", status: "active" });
  const before = deriveSubagentActivitySummary(blocks([first, second]));
  const after = deriveSubagentActivitySummary(
    blocks([spawn("first", "completed", { threadId: "first-child", status: "active" }), second]),
  );
  assert.deepEqual(
    before.members.map((member) => member.displayName),
    ["Review first", "Review second"],
  );
  assert.deepEqual(
    after.members.map((member) => member.key),
    before.members.map((member) => member.key),
  );
});

test("completed calls and accepted messages cannot invent a completed task", () => {
  const unknown = blocks([spawn("first", "completed", { threadId: "child" })]);
  assert.equal(deriveSubagentActivitySummary(unknown).status, "unknown");
  const sent = { ...unknown[0]!, tool: "sendInput" as const, deliveryStatus: "submitted" as const };
  assert.equal(deriveSubagentActivitySummary([sent]).status, "unknown");
  for (const deliveryStatus of ["accepted", "transferring", "queued"] as const) {
    assert.equal(deriveSubagentActivitySummary([{ ...sent, deliveryStatus }]).status, "unknown");
  }
  assert.equal(deriveSubagentActivitySummary([{ ...sent, childRuntimeStatus: { child: "active" } }]).status, "working");
  assert.equal(deriveSubagentActivitySummary([{ ...sent, childRuntimeStatus: { child: "idle" } }]).status, "done");
  assert.equal(deriveSubagentActivitySummary([{ ...sent, deliveryStatus: "rejected" }]).status, "failed");
  assert.equal(deriveSubagentActivitySummary([{ ...sent, deliveryStatus: "cancelled" }]).status, "interrupted");
  assert.equal(
    deriveSubagentActivitySummary([{ ...sent, childRuntimeStatus: { child: "awaiting_interaction" } }]).status,
    "attention",
  );
});

test("childless failure and cancellation remain visible and preserve the task title", () => {
  const pending = blocks([spawn("first", "inProgress")])[0]!;
  for (const [toolCallStatus, status] of [
    ["failed", "failed"],
    ["interrupted", "interrupted"],
  ] as const) {
    const summary = deriveSubagentActivitySummary([{ ...pending, toolCallStatus }]);
    assert.equal(summary.status, status);
    assert.equal(summary.members[0]!.displayName, "Review first");
    assert.equal(summary.members[0]!.threadId, null);
  }
});

test("all native lifecycle notifications share names and truthful activity wording", () => {
  for (const [kind, status] of [
    ["started", "working"],
    ["interacted", "updated"],
    ["interrupted", "interrupted"],
    ["completed", "done"],
  ] as const) {
    const projected = blocks([
      {
        id: "notice",
        type: "subAgentActivity",
        payload: {
          kind,
          agentThreadId: "child",
          agentPath: "/root/Compiler-Reviewer",
        },
      },
    ]);
    const summary = deriveSubagentActivitySummary(projected);
    assert.equal(summary.status, status);
    assert.equal(summary.members[0]!.displayName, "Compiler Reviewer");
    assert.equal(summary.members[0]!.threadId, "child");
  }
});

test("authoritative child state still overrides lifecycle wording", () => {
  const started = blocks([
    {
      id: "notice",
      type: "subAgentActivity",
      payload: {
        kind: "started",
        agentThreadId: "child",
        agentPath: "/root/Reviewer",
      },
    },
  ])[0]!;
  const failed = deriveSubagentActivitySummary([{ ...started, childRuntimeStatus: { child: "failed" } }]);
  assert.equal(failed.status, "failed");
  assert.match(subagentInlineStatusLabel(failed.agents[0]!), /failed$/);
  assert.equal(
    deriveSubagentActivitySummary([{ ...started, childRuntimeStatus: { child: "unknown" } }]).status,
    "unknown",
  );
});
