import assert from "node:assert/strict";
import test from "node:test";
import {
  createConversationKey, createDefaultTimelineProjectorRegistry, presentToolActivity,
  projectTimeline, threadHandoffToolResult, visibleThreadHandoffSteps,
  formatThreadHandoffStepLabel, formatMcpToolActivityLabel, type ToolCallTimelineBlock,
} from "@opencraft/chat-core";

function tool(kind: "dynamicToolCall" | "mcpToolCall", payload: Record<string, unknown>): ToolCallTimelineBlock {
  const block = projectTimeline({ key: createConversationKey("fixture", "tool-surface"), revision: 0,
    authoritative: true, phase: "live", turns: [{ id: "turn", status: "complete", items: [{
      id: "call", type: kind, payload: { status: "completed", success: true, ...payload },
    }] }],
  }, createDefaultTimelineProjectorRegistry()).frames[0]?.blocks[0];
  assert.equal(block?.type, "tool-call");
  if (block?.type !== "tool-call") throw new Error("Expected tool call");
  return block;
}

for (const [name, block] of [
  ["browser", tool("mcpToolCall", { server: "browser", tool: "click", result: {
    content: [], _meta: { "codex/toolSurface": { kind: "browserUse", backend: "chrome" } },
  } })],
  ["computer", tool("mcpToolCall", { server: "computer-use", tool: "scroll", arguments: { direction: "down", app: "Notes" } })],
  ["generic MCP", tool("mcpToolCall", { server: "custom", tool: "do_something" })],
  ["terminal", tool("dynamicToolCall", { namespace: "codex_app", tool: "read_thread_terminal" })],
  ["custom dynamic", tool("dynamicToolCall", { namespace: "custom", tool: "do_something" })],
] as const) {
  test(`${name}: activity title records every execution outcome without claiming success`, () => {
    for (const [status, phase] of [["running", "Running"], ["complete", "Completed"], ["failed", "Failed"], ["interrupted", "Stopped"]] as const) {
      const presentation = presentToolActivity({ ...block, status });
      assert.match(presentation.summary, new RegExp(` · ${phase}$`));
      assert.equal(presentation.state, status === "complete" ? "completed" : status);
    }
  });
}

test("computer operation context works for future tools and keeps application identity distinct from process identifiers", () => {
  const block = tool("mcpToolCall", { server: "computer-use", tool: "inspect_custom_control", arguments: { app: "com.example.notes" }, appContext: { appName: "Notes" } });
  assert.equal(presentToolActivity(block).summary, "Inspect custom control · Notes · Completed");
  assert.doesNotMatch(presentToolActivity(block).summary, /com\.example/);
});

test("direct MCP label callers respect an error result despite a completed transport", () => {
  const block = tool("mcpToolCall", { server: "custom", tool: "inspect" });
  assert.equal(formatMcpToolActivityLabel({ ...block, status: "complete", errorMessage: null, output: { isError: true } }), "Inspect · Failed");
});

test("handoff steps preserve reported states, including queued steps and explicit rollback", () => {
  for (const status of ["queued", "running", "warning", "error", "success"]) {
    const block = tool("dynamicToolCall", { namespace: "codex_app", tool: "handoff_thread", arguments: { threadId: "target" },
      contentItems: [{ type: "inputText", text: JSON.stringify({ operationId: "transfer", status,
        steps: [{ id: "prepare-host-transfer", status: "done" }, { id: "transfer-host-artifacts", status: "failed" },
          { id: "create-new-worktree", status: "pending" }, { id: "rolling-back-changes", status: "done" }],
      }) }],
    });
    const result = threadHandoffToolResult(block);
    assert.ok(result);
    for (const step of result.steps) Object.freeze(step);
    Object.freeze(result.steps);
    assert.deepEqual(visibleThreadHandoffSteps(result), result.steps);
    assert.equal(visibleThreadHandoffSteps(result).filter(step => step.status === "running").length, 0);
  }
});

test("queued handoff never promotes a pending step into execution", () => {
  const block = tool("dynamicToolCall", { namespace: "codex_app", tool: "handoff_thread", arguments: { threadId: "target" },
    contentItems: [{ type: "inputText", text: JSON.stringify({ operationId: "transfer", status: "queued", steps: [{ id: "prepare-host-transfer", status: "pending" }] }) }],
  });
  const result = threadHandoffToolResult(block);
  assert.ok(result);
  assert.equal(visibleThreadHandoffSteps(result)[0]?.status, "pending");
  assert.equal(presentToolActivity(block).summary, "Transfer · Queued");
});

test("handoff summary keeps identity, destination and reported outcome; labels keep branch context", () => {
  for (const [status, phase] of [["queued", "Queued"], ["running", "Running"], ["success", "Completed"], ["warning", "Needs attention"], ["error", "Failed"]]) {
    const block = tool("dynamicToolCall", { namespace: "codex_app", tool: "get_handoff_status", arguments: { operationId: "transfer" },
      contentItems: [{ type: "inputText", text: JSON.stringify({ operationId: "transfer", status, threadTitle: "Review", destinationHostDisplayName: "Remote" }) }],
    });
    assert.equal(presentToolActivity(block).summary, `Transfer · Review · Remote · ${phase}`);
  }
  const context = { direction: "to-host-worktree", localBranch: "local", worktreeBranch: "review", sourceBranch: "main" } as const;
  assert.equal(formatThreadHandoffStepLabel("checkout-worktree-branch", context), "Checkout worktree branch · review");
  assert.equal(formatThreadHandoffStepLabel("switching-thread", context), "Switching thread · Destination worktree");
  assert.equal(formatThreadHandoffStepLabel("custom-future-step", context), "Custom future step");
});
