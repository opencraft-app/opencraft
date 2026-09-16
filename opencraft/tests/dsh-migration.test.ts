import assert from "node:assert/strict";
import test from "node:test";
import { DshExecutionRecord } from "../apps/local-agent-host/src/dsh-execution-record.js";
import { DshAppServerAdapter } from "../apps/local-agent-host/src/dsh-appserver-adapter.js";
import type { DshClient } from "../apps/local-agent-host/src/dsh-client.js";

test("one live/history ledger preserves reasoning and unique items within a step", () => {
  const record = new DshExecutionRecord("s", "t", "/");
  const events = [
    { type: "turn/start", seq: 1, time: 1000, data: { turn: 1 } },
    { type: "assistant/chunk", seq: 2, time: 1100, data: { step: 1, chunk: { type: "reasoning-delta", index: 0, text: "thinking" } } },
    { type: "assistant/chunk", seq: 3, time: 1200, data: { step: 1, chunk: { type: "text-delta", index: 0, text: "first" } } },
    { type: "tool/call", seq: 4, time: 1300, data: { callId: "c", name: "read", arguments: {} } },
    { type: "assistant/chunk", seq: 5, time: 1400, data: { step: 1, chunk: { type: "text-delta", index: 0, text: "second" } } },
  ];
  for (const event of events) record.project(event);
  const live = record.snapshot();
  assert.deepEqual(live.items.find((i: any) => i.type === "reasoning").content, ["thinking"]);
  const text = live.items.filter((i: any) => i.type === "agentMessage");
  assert.deepEqual(text.map((i: any) => i.text), ["first", "second"]);
  assert.notEqual(text[0].id, text[1].id);
  const replay = new DshExecutionRecord("s", "t", "/");
  for (const event of events) replay.project(event);
  assert.deepEqual(replay.snapshot(), live);
  record.project({ type: "turn/end", seq: 6, time: 9000, data: { reason: { kind: "completed" } } });
  assert.equal(record.snapshot().startedAt, 1);
  assert.equal(record.snapshot().completedAt, 9);
  assert.equal(record.snapshot().durationMs, 8000);
});

test("native image input is normalized at the host boundary, without losing correlation", () => {
  const record = new DshExecutionRecord("s", "t", "/");
  record.project({ type: "user/message", seq: 1, time: 1000, data: {
    source: { kind: "user", rpcId: "client-1" },
    content: [{ type: "text", text: "look" }, { type: "image", mediaType: "image/png", data: "synthetic" }],
  } });
  const item = record.snapshot().items[0];
  assert.equal(item.clientId, "client-1");
  assert.deepEqual(item.content, [{ type: "text", text: "look", text_elements: [] }, { type: "image", url: "data:image/png;base64,synthetic" }]);
});

test("missing terminal evidence never fabricates historical success", async () => {
  const adapter = new DshAppServerAdapter({ call: async () => ({
    events: [{ event: { type: "turn/start", seq: 1, time: 1000, data: { turn: 1 } } }], hasMore: false,
  }) } as unknown as DshClient);
  (adapter as any).summaries.set("s", { sessionId: "s", running: false, blank: false, cwd: "/", updatedAt: 1 });
  const result: any = await adapter.dispatch("thread/read", { threadId: "s", includeTurns: true });
  assert.equal(result.thread.turns[0].status, "failed");
  assert.match(result.thread.turns[0].error.message, /unconfirmed/);
  adapter.close();
});

test("interrupt settles before transport acknowledgement; late terminal cannot reactivate", async () => {
  let acknowledge!: () => void;
  const adapter = new DshAppServerAdapter({ call: () => new Promise<void>(resolve => { acknowledge = resolve; }) } as unknown as DshClient);
  const events: any[] = [];
  adapter.subscribe((method, params) => events.push({ method, params }));
  const feed = (type: string, seq: number, data: unknown) => (adapter as any).onMuxFrame({
    type: "session/event", sessionId: "s", event: { type, seq, data, time: seq * 1000 },
  });
  feed("turn/start", 1, { turn: 1 });
  feed("assistant/chunk", 2, { chunk: { type: "text-delta", index: 0, text: "partial" } });
  const pending = adapter.dispatch("turn/interrupt", { threadId: "s", turnId: "dsh-turn-s-1" });
  assert.equal(events.find(e => e.method === "turn/completed").params.turn.status, "interrupted");
  assert.equal(events.find(e => e.method === "item/completed").params.item.phase, "final_answer");
  assert.equal((adapter as any).livePosition.has("s"), false);
  acknowledge(); await pending;
  const count = events.length;
  feed("turn/end", 3, { turn: 1, reason: { kind: "completed" } });
  assert.equal(events.length, count);
  assert.equal((adapter as any).livePosition.has("s"), false);
  await assert.rejects(adapter.dispatch("turn/steer", { threadId: "s", input: [] }), /no active turn/);
  adapter.close();
});

test("transport recovery rebuilds missed deltas and terminal state from the native ledger", async () => {
  const entries = [
    { event: { type: "turn/start", seq: 1, time: 1000, data: { turn: 1 } } },
    { event: { type: "assistant/chunk", seq: 2, time: 2000, data: { chunk: { type: "reasoning-delta", index: 0, text: "reasoning" } } } },
    { event: { type: "assistant/chunk", seq: 3, time: 3000, data: { chunk: { type: "text-delta", index: 1, text: "recovered" } } } },
    { event: { type: "turn/end", seq: 4, time: 4000, data: { reason: { kind: "completed" } } } },
  ];
  const summary = { sessionId: "s", running: false, blank: false, cwd: "/", updatedAt: 4 };
  const adapter = new DshAppServerAdapter({ call: async (method: string) => method === "session.list"
    ? { items: [summary] } : { events: entries, hasMore: false } } as unknown as DshClient);
  const notifications: any[] = [];
  adapter.subscribe((method, params) => notifications.push({ method, params }));
  (adapter as any).onMuxFrame({ type: "session/event", sessionId: "s", event: entries[0]!.event });
  await (adapter as any).recoverLiveSessions(new AbortController().signal);
  const terminal = notifications.find(e => e.method === "turn/completed").params.turn;
  assert.equal(terminal.itemsView, "full", "history recovery really owns full membership");
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.items.find((item: any) => item.type === "agentMessage").text, "recovered");
  assert.deepEqual(terminal.items.find((item: any) => item.type === "reasoning").content, ["reasoning"]);
  assert.equal((adapter as any).livePosition.has("s"), false);
  adapter.close();
});

test("approval references the imported tool ledger identity and returns one native decision", async () => {
  const responses: any[] = [];
  const adapter = new DshAppServerAdapter({ respond: async (id: string, result: unknown) => {
    responses.push({ id, result }); return { accepted: true };
  } } as unknown as DshClient);
  const notifications: any[] = [], requests: any[] = [];
  adapter.subscribe((method, params) => notifications.push({ method, params }));
  adapter.interactions.subscribe(request => requests.push(request));
  (adapter as any).onMuxFrame({ type: "session/event", sessionId: "s", event: { type: "turn/start", seq: 1, time: 1000, data: { turn: 1 } } });
  (adapter as any).onMuxFrame({ type: "session/event", sessionId: "s", event: { type: "tool/call", seq: 2, time: 2000, data: { callId: "native-call", name: "bash", arguments: { command: "printf fixture" } } } });
  (adapter as any).onMuxFrame({ type: "approval/requested", rpcId: "approval-rpc", sessionId: "s", callId: "native-call", approvalId: "approval-1" });
  await new Promise(resolve => setTimeout(resolve, 0));
  const tool = notifications.find(event => event.method === "item/started").params.item;
  assert.equal(requests[0].params.itemId, tool.id);
  await Promise.all([
    adapter.interactions.respond("approval-rpc", { result: { decision: "accept" } }),
    adapter.interactions.respond("approval-rpc", { result: { decision: "accept" } }),
  ]);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].result.value.outcome, "allowed-once");
  adapter.close();
});
