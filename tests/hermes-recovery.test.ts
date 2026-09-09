import assert from "node:assert/strict";
import test from "node:test";
import { HermesProjectionRecovery } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/projection-recovery";
import { appendLiveSessionProjection } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/live-session-projection";
import { HermesTurnEventStateMachine } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/turn-event-state-machine";
import { HermesAppServerAdapter } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/adapter";
import type { AppServerTurn, HermesSessionPayload } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/types";
import type { HermesRpcClient } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/rpc-transport";

const snapshot: HermesSessionPayload = { session_id: "live", message_count: 1, messages: [], running: true,
  turn_started_at: 10, inflight: { user: "hello", assistant: "Checking", streaming: true } };
const userTurn = (): AppServerTurn => ({ id: "turn", items: [{ type: "userMessage", id: "user", content: [{ type: "text", text: "hello" }] }],
  status: "completed", itemsView: "full", error: null, startedAt: 10, completedAt: null, durationMs: null });

test("backend inflight restores missing text and the continuation targets that Item", () => {
  const turns = [userTurn()];
  const restored = appendLiveSessionProjection(turns, snapshot)!;
  assert.equal(turns.length, 1);
  assert.equal(restored.items.filter(item => item.type === "userMessage").length, 1);
  const id = restored.items.at(-1)!.id;
  const projection = new HermesTurnEventStateMachine("stored", restored);
  projection.project({ type: "message.delta", payload: { text: " the file" } }, 11_000);
  assert.equal(restored.items.at(-1)!.id, id);
  assert.equal(restored.items.at(-1)!.text, "Checking the file");
  assert.equal(restored.items.at(-1)!.phase, null);
  projection.project({ type: "message.complete", payload: { text: "Checking the file" } }, 12_000);
  assert.equal(restored.items.at(-1)!.id, id);
  assert.equal(restored.items.at(-1)!.phase, "final_answer");
});

test("quiet inflight remains an open segment when generation is still running", () => {
  const restored = appendLiveSessionProjection([userTurn()], { ...snapshot,
    inflight: { user: "hello", assistant: "Checking", streaming: false } })!;
  const id = restored.items.at(-1)!.id;
  assert.equal(restored.items.at(-1)!.completed, false);
  const machine = new HermesTurnEventStateMachine("stored", restored);
  machine.project({ type: "message.delta", payload: { text: " more" } }, 12000);
  assert.equal(restored.items.at(-1)!.id, id);
  assert.equal(restored.items.at(-1)!.text, "Checking more");
});

test("only a successfully settled inflight snapshot grants final-answer authority", () => {
  for (const state of [
    { running: undefined, streaming: false, error: undefined, expected: null },
    { running: true, streaming: true, error: undefined, expected: null },
    { running: true, streaming: false, error: undefined, expected: null },
    { running: false, streaming: false, error: "failed", expected: null },
    { running: false, streaming: false, error: undefined, expected: "final_answer" },
  ]) {
    const turn = appendLiveSessionProjection([userTurn()], { ...snapshot, running: state.running,
      inflight: { user: "hello", assistant: "Reply", streaming: state.streaming, error: state.error } })!;
    assert.equal(turn.items.at(-1)!.phase, state.expected);
  }
  const blocked = appendLiveSessionProjection([userTurn()], { ...snapshot, running: false,
    pending_clarify: { request_id: "clarify", question: "Continue?" },
    inflight: { user: "hello", assistant: "Waiting", streaming: false } })!;
  assert.equal(blocked.items.at(-1)!.phase, null);
  assert.equal(blocked.status, "inProgress");
});

test("inflight respects completed history, correction offsets, failure and structural tails", () => {
  const previous = userTurn();
  previous.items.push({ id: "done", type: "agentMessage", text: "Done", phase: null });
  const turns = [previous];
  const live = appendLiveSessionProjection(turns, { ...snapshot, inflight: { ...snapshot.inflight, assistant: "abcdef", corrections: ["redirect"], correction_offsets: [3] } })!;
  assert.equal(turns.length, 2, "equal prompt after completed history is a new turn");
  assert.deepEqual(live.items.map(item => item.type === "userMessage" ? (item.content as {text: string}[])[0].text : item.text), ["hello", "abc", "redirect", "def"]);
  const structural = userTurn();
  structural.items.push({ id: "tool", type: "dynamicToolCall", tool: "terminal", status: "inProgress" });
  appendLiveSessionProjection([structural], snapshot);
  assert.equal(structural.items.filter(item => item.type === "agentMessage").length, 0);
  appendLiveSessionProjection([structural], { ...snapshot, running: false, inflight: { ...snapshot.inflight, error: "Provider failed", streaming: false } });
  assert.equal(structural.status, "failed");
  assert.equal(structural.error?.message, "Provider failed");
});

test("warm reconnect keeps the exact segment owner paired with its watermark", async () => {
  const recovery = new HermesProjectionRecovery();
  const turn = userTurn();
  const machine = new HermesTurnEventStateMachine("stored", turn);
  machine.project({ type: "message.delta", payload: { text: "Checking" } }, 11_000);
  machine.project({ type: "tool.start", payload: { tool_id: "tool", name: "terminal" } }, 12_000);
  const id = turn.items.find(item => item.type === "agentMessage")!.id;
  recovery.owners.set("live", machine);
  recovery.lastSeenSeq.set("live", 2);
  recovery.lastSeenSeq.set("unowned", 99);
  recovery.prepareReconnect();
  assert.equal(recovery.lastSeenSeq.has("unowned"), false);
  let listener: ((event: Record<string, unknown>) => void) | undefined;
  const gateway: HermesRpcClient = {
    async call<T>(method: string) {
      if (method === "session.resume") return snapshot as T;
      if (method === "session.list") return { sessions: [{ id: "stored", title: "Chat", preview: "", started_at: 10, message_count: 1 }] } as T;
      if (method === "profiles.list") return { profiles: [{ name: "default", last_session: { id: "stored" } }] } as T;
      throw new Error(method);
    },
    onEvent(next) { listener = next; return () => { listener = undefined; }; },
    async catchUpSession() { listener?.({ session_id: "live", type: "message.interim", payload: { text: "Checking", already_streamed: true } }); return { complete: true }; },
    async snapshotSession() { throw new Error("warm recovery must not overwrite the retained owner"); },
  };
  const old = new HermesAppServerAdapter(gateway, "/", undefined, undefined, recovery);
  old.dispose();
  const adapter = new HermesAppServerAdapter(gateway, "/", undefined, undefined, recovery);
  try {
    await adapter.loadThread("stored", false);
    const turns = [userTurn()];
    await adapter.activateProjection("stored", turns);
    assert.equal(turns[0], turn);
    assert.deepEqual(turn.items.filter(item => item.type === "agentMessage").map(item => item.id), [id]);
  } finally { adapter.dispose(); }
  recovery.reset();
  assert.equal(recovery.owners.size, 0);
  assert.equal(recovery.lastSeenSeq.size, 0);
});
