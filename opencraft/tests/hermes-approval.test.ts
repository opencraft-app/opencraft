import assert from "node:assert/strict";
import test from "node:test";
import { HermesAppServerAdapter, type HermesAppServerInteractionRequest } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/adapter";
import type { HermesRpcClient } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/rpc-transport";
import type { HermesPendingApproval, HermesSessionPayload, AppServerTurn } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/types";
import { appendLiveSessionProjection } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/live-session-projection";
import { createInteractionResponse } from "@opencraft/workbench-runtime";
import { AppServerInteractionLedger } from "@opencraft/composer-appserver";
import { AppServerInteractionBroker } from "@opencraft/composer-appserver";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { MemoryTransport, type InMemoryAppServerPeer } from "@opencraft/appserver-transport-memory";
import type { PendingInteraction } from "@opencraft/chat-runtime";

function harness() {
  let receive: (event: Record<string, unknown>) => void = () => {};
  let answer: () => Promise<unknown> = async () => ({ resolved: true });
  let snapshot: () => Promise<HermesSessionPayload> = async () => ({ session_id: "live", message_count: 0, messages: [], running: true });
  const requests: HermesAppServerInteractionRequest[] = [];
  const calls: Array<{ method: string; params: any }> = [];
  const notifications: Array<{ method: string; params: any }> = [];
  const rpc: HermesRpcClient = {
    onEvent(listener) { receive = listener; return () => {}; },
    async call<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      if (method === "approval.respond") return await answer() as T;
      if (method === "session.activate" || method === "session.resume") return await snapshot() as T;
      if (method === "session.list") return { sessions: [{ id: "stored", title: "Approval", preview: "", started_at: 1, message_count: 0, source: "desktop" }] } as T;
      if (method === "session.create") return { session_id: "live", stored_session_id: "stored", messages: [], message_count: 0, running: false } as T;
      if (method === "prompt.submit") return { status: "streaming" } as T;
      throw new Error(`Unexpected method ${method}`);
    },
    snapshotSession: () => snapshot(),
  };
  const adapter = new HermesAppServerAdapter(rpc, "/workspace", undefined, undefined, undefined, undefined, undefined, "default");
  adapter.subscribeServerRequest(request => requests.push(request));
  adapter.subscribeNotification((method, params) => notifications.push({ method, params }));
  return { adapter, requests, calls, notifications,
    setAnswer(fn: typeof answer) { answer = fn; },
    setSnapshot(fn: typeof snapshot) { snapshot = fn; },
    event(type: string, payload: Record<string, unknown>, live = "live") { receive({ type, session_id: live, payload }); },
    async start() { await adapter.startThread(); return (await adapter.startTurn("stored", [{ type: "text", text: "test" }])).turn; },
    pending() { const result: HermesAppServerInteractionRequest[] = []; const stop = adapter.subscribeServerRequest(r => result.push(r)); stop(); return result; },
  };
}

const approval = (id = "a"): HermesPendingApproval => ({ request_id: id, command: "echo safe", description: "Allow test action?", choices: ["once", "session", "always", "deny"] });

test("approval is blocking, replayable, and display/dispose never answer it", async () => {
  const h = harness(); await h.start();
  h.event("approval.request", approval()); h.event("session.info", { running: false });
  assert.equal(h.requests[0]?.method, "item/commandExecution/requestApproval");
  assert.equal(h.notifications.some(n => n.method === "turn/completed"), false);
  assert.equal(h.pending().length, 1);
  assert.equal(h.calls.some(c => c.method === "approval.respond"), false);
  h.adapter.dispose();
  assert.equal(h.calls.some(c => c.method === "approval.respond"), false);
});

for (const [action, choice] of [["approve-once", "once"], ["approve-session", "session"], ["approve-always", "always"], ["decline", "deny"], ["cancel", "deny"]] as const) {
  test(`explicit ${action} reaches native ${choice} on the owning session`, async t => {
    const h = harness(); t.after(() => h.adapter.dispose()); await h.start();
    h.event("approval.request", approval());
    const request = h.requests[0]!;
    assert.equal(request.method, "item/commandExecution/requestApproval");
    if (request.method !== "item/commandExecution/requestApproval") return;
    const interaction = { ...request, requestId: request.id, turnId: request.params.turnId, itemId: request.params.itemId, receivedAtMs: 1 };
    const response = createInteractionResponse(interaction, { type: action });
    assert.equal(response.type, "command-approval");
    if (response.type !== "command-approval") return;
    await h.adapter.respondServerRequest(request.id, { decision: response.decision, ...(response._meta ? { _meta: response._meta } : {}) });
    assert.deepEqual(h.calls.find(c => c.method === "approval.respond")?.params, { session_id: "live", request_id: "a", choice });
    assert.equal(h.pending().length, 0);
  });
}

test("disallowed scope, empty response, and policy amendments fail closed", async t => {
  const h = harness(); t.after(() => h.adapter.dispose()); await h.start();
  h.event("approval.request", { ...approval(), smart_denied: true });
  const request = h.requests[0]!;
  if (request.method !== "item/commandExecution/requestApproval") throw Error("Wrong request");
  assert.deepEqual(request.params.approvalScopes, ["once", "deny"]);
  for (const result of [{}, { decision: "acceptForSession" }, { decision: "accept", _meta: { persist: "always" } }, { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["echo"] } } }]) {
    await assert.rejects(h.adapter.respondServerRequest(request.id, result), /not offered/);
  }
  assert.equal(h.calls.some(c => c.method === "approval.respond"), false);
  assert.equal(h.pending().length, 1);
});

test("native RPC error and unresolved receipt retain the blocking owner", async t => {
  const h = harness(); t.after(() => h.adapter.dispose()); await h.start(); h.event("approval.request", approval());
  for (const answer of [async () => { throw Error("disconnected"); }, async () => ({ resolved: false })]) {
    h.setAnswer(answer);
    await assert.rejects(h.adapter.respondServerRequest(h.requests[0]!.id, { decision: "accept" }));
    h.event("session.info", { running: false });
    assert.equal(h.pending().length, 1);
    assert.equal(h.notifications.some(n => n.method === "turn/completed"), false);
  }
});

test("cold resume restores the pending approval and the unfinished physical turn", async t => {
  const h = harness(); t.after(() => h.adapter.dispose());
  h.setSnapshot(async () => ({ session_id: "live", stored_session_id: "stored", message_count: 0, messages: [], running: false,
    pending_approval: approval(), inflight: { user: "test", assistant: "Waiting", streaming: false } }));
  const thread = await h.adapter.loadThread("stored", false);
  await h.adapter.activateProjection("stored", thread.turns);
  assert.equal(h.pending().length, 1);
  assert.equal(thread.turns.at(-1)?.status, "inProgress");
  assert.equal(thread.turns.at(-1)?.items.find(i => i.type === "agentMessage")?.phase, null);
});

test("accepted response refreshes the next prompt and late old receipt cannot clear new approval", async t => {
  const h = harness(); t.after(() => h.adapter.dispose()); await h.start(); h.event("approval.request", approval("old"));
  let release!: () => void;
  h.setAnswer(() => new Promise(resolve => { release = () => resolve({ resolved: true }); }));
  const answering = h.adapter.respondServerRequest(h.requests[0]!.id, { decision: "accept" });
  await assert.rejects(h.adapter.respondServerRequest(h.requests[0]!.id, { decision: "accept" }), /already being sent/);
  h.event("approval.request", approval("new"));
  h.setSnapshot(async () => ({ session_id: "live", message_count: 0, messages: [], running: false, pending_approval: approval("new") }));
  release(); await answering;
  assert.equal(h.pending().length, 1); assert.equal(h.pending()[0]!.id, h.requests[1]!.id);
  assert.equal(await h.adapter.respondServerRequest(h.requests[0]!.id, { decision: "accept" }), false);
});

test("reconnecting onto a reminted live session keeps prompt identity but revokes old routing", async t => {
  const first = harness(); await first.start(); first.event("approval.request", approval());
  const id = first.requests[0]!.id; first.adapter.dispose();
  const next = harness(); t.after(() => next.adapter.dispose());
  next.setSnapshot(async () => ({ session_id: "reminted", stored_session_id: "stored", message_count: 0, messages: [], running: false, pending_approval: approval() }));
  const thread = await next.adapter.loadThread("stored", false);
  await next.adapter.activateProjection("stored", thread.turns);
  assert.equal(next.pending()[0]?.id, id);
  next.event("message.complete", {}, "live");
  assert.equal(next.pending().length, 1);
  assert.equal(await first.adapter.respondServerRequest(id, { decision: "accept" }), false);
  next.setSnapshot(async () => ({ session_id: "reminted", message_count: 0, messages: [], running: true }));
  await next.adapter.respondServerRequest(id, { decision: "accept" });
  assert.deepEqual(next.calls.find(c => c.method === "approval.respond")?.params, { session_id: "reminted", request_id: "a", choice: "once" });
});

test("stale refresh and another session's frames do not remove current approval", async t => {
  const h = harness(); t.after(() => h.adapter.dispose()); await h.start(); h.event("approval.request", approval("old"));
  let release!: () => void;
  h.setSnapshot(() => new Promise(resolve => { release = () => resolve({ session_id: "live", message_count: 0, messages: [], running: false }); }));
  h.event("tool.complete", { tool_id: "tool" });
  h.event("approval.request", approval("new"));
  h.event("message.complete", {}, "other-live");
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.pending().length, 2);
});

test("native tool completion reconciles expiry without manufacturing a decision", async t => {
  const h = harness(); t.after(() => h.adapter.dispose()); await h.start(); h.event("approval.request", approval());
  h.setSnapshot(async () => ({ session_id: "live", message_count: 0, messages: [], running: true, pending_approval: null }));
  h.event("tool.complete", { tool_id: "tool" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.pending().length, 0); assert.equal(h.calls.some(c => c.method === "approval.respond"), false);
});

test("a snapshot started before acceptance cannot resurrect the accepted prompt", async t => {
  const h = harness(); t.after(() => h.adapter.dispose()); await h.start(); h.event("approval.request", approval());
  let release!: () => void;
  h.setSnapshot(() => new Promise(resolve => { release = () => resolve({ session_id: "live", message_count: 0, messages: [], running: true, pending_approval: approval() }); }));
  h.event("tool.complete", { tool_id: "tool" });
  h.setSnapshot(async () => ({ session_id: "live", message_count: 0, messages: [], running: true }));
  await h.adapter.respondServerRequest(h.requests[0]!.id, { decision: "accept" });
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.pending().length, 0);
});

test("different native approvals of one turn cannot recall another approval's grant", async t => {
  const h = harness(); t.after(() => h.adapter.dispose()); await h.start();
  h.event("approval.request", approval("first")); h.event("approval.request", approval("second"));
  const pending = (index: number) => {
    const request = h.requests[index]!;
    if (request.method !== "item/commandExecution/requestApproval") throw Error("Wrong request");
    return { ...request, requestId: request.id, threadId: request.params.threadId, turnId: request.params.turnId, itemId: request.params.itemId, receivedAtMs: 1 };
  };
  const ledger = new AppServerInteractionLedger();
  ledger.remember(pending(0), { type: "command-approval", requestId: pending(0).requestId, decision: "accept" });
  assert.equal(ledger.recall(pending(1)), null);
});

test("approval prevents a quiet inflight snapshot becoming a final answer", () => {
  const turns: AppServerTurn[] = [];
  const turn = appendLiveSessionProjection(turns, { session_id: "live", message_count: 0, messages: [], running: false,
    pending_approval: approval(), inflight: { user: "test", assistant: "Waiting", streaming: false } });
  assert.equal(turn?.status, "inProgress"); assert.equal(turn?.items.at(-1)?.phase, null);
});

test("real client and broker deliver the persistent scope to Hermes, not a Codex policy", async t => {
  const h = harness(); t.after(() => h.adapter.dispose());
  let peer!: InMemoryAppServerPeer;
  const transport = new MemoryTransport({
    connected(next) { peer = next; },
    async receive(frame, connected) {
      const message = JSON.parse(frame);
      if (message.method === "initialize") connected.send(JSON.stringify({ id: message.id, result: {} }));
      else if (message.method === "initialized") return;
      else if (Object.hasOwn(message, "result")) await h.adapter.respondServerRequest(String(message.id), message.result);
      else if (Object.hasOwn(message, "error")) h.adapter.rejectServerRequest(String(message.id), message.error);
      else throw Error("Unexpected frame");
    },
  });
  const client = new JsonRpcAppServerClient({ hostId: "test", transport });
  const pending = new Map<string, PendingInteraction>();
  const broker = new AppServerInteractionBroker({ hostId: "test", client, store: {
    upsertPendingInteraction(value) { pending.set(value.requestId, value); },
    removePendingInteraction(_threadId, id) { pending.delete(id); },
  } });
  t.after(async () => { broker.dispose(); await client.close(); });
  await client.connect({ clientInfo: { name: "approval-test", version: "1" } });
  h.adapter.subscribeServerRequest(request => peer.send(JSON.stringify({ jsonrpc: "2.0", ...request })));
  h.adapter.subscribeNotification((method, params) => peer.send(JSON.stringify({ method, params })));
  await h.start(); h.event("approval.request", approval());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.size, 1); assert.equal(h.calls.some(c => c.method === "approval.respond"), false);
  const interaction = [...pending.values()][0]!;
  await broker.respond({ hostId: "test", threadId: "stored" }, createInteractionResponse(interaction, { type: "approve-always" }));
  assert.equal(pending.size, 0);
  assert.equal(h.calls.find(c => c.method === "approval.respond")?.params.choice, "always");
});
