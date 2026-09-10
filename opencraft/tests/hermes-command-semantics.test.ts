import assert from "node:assert/strict";
import test from "node:test";
import { classifyCommand } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/command-semantics";
import { projectHermesTool } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/tool-semantics";
import { mapMessages } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/adapter";
import { HermesTurnEventStateMachine } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/turn-event-state-machine";
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline, presentToolActivity, createAssistantTurnPresentationPlan } from "@opencraft/chat-core";
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
