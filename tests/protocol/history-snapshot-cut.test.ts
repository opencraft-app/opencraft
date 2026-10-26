import assert from "node:assert/strict";
import test from "node:test";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { createCordisThreadSessionRuntime } from "@opencraft/appserver-session";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import { encodeJsonRpcMessage, isJsonRpcRequest, parseJsonRpcMessage } from "@opencraft/appserver-protocol";

const canonicalItem = { id: "item", type: "agentMessage", text: "canonical answer", status: "completed", completed: true };
const canonicalTurn = { id: "turn", status: "completed", itemsView: "full", items: [canonicalItem], error: null };
const overlaps = [
  { method: "item/updated", params: { threadId: "a", turnId: "turn", item: { ...canonicalItem, text: "older partial", status: "inProgress", completed: false } } },
  { method: "item/started", params: { threadId: "a", turnId: "turn", item: { ...canonicalItem, text: "", status: "inProgress", completed: false } } },
  { method: "turn/started", params: { threadId: "a", turn: { ...canonicalTurn, status: "inProgress", items: [] } } },
  { method: "thread/status/changed", params: { threadId: "a", status: { type: "active", activeFlags: [] } } },
];
for (const overlap of overlaps) test(`canonical history cannot regress after buffered ${overlap.method}`, async () => {
  let reads = 0, delivered = 0, observed = 0, responses = 0;
  const transport = new MemoryTransport({ receive(frame, peer) {
    const request = parseJsonRpcMessage(frame); if (!isJsonRpcRequest(request)) { if ("id" in request && request.id === "interaction") responses++; return; }
    const send = (result: unknown) => peer.send(encodeJsonRpcMessage({ id: request.id, result }));
    if (request.method === "initialize") { send({ codexHome: "/fixture", platformFamily: "unix", platformOs: "linux", userAgent: "snapshot-cut",
      capabilities: { extensions: { "opencraft/read-history": { version: 1 } } } }); return; }
    assert.equal(request.method, "thread/read"); reads++;
    if (reads === 1) {
      peer.send(encodeJsonRpcMessage(overlap));
      peer.send(encodeJsonRpcMessage({ method: "thread/settings/updated", params: { threadId: "a", threadSettings: { model: "live-model" } } }));
      peer.send(encodeJsonRpcMessage({ method: "fixture/observation", params: { threadId: "a" } }));
      peer.send(encodeJsonRpcMessage({ id: "interaction", method: "fixture/interaction", params: { threadId: "a" } }));
    }
    assert.equal(delivered, 0, "a reread cannot prematurely release a buffered request");
    send({ thread: { id: "a", sessionId: "a", cwd: "/workspace", model: "disk-model", historyMode: "message-window", turns: [], status: { type: "idle" } },
      initialTurnsPage: { data: [canonicalTurn], nextCursor: null } });
  } });
  const client = new JsonRpcAppServerClient({ hostId: "snapshot-cut", transport });
  await client.connect({ clientInfo: { name: "snapshot-cut", version: "1" } });
  const session = await createCordisThreadSessionRuntime({ client, historyModeHint: "message-window" });
  client.handleServerRequest("fixture/interaction", () => { delivered++; return { ok: true }; });
  client.subscribeNotification(notification => { if (notification.method === "fixture/observation") observed++; });
  try {
    const view = await session.resume.read("a");
    assert.equal(view.turns[0]?.items?.[0]?.text, "canonical answer");
    assert.equal(view.turns[0]?.items?.[0]?.completed, true);
    assert.equal(view.turns[0]?.status, "completed");
    assert.deepEqual(view.thread?.status, { type: "idle" });
    assert.equal(reads, 2, "unsequenced snapshot notifications require a quiet canonical cut");
    assert.equal(view.execution.model, "live-model");
    for (let i = 0; i < 5 && responses === 0; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(delivered, 1); assert.equal(responses, 1); assert.equal(observed, 1);
  } finally { await session.dispose(); await client.close(); }
});
