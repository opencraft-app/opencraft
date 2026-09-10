import assert from "node:assert/strict";
import test from "node:test";
import { DshToolProjection } from "../apps/local-agent-host/src/dsh-tool-projection.js";
import { DshTurnProjection } from "../apps/local-agent-host/src/dsh-turn-projection.js";
import { projectDshGoal } from "../apps/local-agent-host/src/dsh-goal-projection.js";
import { classifyDshCommand } from "../apps/local-agent-host/src/dsh-command-actions.js";
import { DshInteractions, type InteractionRequest } from "../apps/local-agent-host/src/dsh-interactions.js";

test("tool result joins source.callId, retains arguments, unwraps output, and completes once", () => {
  const projection = new DshToolProjection();
  const start = { type: "tool/call", seq: 1, time: 100, data: { callId: "c1", name: "ask_user_question", arguments: '{"question":"Which?"}' } };
  const [item] = projection.project("s", start);
  assert.deepEqual(projection.project("s", start), []);
  const end = { type: "tool/result", seq: 2, time: 150, data: { message: { source: { kind: "tool", callId: "c1" }, content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "answer" }] }] } } };
  const [completed] = projection.project("s", end);
  assert.equal(completed.id, item.id);
  assert.deepEqual(completed.arguments, { question: "Which?" });
  assert.deepEqual(completed.contentItems, [{ type: "inputText", text: "answer" }]);
  assert.equal(completed.durationMs, 50);
  assert.equal(completed.status, "completed");
  assert.deepEqual(projection.project("s", end), []);
  assert.deepEqual(projection.settle(200, false), []);
});
test("interruption settles incomplete tools without inventing success", () => {
  const projection = new DshToolProjection();
  projection.project("s", { type: "tool/call", seq: 1, time: 100, data: { callId: "c1", name: "bash", arguments: {} } });
  assert.equal(projection.settle(200, true)[0].status, "failed");
  assert.deepEqual(projection.settle(201, true), []);
});

test("bash becomes a native command with output and authoritative failure markers", () => {
  for (const [text, status, exitCode] of [["ok", "completed", 0], ["bad\n[exit code: 2]", "failed", 2], ["[timed out after 100ms]", "failed", null]] as const) {
    const projection = new DshTurnProjection("s", "t", "/workspace");
    const start = projection.project({ type: "tool/call", seq: 1, time: 100, data: { callId: "c", name: "bash", arguments: { command: "cat README.md" } } });
    assert.equal(start.started[0].type, "commandExecution");
    assert.equal(start.started[0].commandActions[0].path, "/workspace/README.md");
    const end = projection.project({ type: "tool/result", seq: 2, time: 120, data: { message: { source: { callId: "c" }, content: [{ type: "tool-result", content: [{ type: "text", text }] }] } } });
    assert.equal(end.completed[0].status, status);
    assert.equal(end.completed[0].exitCode, exitCode);
    assert.equal(end.notifications[0].method, "item/commandExecution/outputDelta");
    assert.equal(end.notifications[0].params.delta, text);
    assert.equal(start.started[0].status, "inProgress");
  }
  assert.equal(classifyDshCommand("cat x | bash", "/")[0].type, "unknown");
  assert.equal(classifyDshCommand("cat $(evil)", "/")[0].type, "unknown");
});
test("assistant phase is settled by execution boundaries rather than guessed from text", () => {
  const projection = new DshTurnProjection("s", "t", "/");
  const message = (seq: number) => ({ type: "assistant/message", seq, time: seq, data: { message: { content: [] } } });
  assert.equal(projection.project(message(1), [{ type: "agentMessage", id: "a", text: "Checking" }]).completed.length, 0);
  assert.equal(projection.snapshotPending()[0].phase, null);
  const tool = projection.project({ type: "tool/call", seq: 2, time: 2, data: { callId: "c", name: "read", arguments: {} } });
  assert.equal(tool.completed[0].phase, "commentary");
  assert.equal(tool.started[0].type, "dynamicToolCall");
  projection.project(message(3), [{ type: "agentMessage", id: "b", text: "Done" }]);
  const end = projection.project({ type: "turn/end", seq: 4, time: 4, data: { reason: { kind: "completed" } } });
  assert.equal(end.completed[0].phase, "final_answer");
  assert.equal(end.completed[1].status, "failed");
});
test("TODO observations use one live/history identity each and never impersonate proposals", () => {
  const projection = new DshTurnProjection("s", "t", "/");
  const todo = (seq: number, status: string) => projection.project({ type: "todo/write", seq, time: seq, data: { todos: [{ content: "Test", status }] } });
  const first = todo(1, "in_progress"); const last = todo(2, "completed");
  assert.equal(first.completed[0].plan[0].status, "inProgress");
  assert.notEqual(first.completed[0].id, last.completed[0].id);
  assert.equal(last.completed[0].type, "todo-list");
  assert.equal(last.completed[0].plan[0].step, "Test");
  assert.equal(last.completed[0].plan[0].status, "completed");
  assert.deepEqual(first.notifications, []);
  assert.deepEqual(todo(2, "completed").completed, last.completed);
  assert.equal(projectDshGoal("s", { goal: { objective: "Ship", phase: "blocked" }, createdAt: 1000, updatedAt: 2000 })?.status, "blocked");
  assert.equal(projectDshGoal("s", { operation: "clear" }), null);
  assert.deepEqual(projection.project({ type: "goal/change", seq: 2, time: 2, data: {} }).notifications, []);
});

const question = { type: "question/requested", rpcId: "q1", sessionId: "s", questions: [
  { id: "q", question: "Which?", options: [{ label: "A" }, { label: "B" }] },
] };
test("questions keep wire identity, replay on subscribe, and submit one answer under racing clients", async () => {
  const sent: unknown[] = []; const resolved: unknown[] = [];
  let release!: () => void;
  const bridge = new DshInteractions({ respond: async (id, result) => {
    sent.push({ id, result }); await new Promise<void>(r => { release = r; }); return { accepted: true };
  } }, async () => ({ turnId: "t" }), value => resolved.push(value));
  await bridge.receive(question);
  const requests: InteractionRequest[] = [];
  const unsubscribe = bridge.subscribe(value => requests.push(value));
  await bridge.receive(question);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "item/tool/requestUserInput");
  const first = bridge.respond("q1", { result: { answers: { q: { answers: ["A"] } } } });
  await bridge.respond("q1", { result: { answers: { q: { answers: ["B"] } } } });
  assert.equal(sent.length, 1); release(); await first;
  assert.deepEqual(sent[0], { id: "q1", result: { ok: true, value: { sessionId: "s", answer: { answers: [{ id: "q", selected: ["A"] }] } } } });
  assert.deepEqual(resolved, [{ threadId: "s", requestId: "q1" }]);
  unsubscribe(); bridge.subscribe(value => requests.push(value));
  assert.equal(requests.length, 1);
});
test("resolution during context lookup prevents resurrecting a cancelled question", async () => {
  let release!: () => void; const requests: InteractionRequest[] = [];
  const bridge = new DshInteractions({ respond: async () => ({ accepted: true }) },
    async () => { await new Promise<void>(r => { release = r; }); return { turnId: "t" }; }, () => {});
  bridge.subscribe(value => requests.push(value));
  const pending = bridge.receive(question);
  await bridge.receive({ type: "question/resolved", questionRpcId: "q1", sessionId: "s" });
  release(); await pending;
  assert.equal(requests.length, 0);
});
test("approval never upgrades an unsupported decision to a persistent grant", async () => {
  const sent: unknown[] = [];
  const bridge = new DshInteractions({ respond: async (_id, result) => { sent.push(result); return { accepted: true }; } }, async () => ({ turnId: "t" }), () => {});
  await bridge.receive({ type: "approval/requested", rpcId: "a", approvalId: "audit", sessionId: "s", toolName: "bash", callId: "c" });
  await assert.rejects(bridge.respond("a", { result: { decision: "acceptForSession" } }), /persistent grants/);
  assert.equal(sent.length, 0);
  await bridge.respond("a", { result: { decision: "accept" } });
  assert.deepEqual(sent[0], { ok: true, value: { sessionId: "s", approvalId: "audit", outcome: "allowed-once" } });
});
