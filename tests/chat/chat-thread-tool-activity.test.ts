import assert from "node:assert/strict";
import test from "node:test";
import {
  createConversationKey, createDefaultTimelineProjectorRegistry, presentToolActivity,
  projectTimeline, type ToolCallTimelineBlock,
} from "@opencraft/chat-core";

const calls = [
  ["fork_thread", {}], ["create_thread", { target: { type: "project" } }],
  ["list_threads", {}], ["read_thread", { threadId: "other" }],
  ["handoff_thread", { threadId: "other", destinationHostId: "remote" }],
  ["get_handoff_status", { operationId: "transfer" }],
  ["send_message_to_thread", { threadId: "other", message: "Continue" }],
  ["set_thread_pinned", { threadId: "other", pinned: true }],
  ["set_thread_archived", { threadId: "other", archived: true }],
  ["set_thread_title", { threadId: "other", title: "Review" }],
] as const;

function call(name: string, input: unknown): ToolCallTimelineBlock {
  const block = projectTimeline({
    key: createConversationKey("fixture", "thread-tools"), revision: 0,
    authoritative: true, phase: "live", turns: [{ id: "turn", status: "complete", items: [{
      id: "tool", type: "dynamicToolCall", payload: {
        namespace: "codex_app", tool: name, arguments: input, status: "completed", success: true,
      },
    }] }],
  }, createDefaultTimelineProjectorRegistry()).frames[0]?.blocks[0];
  if (block?.type !== "tool-call") throw new Error("Expected thread tool");
  return block;
}

for (const [name, input] of calls) {
  test(`${name}: unsuccessful calls never announce completion`, () => {
    const block = call(name, input);
    const failed = presentToolActivity({ ...block, status: "failed", errorMessage: "Operation rejected" });
    assert.equal(failed.state, "failed");
    assert.match(failed.summary, / · Failed$/);
    assert.equal(failed.detail, "Operation rejected");
    assert.equal(failed.continuesLiveActivityBetweenCalls, false);
    assert.equal(failed.summaryOnlyInConversationGroup, false);
    const stopped = presentToolActivity({ ...block, status: "interrupted" });
    assert.equal(stopped.state, "interrupted");
    assert.match(stopped.summary, / · Stopped$/);
    assert.equal(stopped.continuesLiveActivityBetweenCalls, false);
    assert.equal(stopped.summaryOnlyInConversationGroup, false);
  });
}

test("provider action titles remain presentation-only and worktree context survives every phase", () => {
  const block = { ...call("fork_thread", { environment: { type: "worktree" } }), actionName: "Review branch" };
  for (const [status, label] of [["running", "Running"], ["complete", "Completed"], ["failed", "Failed"], ["interrupted", "Stopped"]] as const) {
    const result = presentToolActivity({ ...block, status });
    assert.equal(result.summary, `Review branch · Worktree · ${label}`);
    assert.equal(result.summaryKey, "thread-tool:fork_thread:default");
  }
});

test("a stale transfer payload cannot override terminal execution failure or interruption", () => {
  const block = { ...call("handoff_thread", { threadId: "other" }), output: JSON.stringify({
    operationId: "transfer", status: "running", threadTitle: "Review", destinationHostDisplayName: "Remote",
  }) };
  for (const status of ["failed", "interrupted"] as const) {
    const result = presentToolActivity({ ...block, status });
    assert.equal(result.state, status);
    assert.match(result.summary, status === "failed" ? / · Failed$/ : / · Stopped$/);
  }
});
