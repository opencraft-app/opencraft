import assert from "node:assert/strict";
import test from "node:test";
import { HermesTurnEventStateMachine } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/turn-event-state-machine";
import type { AppServerTurn } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/types";
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline, presentToolActivity, extractToolCallContentParts, createAssistantTurnPresentationPlan, resolveAgentActivityLayout } from "@opencraft/chat-core";
import { mapMessages } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/adapter";

function harness() {
  const turn: AppServerTurn = { id: "turn", items: [], itemsView: "full", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null };
  let id = 0;
  const machine = new HermesTurnEventStateMachine("thread", turn, () => String(++id));
  machine.accept(1000);
  const event = (type: string, payload: Record<string, unknown> = {}) => machine.project({ type, payload }, 1100 + id);
  return { turn, event };
}

test("completion without start seals preceding text before subsequent output", () => {
  const { turn, event } = harness();
  event("message.delta", { text: "Before" });
  event("tool.complete", { tool_id: "t", name: "terminal", result: { exit_code: 0 } });
  event("message.delta", { text: "After" });
  assert.deepEqual(turn.items.map(i => i.text ?? i.tool), ["Before", "terminal", "After"]);
  assert.equal(turn.items[0]!.phase, "commentary");
});

test("recovery retains source tool identity without reopening closed reasoning", () => {
  const turn = mapMessages("thread", [
    { role: "user", content: "Inspect" },
    { role: "assistant", content: "Checking", reasoning: "Old reasoning", tool_calls: [{ id: "t", function: { name: "terminal", arguments: "{}" } }] },
  ])[0]!;
  turn.status = "inProgress";
  const id = turn.items.find(i => i.type === "commandExecution")!.id;
  const machine = new HermesTurnEventStateMachine("thread", turn);
  machine.project({ type: "tool.complete", payload: { tool_id: "t", name: "terminal", result: { exit_code: 0 } } });
  assert.deepEqual(turn.items.filter(i => i.type === "commandExecution").map(i => i.id), [id]);
  machine.project({ type: "reasoning.delta", payload: { text: "New reasoning" } });
  assert.deepEqual(turn.items.filter(i => i.type === "reasoning").map(i => i.content), [["Old reasoning"], ["New reasoning"]]);
});

test("tool outcome requires evidence and turn completion does not manufacture success", () => {
  const { turn, event } = harness();
  event("tool.start", { tool_id: "bad", name: "terminal" });
  event("tool.complete", { tool_id: "bad", name: "terminal", result: { exit_code: 2 } });
  event("tool.start", { tool_id: "missing", name: "terminal" });
  event("message.complete", { text: "Done" });
  assert.equal(turn.items.find(i => i.id === "bad")!.success, false);
  assert.equal(turn.items.find(i => i.id === "missing")!.success, null);
  assert.equal(turn.items.find(i => i.id === "missing")!.resultMissing, true);
});

test("anonymous progress and later source ID retain one display owner", () => {
  const { turn, event } = harness();
  event("tool.start", { name: "terminal" });
  const id = turn.items[0]!.id;
  event("tool.progress", { name: "terminal", message: "Busy" });
  event("tool.complete", { tool_id: "source", name: "terminal", result: { exit_code: 0 } });
  assert.equal(turn.items.length, 1);
  assert.equal(turn.items[0]!.id, id);
  assert.equal(turn.items[0]!.callId, "source");
});

test("parallel explicit source IDs never merge and equal narration survives history", () => {
  const { turn, event } = harness();
  event("tool.start", { tool_id: "a", name: "terminal" });
  event("tool.start", { tool_id: "b", name: "terminal" });
  event("tool.complete", { tool_id: "b", name: "terminal", result: { exit_code: 0 } });
  assert.equal(turn.items.find(i => i.id === "a")!.status, "inProgress");
  const [history] = mapMessages("thread", [
    { role: "user", content: "Inspect" },
    ...["a", "b"].flatMap(id => [
      { role: "assistant", content: "Checking", tool_calls: [{ id, function: { name: "terminal", arguments: "{}" } }] },
      { role: "tool", tool_call_id: id, content: '{"exit_code":0}' },
    ]),
    { role: "assistant", content: "Done" },
  ]);
  assert.deepEqual(history!.items.filter(i => i.type === "agentMessage").map(i => i.text), ["Checking", "Checking", "Done"]);
});

test("Hermes body preview does not split a streamed segment before Clarify", () => {
  const { turn, event } = harness();
  for (const [index, text] of ["先问第一个问题。", "下一个问题。".repeat(120)].entries()) {
    event("reasoning.delta", { text: `Independent reasoning ${index}` });
    event("message.delta", { text });
    const original = turn.items.at(-1)!.id;
    const before = structuredClone(turn.items);
    event("reasoning.available", { text: text.slice(0, 500) });
    assert.deepEqual(turn.items, before, "body preview cannot close or replace the current stream");
    event("message.interim", { text, already_streamed: true });
    event("tool.start", { tool_id: `clarify-${index}`, name: "clarify" });
    event("tool.complete", { tool_id: `clarify-${index}`, result: "Answer" });
    assert.deepEqual(turn.items.filter(item => item.type === "agentMessage" && item.text === text).map(item => item.id), [original]);
  }
  assert.equal(turn.items.filter(item => item.type === "reasoning").length, 2);
  assert.deepEqual(turn.items.filter(item => item.type === "reasoning").map(item => item.content), [["Independent reasoning 0"], ["Independent reasoning 1"]]);
  event("message.delta", { text: "Final answer" });
  event("reasoning.available", { text: "Final answer" });
  event("message.complete", { text: "Final answer" });
  assert.equal(turn.items.filter(item => item.type === "agentMessage").length, 3);
  assert.equal(turn.items.at(-1)!.phase, "final_answer");
});

test("reasoning available remains a fallback without a current body and real deltas remain boundaries", () => {
  const { turn, event } = harness();
  event("reasoning.available", { text: "Fallback preview" });
  assert.equal(turn.items[0]!.type, "reasoning");
  event("message.delta", { text: "Body" });
  event("reasoning.delta", { text: "Actual new reasoning" });
  assert.equal(turn.items.find(item => item.text === "Body")!.phase, "commentary");
  assert.equal(turn.items.at(-1)!.type, "reasoning");
  event("reasoning.available", { text: "Updated fallback" });
  assert.equal(turn.items.at(-1)!.type, "reasoning", "old body is not a global preview suppression key");
  assert.deepEqual(turn.items.at(-1)!.content, ["Updated fallback"]);
  const before = structuredClone(turn.items);
  event("reasoning.available", { text: "" });
  assert.deepEqual(turn.items, before);
});

test("sealed preview preserves its display slot across interim and restored completion", () => {
  const { turn, event } = harness();
  const slot = () => {
    const snapshot = projectTimeline({ key: createConversationKey("host", "thread"), revision: 1, phase: "live", authoritative: true,
      turns: [{ id: turn.id, status: turn.status === "inProgress" ? "streaming" : "complete", items: turn.items.map(item => ({ id: item.id, type: item.type, payload: item })) }],
    }, createDefaultTimelineProjectorRegistry());
    const frame = snapshot.frames.find(f => f.type === "assistant");
    assert.ok(frame?.type === "assistant");
    return createAssistantTurnPresentationPlan(frame).slots.find(s => s.type === "assistant-content")?.id;
  };
  event("message.delta", { text: "Long final preview" });
  const original = turn.items[0]!.id;
  const originalSlot = slot();
  assert.ok(originalSlot);
  event("message.interim", { text: "Long final preview", already_streamed: true });
  assert.equal(turn.items[0]!.phase, null);
  assert.equal(turn.items[0]!.completed, true);
  assert.equal(slot(), originalSlot);
  const restored = new HermesTurnEventStateMachine("thread", turn);
  restored.project({ type: "message.complete", payload: { text: "Long final preview" } }, 2000);
  assert.equal(turn.items.length, 1);
  assert.equal(turn.items[0]!.id, original);
  assert.equal(turn.items[0]!.phase, "final_answer");
  assert.equal(slot(), originalSlot);
});

test("real tool boundary classifies a sealed preview as commentary", () => {
  const { turn, event } = harness();
  event("message.delta", { text: "Inspecting" });
  event("message.interim", { text: "Inspecting", already_streamed: true });
  event("tool.start", { tool_id: "t", name: "terminal" });
  assert.equal(turn.items[0]!.phase, "commentary");
  event("message.interim", { text: "Inspecting", already_streamed: true });
  assert.equal(turn.items[0]!.phase, "commentary");
  assert.equal(turn.items.filter(i => i.type === "agentMessage").length, 1);
});

function assertToolDisclosure(turn: AppServerTurn) {
  const snapshot = projectTimeline({ key: createConversationKey("host", "thread"), revision: 1, phase: "live", authoritative: true,
    turns: [{ id: turn.id, status: "complete", items: turn.items.map(item => ({ id: item.id, type: item.type, payload: item })) }],
  }, createDefaultTimelineProjectorRegistry());
  const frame = snapshot.frames.find(f => f.type === "assistant");
  assert.ok(frame?.type === "assistant");
  const plan = createAssistantTurnPresentationPlan(frame);
  const activity = plan.slots[0];
  assert.ok(activity?.type === "agent-activity");
  assert.equal(activity.hasFinalAssistantStarted, true);
  const layout = resolveAgentActivityLayout(activity, undefined);
  assert.equal(layout.showToggle, true);
  assert.equal(layout.isCollapsed, true);
  assert.equal(plan.slots[1]?.type, "assistant-content");
}

test("Clarify belongs to the collapsed work region after live and historical final answers", () => {
  const { turn, event } = harness();
  event("tool.start", { tool_id: "clarify", name: "clarify", args: { question: "What next?" } });
  event("tool.complete", { tool_id: "clarify", result: "Done" });
  event("message.delta", { text: "All done." });
  const id = turn.items.at(-1)!.id;
  assert.equal(turn.items.at(-1)!.phase, null, "an ambiguous delta cannot close work");
  event("message.complete", { text: "All done." });
  assert.equal(turn.items.at(-1)!.id, id);
  assert.equal(turn.items.at(-1)!.phase, "final_answer");
  assertToolDisclosure(turn);
  const restored = mapMessages("thread", [
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Let me ask.", tool_calls: [{ id: "clarify", function: { name: "clarify", arguments: '{"question":"What next?"}' } }] },
    { role: "tool", tool_call_id: "clarify", content: "Done" },
    { role: "assistant", content: "All done." },
  ])[0]!;
  assert.equal(restored.items.find(i => i.text === "Let me ask.")?.phase, "commentary");
  assertToolDisclosure(restored);
});

test("transport errors do not promote partial text to final answer", () => {
  const { turn, event } = harness();
  event("message.delta", { text: "Partial" });
  event("error", { message: "Disconnected" });
  assert.equal(turn.items[0]!.phase, null);
});

test("late streamed interim reconciles one Item across a tool boundary", () => {
  const { turn, event } = harness();
  event("message.delta", { text: "Checking the file." });
  const original = turn.items[0]!.id;
  event("tool.start", { tool_id: "tool", name: "terminal", args: { command: "file image.png" } });
  event("message.interim", { text: "Checking the file.", already_streamed: true });
  event("message.interim", { text: "Checking the file.", already_streamed: true });
  assert.deepEqual(turn.items.filter(i => i.type === "agentMessage").map(i => i.id), [original]);
  event("tool.complete", { tool_id: "tool", result: "ok" });
  event("message.delta", { text: "Checking the file." });
  event("message.interim", { text: "Checking the file.", already_streamed: true });
  assert.equal(turn.items.filter(i => i.type === "agentMessage").length, 2, "a new stream retains legitimate equal text");
});

test("unstreamed independent interim is not globally text-deduplicated", () => {
  const { turn, event } = harness();
  event("message.interim", { text: "Again", already_streamed: false });
  event("tool.start", { tool_id: "tool", name: "terminal" });
  event("message.interim", { text: "Again", already_streamed: false });
  assert.equal(turn.items.filter(i => i.type === "agentMessage").length, 2);
  event("message.complete", { text: "Again" });
  assert.equal(turn.items.filter(i => i.type === "agentMessage").length, 2, "new unstreamed interim owns final promotion");
});

test("authoritative streamed corrections keep identity and empty interim is inert", () => {
  const { turn, event } = harness();
  event("message.delta", { text: "Draft wording" });
  const original = turn.items[0]!.id;
  event("message.interim", { text: "", already_streamed: true });
  event("message.delta", { text: " continued" });
  assert.equal(turn.items.length, 1);
  event("message.interim", { text: "Corrected wording", already_streamed: true });
  assert.equal(turn.items.length, 1);
  assert.equal(turn.items[0]!.id, original);
  assert.equal(turn.items[0]!.text, "Corrected wording");
});

test("tool patches retain arguments and publish live metadata; result stays structured and expandable", () => {
  const { turn, event } = harness();
  event("tool.start", { tool_id: "tool", name: "terminal", context: "Inspect image.png", args: { command: "file image.png" } });
  const notifications = event("tool.progress", { tool_id: "tool", message: "Reading image header" });
  assert.equal(notifications.at(-1)?.method, "item/updated");
  assert.equal(turn.items[0]!.tool, "terminal");
  assert.deepEqual(turn.items[0]!.arguments, { command: "file image.png" });
  assert.equal(turn.items[0]!.progressText, "Reading image header");
  event("tool.complete", { tool_id: "tool", result: { output: "PNG image", exit_code: 0 }, summary: "PNG header verified", duration_s: 0.6, inline_diff: "-old\n+new" });
  const item = turn.items[0]!;
  assert.equal(item.toolContext, "Inspect image.png");
  assert.equal(item.durationMs, 600);
  const snapshot = projectTimeline({ key: createConversationKey("host", "thread"), revision: 1, phase: "live", authoritative: true,
    turns: [{ id: "turn", status: "streaming", items: [{ id: item.id, type: item.type, payload: item }] }],
  }, createDefaultTimelineProjectorRegistry());
  const block = snapshot.frames.flatMap(f => f.blocks).find(b => b.type === "command-execution");
  assert.ok(block?.type === "command-execution");
  assert.equal(block.output, "PNG image");
  assert.equal(block.command, "file image.png");
  assert.equal(block.exitCode, 0);
  assert.equal(presentToolActivity(block).canExpand, true);
  assert.equal(item.toolSummary, "PNG header verified");
  assert.equal(item.inlineDiff, "-old\n+new");
});
