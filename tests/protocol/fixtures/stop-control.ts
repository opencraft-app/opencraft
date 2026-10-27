import assert from "node:assert/strict";
import { MemoryTransport, type InMemoryAppServerPeer } from "@opencraft/appserver-transport-memory";
import { encodeJsonRpcMessage, isJsonRpcRequest, parseJsonRpcMessage } from "@opencraft/appserver-protocol";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";

export const drainStopFixture = async () => { for (let i = 0; i < 12; i++) await new Promise<void>(r => setImmediate(r)); };
export function stopControlTransportFixture() {
  let peer!: InMemoryAppServerPeer, holdRead = false, holdReceipt = false, holdStopReply = false, active = "known-turn";
  const reads: (() => void)[] = [], receipts: (() => void)[] = [], stops: string[] = [], responses: unknown[] = [], methods: string[] = [];
  const stopRequests: { threadId: string; turnId: string }[] = [];
  let initializations = 0, readCount = 0;
  const transport = new MemoryTransport({ receive(frame, current) {
    peer = current; const request = parseJsonRpcMessage(frame);
    if (!isJsonRpcRequest(request)) { if ("id" in request) responses.push(request); return; }
    methods.push(request.method);
    const reply = (result: unknown) => current.send(encodeJsonRpcMessage({ id: request.id, result }));
    if (request.method === "initialize") { initializations++; reply({ codexHome: "/fixture", platformFamily: "unix", platformOs: "linux", userAgent: "stop-recovery", capabilities: { extensions: { "opencraft/read-history": { version: 1 } } } }); }
    else if (request.method === "thread/read") {
      readCount++;
      const result = { thread: { id: "a", sessionId: "a", cwd: "/fixture", path: "/fixture/a", historyMode: "paginated", status: { type: "active", activeFlags: [] }, turns: [] },
        initialTurnsPage: { data: [{ id: active, status: "inProgress", itemsView: "full", items: [], error: null }], nextCursor: null } };
      if (holdRead) reads.push(() => reply(result)); else reply(result);
    } else if (request.method === "turn/interrupt") {
      const target = (request.params as { turnId: string }).turnId; stops.push(target); stopRequests.push(request.params as { threadId: string; turnId: string });
      if (target !== active) current.send(encodeJsonRpcMessage({ id: request.id, error: { code: -32000, message: "Active Turn changed" } }));
      else { if (!holdStopReply) reply({}); current.send(encodeJsonRpcMessage({ method: "serverRequest/resolved", params: { threadId: "a", requestId: "question" } })); }
    } else reply(request.method.endsWith("/list") ? { data: [], nextCursor: null } : {});
  } });
  const send = transport.send.bind(transport);
  transport.send = async frame => {
    await send(frame); const message = JSON.parse(frame);
    if (holdReceipt && message.method === undefined && message.id === "question") await new Promise<void>(resolve => { receipts.push(resolve); });
  };
  return { transport, reads, receipts, stops, stopRequests, responses, methods,
    get readCount() { return readCount; }, get initializations() { return initializations; },
    set holdRead(value: boolean) { holdRead = value; }, set holdReceipt(value: boolean) { holdReceipt = value; }, set holdStopReply(value: boolean) { holdStopReply = value; }, set active(value: string) { active = value; },
    archive() { peer.send(encodeJsonRpcMessage({ method: "thread/archived", params: { threadId: "a" } })); },
    question() { peer.send(encodeJsonRpcMessage({ id: "question", method: "item/tool/requestUserInput", params: { threadId: "a", turnId: "known-turn", itemId: "question-item", questions: [{ id: "q", header: "Q", question: "Q?", isOther: false, isSecret: false, options: null }] } })); },
    releaseHistory() { holdRead = false; for (const run of reads.splice(0)) run(); },
    releaseReceipts() { holdReceipt = false; for (const run of receipts.splice(0)) run(); },
    release() { this.releaseHistory(); this.releaseReceipts(); },
  };
}
export async function createStopControlFixture() {
  const f = stopControlTransportFixture(); let client!: import("@opencraft/appserver-client").AppServerClient;
  const runtime = createAppServerWorkbenchRuntime({ hostId: "h", transport: f.transport, autoReconnect: false, requestTimeoutMs: 60000,
    frameScheduler: { schedule(run) { queueMicrotask(run); return () => {}; } }, onRecoveryEvent() {},
    installClientHandlers(current) { client = current; return () => {}; },
  });
  await runtime.connect(); const view = await runtime.acquireThread("a"); view.setRecoveryVisibility(true); await drainStopFixture();
  assert.equal(view.getSnapshot().authoritative, true); assert.equal(view.getSnapshot().activeTurn?.turnId, "known-turn");
  return { ...f, f, runtime, view, client };
}
