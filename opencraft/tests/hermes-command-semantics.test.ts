import assert from "node:assert/strict";
import test from "node:test";
import { classifyCommand } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/command-semantics";
import { projectHermesTool } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/tool-semantics";
import { mapMessages } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/adapter";
import { HermesTurnEventStateMachine } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/turn-event-state-machine";
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline, presentToolActivity, createAssistantTurnPresentationPlan, isToolActivityPresentationSuppressed } from "@opencraft/chat-core";
import type { AppServerTurn } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/types";

test("conservative command semantics never hide shell side effects", () => {
  for (const [command, kind] of [["ls -la src", "listFiles"], ["cat 'file name.txt'", "read"], ["rg -n needle src", "search"]]) {
    assert.equal(classifyCommand(command)[0].type, kind);
  }
  for (const command of ["ls; rm file", "cat a > b", "cat $(touch x)", "ls | head", "bash -c 'ls'", "cat *.txt", "cat", "ls --unknown", "cat a b", "ls\nrm x", "cat 'unterminated"]) {
    assert.deepEqual(classifyCommand(command), [{ type: "unknown", command }]);
  }
});

function frame(turn: AppServerTurn) {
  const snapshot = projectTimeline({ key: createConversationKey("host", "thread"), revision: 1, phase: "live", authoritative: true,
    turns: [{ id: turn.id, status: "complete", items: turn.items.map(item => ({ id: item.id, type: item.type, payload: item })) }],
  }, createDefaultTimelineProjectorRegistry());
  return snapshot.frames.find(f => f.type === "assistant")!;
}

test("live and history feed identical standard command semantics and preserve call identity", () => {
  const turn: AppServerTurn = { id: "turn", items: [], itemsView: "full", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null };
  const machine = new HermesTurnEventStateMachine("thread", turn);
  machine.project({ type: "tool.start", payload: { tool_id: "call", name: "terminal", args: { command: "ls src" } } });
  const id = turn.items[0].id;
  machine.project({ type: "tool.complete", payload: { tool_id: "call", name: "terminal", result: { output: "app.ts", exit_code: 0 } } });
  assert.equal(turn.items[0].id, id);
  const [history] = mapMessages("thread", [{ role: "user", content: "Inspect" },
    { role: "assistant", content: "", tool_calls: [{ id: "call", function: { name: "terminal", arguments: '{"command":"ls src"}' } }] },
    { role: "tool", tool_call_id: "call", content: '{"output":"app.ts","exit_code":0}' }]);
  const a = frame(turn).blocks.find(b => b.type === "command-execution");
  const b = frame(history).blocks.find(b => b.type === "command-execution");
  assert.ok(a?.type === "command-execution" && b?.type === "command-execution");
  assert.deepEqual(a.actions, b.actions);
  assert.equal(a.callId, b.callId);
  assert.equal(a.output, b.output);
  assert.equal(presentToolActivity(a).summary, "Listed files");
});

test("semantic grouping preserves interaction barriers and original ordering", () => {
  const items = ["read_file", "search_files", "clarify", "read_file"].map((tool, index) => projectHermesTool({
    id: String(index), type: "dynamicToolCall", namespace: "hermes", tool, arguments: { path: "src/a" }, status: "completed", success: true,
  }));
  const turn: AppServerTurn = { id: "t", items, itemsView: "full", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1000 };
  const plan = createAssistantTurnPresentationPlan(frame(turn));
  const activity = plan.slots.find(s => s.type === "agent-activity");
  assert.ok(activity?.type === "agent-activity");
  assert.deepEqual(activity.contentUnits.map(u => u.type), ["group", "standalone", "standalone"]);
  assert.deepEqual(activity.blocks.map(b => b.sourceItemIds), [["0"], ["1"], ["2"], ["3"]]);
});

test("background submission retains process handle without claiming an exit", () => {
  const item = projectHermesTool({ type: "dynamicToolCall", id: "call", tool: "terminal", arguments: { command: "ls", background: true }, structuredResult: { session_id: "process" }, status: "completed" });
  assert.equal(item.processId, "process");
  assert.equal(item.exitCode, null);
  assert.equal((item.commandActions as {type: string}[])[0].type, "unknown");
});

test("result-missing evidence reaches the standard command projection", () => {
  const item = projectHermesTool({ type: "dynamicToolCall", id: "call", tool: "terminal", arguments: { command: "ls" }, status: "completed", resultMissing: true });
  const turn: AppServerTurn = { id: "t", items: [item], itemsView: "full", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1000 };
  const block = frame(turn).blocks.find(b => b.type === "command-execution");
  assert.ok(block?.type === "command-execution");
  assert.equal(block.resultMissing, true);
  assert.equal(block.exitCode, null);
});

test("Hermes source tools become canonical AppServer Items before rendering", () => {
  const file = projectHermesTool({
    type: "dynamicToolCall", id: "file", namespace: "hermes", tool: "write_file",
    arguments: { path: "/workspace/src/app.ts" },
    structuredResult: { diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new" },
    status: "completed", success: true,
  });
  const delegate = projectHermesTool({
    type: "dynamicToolCall", id: "delegate", namespace: "hermes", tool: "delegate_task",
    arguments: { tasks: [{ goal: "Inspect transport" }, { goal: "Inspect renderer" }] },
    structuredResult: { results: [{ session_id: "child-a", status: "completed" }, { session_id: "child-b", status: "completed" }] },
    status: "completed", success: true,
  });
  const image = projectHermesTool({
    type: "dynamicToolCall", id: "image", namespace: "hermes", tool: "image_generate",
    arguments: { prompt: "A lighthouse" }, structuredResult: { image_url: "https://example.test/lighthouse.png" },
    status: "completed", success: true,
  });
  const todo = projectHermesTool({
    type: "dynamicToolCall", id: "todo", namespace: "hermes", tool: "todo",
    arguments: { todos: [{ id: "one", content: "Inspect", status: "completed" }] },
    status: "completed", success: true,
  });
  const command = projectHermesTool({
    type: "dynamicToolCall", id: "code", namespace: "hermes", tool: "execute_code",
    arguments: { code: "print('ok')" }, structuredResult: { stdout: "ok", exit_code: 0 },
    status: "completed", success: true,
  });

  assert.deepEqual([file.type, delegate.type, image.type, todo.type, command.type], [
    "fileChange", "collabAgentToolCall", "imageGeneration", "todoList", "commandExecution",
  ]);
  const turn: AppServerTurn = {
    id: "canonical", items: [file, delegate, image, todo, command], itemsView: "full",
    status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1000,
  };
  assert.deepEqual(frame(turn).blocks.map(({ type }) => type), ["patch", "subagent", "image", "todo", "command-execution"]);
});

test("file edits keep one canonical identity across live updates and durable history", () => {
  const diff = "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new";
  const liveTurn: AppServerTurn = {
    id: "live-file", items: [], itemsView: "full", status: "inProgress", error: null,
    startedAt: 1, completedAt: null, durationMs: null,
  };
  const machine = new HermesTurnEventStateMachine("thread", liveTurn);
  machine.project({ type: "tool.start", payload: { tool_id: "write", name: "write_file", args: { path: "/workspace/src/app.ts" } } });
  const liveId = liveTurn.items[0]?.id;
  machine.project({ type: "tool.complete", payload: { tool_id: "write", name: "write_file", result: { diff } } });
  assert.equal(liveTurn.items[0]?.id, liveId);

  const [historyTurn] = mapMessages("thread", [
    { role: "user", content: "Edit it" },
    { role: "assistant", content: "", tool_calls: [{ id: "write", function: { name: "write_file", arguments: '{"path":"/workspace/src/app.ts"}' } }] },
    { role: "tool", tool_call_id: "write", content: JSON.stringify({ diff }) },
  ]);
  const live = frame(liveTurn).blocks.find((block) => block.type === "patch");
  const history = frame(historyTurn).blocks.find((block) => block.type === "patch");
  assert.ok(live?.type === "patch" && history?.type === "patch");
  assert.deepEqual(live.changes, history.changes);
  assert.equal(live.sourceItemIds[0], history.sourceItemIds[0]);
});

test("adapter-owned activity visibility prevents duplicate Hermes surfaces", () => {
  const runningClarify = projectHermesTool({
    type: "dynamicToolCall", id: "clarify", namespace: "hermes", tool: "clarify",
    arguments: { question: "Which target?" }, status: "inProgress",
  });
  const reaction = projectHermesTool({
    type: "dynamicToolCall", id: "reaction", namespace: "hermes", tool: "react_to_message",
    arguments: { emoji: "👍" }, status: "completed", success: true,
  });
  const failedReaction = projectHermesTool({
    type: "dynamicToolCall", id: "failed-reaction", namespace: "hermes", tool: "react_to_message",
    arguments: { emoji: "👍" }, status: "failed", success: false,
  });
  const turn: AppServerTurn = {
    id: "visibility", items: [runningClarify, reaction, failedReaction], itemsView: "full",
    status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null,
  };
  const blocks = frame(turn).blocks.filter((block) => block.type === "tool-call");
  assert.equal(blocks.length, 3);
  assert.equal(isToolActivityPresentationSuppressed(blocks[0]!), true);
  assert.equal(isToolActivityPresentationSuppressed(blocks[1]!), true);
  assert.equal(isToolActivityPresentationSuppressed(blocks[2]!), false);
});

test("provider summaries never grant generic Hermes payloads an expandable body", () => {
  const item = projectHermesTool({
    type: "dynamicToolCall", id: "memory", namespace: "hermes", tool: "memory",
    arguments: { operation: "recall", query: "architecture" }, structuredResult: { memories: ["private payload"] },
    status: "completed", success: true,
  });
  const turn: AppServerTurn = {
    id: "generic", items: [item], itemsView: "full", status: "completed", error: null,
    startedAt: 1, completedAt: 2, durationMs: 1000,
  };
  const block = frame(turn).blocks.find((candidate) => candidate.type === "tool-call");
  assert.ok(block?.type === "tool-call");
  assert.equal(presentToolActivity(block).canExpand, false);
});
