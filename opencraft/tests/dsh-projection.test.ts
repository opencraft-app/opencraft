import assert from "node:assert/strict";
import test from "node:test";
import { DshTurnProjection } from "../apps/local-agent-host/src/dsh-turn-projection.js";
import { projectDshGoal } from "../apps/local-agent-host/src/dsh-goal-projection.js";
import { classifyDshCommand } from "../apps/local-agent-host/src/dsh-command-actions.js";
import { DshInteractions, type InteractionRequest } from "../apps/local-agent-host/src/dsh-interactions.js";
import { DshAppServerAdapter } from "../apps/local-agent-host/src/dsh-appserver-adapter.js";
import { DshClient } from "../apps/local-agent-host/src/dsh-client.js";
import { mergeTurns } from "../packages/appserver-session/src/merge-turns.js";

test("HyperNode terminal summaries preserve live Items and settle before completion", async () => {
  for (const kind of ["completed", "aborted", "interrupted", "error", "blocked", "max-tokens", "unknown"]) {
    const adapter = new DshAppServerAdapter({} as DshClient);
    const events: Array<{ method: string; params: any }> = [];
    adapter.subscribe((method, params) => events.push({ method, params }));
    const accept = (type: string, data: any, seq: number) =>
      (adapter as any).onMuxFrame({ type: "session/event", sessionId: "s", event: { type, data, seq, time: seq * 1000 } });
    accept("turn/start", { turn: 1 }, 1);
    accept("user/message", { id: "u", source: { kind: "user" }, content: [{ type: "text", text: "synthetic" }] }, 2);
    accept("assistant/chunk", { chunk: { type: "reasoning-delta", index: 0, text: "thinking" } }, 3);
    accept("assistant/chunk", { chunk: { type: "text-delta", index: 1, text: "synthetic reply" } }, 4);
    accept("tool/call", { callId: "c", name: "read", arguments: {} }, 5);
    accept("assistant/chunk", { chunk: { type: "text-delta", index: 2, text: "last reply" } }, 6);
    accept("turn/end", { reason: { kind } }, 7);
    await new Promise(resolve => setTimeout(resolve, 400));
    const count = events.length;
    accept("turn/end", { reason: { kind } }, 8);
    assert.equal(events.length, count, "terminal convergence is idempotent");
    const terminalIndex = events.findIndex(e => e.method === "turn/completed");
    const terminal = events[terminalIndex]!.params.turn;
    assert.equal(terminal.itemsView, "summary");
    assert.equal(terminal.status, kind === "completed" ? "completed" : ["aborted", "interrupted"].includes(kind) ? "interrupted" : "failed");
    const completed = events.filter(e => e.method === "item/completed");
    assert.ok(completed.some(e => e.params.item.type === "reasoning"));
    assert.ok(completed.some(e => e.params.item.type === "dynamicToolCall" && e.params.item.status === "failed"));
    const lastReply = completed.find(e => e.params.item.text === "last reply")!;
    assert.equal(lastReply.params.item.phase, ["completed", "aborted", "interrupted"].includes(kind) ? "final_answer" : "commentary");
    assert.ok(completed.every(e => events.indexOf(e) < terminalIndex));
    if (terminal.status === "failed") assert.ok(events.findIndex(e => e.method === "error") < terminalIndex);
    const live = { ...terminal, items: completed.map(e => e.params.item) };
    const merged = mergeTurns([live], [terminal], { itemsMode: terminal.itemsView === "full" ? "replace" : "merge" });
    assert.equal(merged[0]!.items.length, live.items.length);
    assert.ok(merged[0]!.items.some(i => i.type === "userMessage"));
    adapter.close();
  }
});

test("completion without assistant output fails rather than inventing success", () => {
  const projection = new DshTurnProjection("s", "dsh-turn-s-1", "/");
  projection.project({ type: "turn/end", seq: 1, time: 1, data: { reason: { kind: "completed" } } });
  assert.equal(projection.terminalOutcome?.status, "failed");
  assert.match(projection.terminalOutcome!.error!.message, /without an assistant message/);
});

test("commentary and failed tool activity may complete without fabricating a final answer", () => {
  const projection = new DshTurnProjection("s", "dsh-turn-s-activity", "/");
  projection.project({
    type: "assistant/message",
    seq: 1,
    time: 1,
    data: {
      message: {
        content: [
          { type: "text", text: "Let me try the browser tool." },
          { type: "tool-call", id: "call-browser", name: "browser", arguments: "{}" },
        ],
      },
    },
  });
  projection.project({
    type: "tool/call",
    seq: 2,
    time: 2,
    data: { callId: "call-browser", name: "browser", arguments: "{}" },
  });
  projection.project({
    type: "tool/result",
    seq: 3,
    time: 3,
    data: {
      message: {
        source: { kind: "tool", callId: "call-browser" },
        content: [{
          type: "tool-result",
          toolCallId: "call-browser",
          content: [{ type: "text", text: 'unknown tool "browser"' }],
          isError: true,
        }],
      },
    },
  });
  projection.project({ type: "turn/end", seq: 4, time: 4, data: { reason: { kind: "completed" } } });

  const snapshot = projection.execution.snapshot();
  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.error, null);
  assert.ok(snapshot.items.some((item: any) =>
    item.type === "agentMessage"
      && item.phase === "commentary"
      && item.text === "Let me try the browser tool."));
  assert.ok(snapshot.items.some((item: any) =>
    item.type === "dynamicToolCall"
      && item.tool === "browser"
      && item.status === "failed"));
  assert.equal(snapshot.items.some((item: any) =>
    item.type === "agentMessage" && item.phase === "final_answer"), false);
});

test("ported HyperNode reconciliation replaces mismatched final text without appending it twice", () => {
  const projection = new DshTurnProjection("s", "dsh-turn-s-1", "/");
  const chunk = projection.project({ type: "assistant/chunk", seq: 1, time: 1, data: { chunk: { type: "text-delta", index: 0, text: "draft" } } });
  const id = chunk.started[0]!.id;
  const message = projection.project({ type: "assistant/message", seq: 2, time: 2, data: { message: { content: [{ type: "text", text: "corrected answer" }] } } });
  assert.equal(message.notifications.length, 0, "mismatch is replaced by completion, not appended");
  assert.equal(message.completed.length, 0, "assistant/message is not a terminal commit");
  const end = projection.project({ type: "turn/end", seq: 3, time: 3, data: { reason: { kind: "completed" } } });
  assert.equal(end.completed[0]!.id, id);
  assert.equal(end.completed[0]!.text, "corrected answer");
  assert.equal(end.completed[0]!.phase, "final_answer");
});

test("tool result joins source.callId, retains arguments, unwraps output, and completes once", () => {
  const projection = new DshTurnProjection("s", "t", "/");
  const start = { type: "tool/call", seq: 1, time: 100, data: { callId: "c1", name: "ask_user_question", arguments: '{"question":"Which?"}' } };
  const [item] = projection.project(start).started;
  assert.deepEqual(projection.project(start).events, []);
  const end = { type: "tool/result", seq: 2, time: 150, data: { message: { source: { kind: "tool", callId: "c1" }, content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "answer" }] }] } } };
  const [completed] = projection.project(end).completed;
  assert.equal(completed.id, item.id);
  assert.deepEqual(completed.arguments, { question: "Which?" });
  assert.deepEqual(completed.contentItems, [{ type: "inputText", text: "answer" }]);
  assert.equal(completed.durationMs, 50);
  assert.equal(completed.status, "completed");
  assert.deepEqual(projection.project(end).events, []);
});
test("interruption settles incomplete tools without inventing success", () => {
  const projection = new DshTurnProjection("s", "t", "/");
  projection.project({ type: "tool/call", seq: 1, time: 100, data: { callId: "c1", name: "bash", arguments: {} } });
  assert.equal(projection.execution.interrupt(200).find(e => e.method === "item/completed")!.params.item.status, "failed");
  assert.deepEqual(projection.execution.interrupt(201), []);
});

test("bash becomes a native command with output and authoritative failure markers", () => {
  for (const [text, status, exitCode] of [["ok", "completed", 0], ["bad\n[exit code: 2]", "failed", 2]] as const) {
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
  const message = (seq: number) => ({ type: "assistant/message", seq, time: seq, data: { message: { content: [{ type: "text", text: seq === 1 ? "Checking" : "Done" }] } } });
  assert.equal(projection.project(message(1)).completed.length, 0);
  assert.equal(projection.execution.snapshot().items[0].phase, null);
  const tool = projection.project({ type: "tool/call", seq: 2, time: 2, data: { callId: "c", name: "read", arguments: {} } });
  assert.equal(tool.completed[0].phase, "commentary");
  assert.equal(tool.started[0].type, "dynamicToolCall");
  projection.project(message(3));
  const end = projection.project({ type: "turn/end", seq: 4, time: 4, data: { reason: { kind: "completed" } } });
  assert.equal(end.completed[0].phase, "final_answer");
  assert.equal(end.completed[1].status, "failed");
});
test("TODO observations use one live/history identity each and never impersonate proposals", () => {
  const projection = new DshTurnProjection("s", "t", "/");
  const todo = (seq: number, status: string) => projection.project({ type: "todo/write", seq, time: seq, data: { todos: [{ content: "Test", status }] } });
  const first = todo(1, "in_progress"); const last = todo(2, "completed");
  assert.equal(first.notifications[0].params.plan[0].status, "inProgress");
  assert.equal(last.notifications[0].params.plan[0].step, "Test");
  assert.equal(last.notifications[0].params.plan[0].status, "completed");
  assert.equal(first.notifications[0].method, "turn/plan/updated");
  assert.deepEqual(todo(2, "completed").events, []);
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
