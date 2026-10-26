import test from "node:test";
import assert from "node:assert/strict";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { MemoryTransport, type InMemoryAppServerPeer } from "@opencraft/appserver-transport-memory";
import { RecordingTransport } from "@opencraft/appserver-transport-replay";
import { WebSocketTransport } from "@opencraft/appserver-transport-websocket";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";
import { StatusSocket } from "./fixtures/transport-status";

const params = { clientInfo: { name: "native-retirement", version: "1" } };
const response = { codexHome: "/fixture", platformFamily: "unix", platformOs: "linux", userAgent: "native-retirement" };
const flush = async () => { for (let i = 0; i < 64; i++) await Promise.resolve(); };
function held() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function observe(promise: Promise<unknown>) { const state = { outcome: "pending", error: undefined as unknown }; void promise.then(() => { state.outcome = "resolved"; }, e => { state.outcome = "rejected"; state.error = e; }); return state; }
function fixture(options: { noSample?: boolean; recording?: boolean; holdSecondAdmission?: boolean } = {}) {
  const gate = held(), peers: InMemoryAppServerPeer[] = [], requests: string[] = [], deferred: { id: unknown; peer: InMemoryAppServerPeer }[] = [];
  const raw = new MemoryTransport({ connected(p) { peers.push(p); if (options.holdSecondAdmission && peers.length === 2) return gate.promise; }, receive(frame, peer) {
    const request = JSON.parse(frame); requests.push(request.method);
    if (request.method === "held") { deferred.push({ id: request.id, peer }); return; }
    peer.send(JSON.stringify({ id: request.id, result: request.method === "initialize" ? response : request.params }));
  } });
  const listeners = new Set<(s: TransportStatus) => void>();
  const bridge: DuplexTransport = {
    get status() { return raw.status; }, connect: signal => raw.connect(signal), send: frame => raw.send(frame), close: () => raw.close(),
    subscribeMessage: listener => raw.subscribeMessage(listener), subscribeStatus(listener) {
      let setup = true; listeners.add(listener);
      const remove = raw.subscribeStatus(s => { if (!setup || !options.noSample) listener(s); }); setup = false;
      return () => { listeners.delete(listener); remove(); };
    },
  };
  const transport = options.recording ? new RecordingTransport({ transport: bridge }) : bridge;
  return { raw, transport, peers, requests, deferred, gate, sample: (s: TransportStatus) => { for (const l of listeners) l(s); },
    client: () => new JsonRpcAppServerClient({ hostId: "native-retirement", transport, requestTimeoutMs: 0 }) };
}

test("Client successor survives close ACK between local slot allocation and native admission", async () => {
  const f = fixture(), client = f.client(); await client.connect(params);
  const closing = f.transport.close(); const connecting = client.connect(params); const state = observe(connecting); await flush();
  try {
    assert.equal(state.outcome, "resolved"); assert.equal(client.connectionGeneration, 2);
    assert.equal(f.requests.filter(m => m === "initialize").length, 2);
  } finally { await closing; await client.close(); await connecting.catch(() => {}); }
});

test("Client sequential close/connect remains valid", async () => {
  const f = fixture(), client = f.client();
  try { await client.connect(params); await f.transport.close(); await client.connect(params); assert.equal(client.connectionGeneration, 2); }
  finally { await client.close(); }
});

test("Client does not join retired native work when connecting was revoked before its observer ran", async () => {
  const f = fixture(); let first = true, successor: Promise<unknown> | undefined, next: ReturnType<typeof observe> | undefined;
  let client!: JsonRpcAppServerClient;
  f.raw.subscribeStatus(s => {
    if (first && s.state === "connecting") {
      first = false; void f.raw.close(); successor = client.connect(params); next = observe(successor);
    }
  });
  client = f.client(); const initial = client.connect(params), old = observe(initial); await flush();
  try { assert.equal(old.outcome, "rejected"); assert.equal(next?.outcome, "resolved"); assert.equal(client.connectionGeneration, 1); }
  finally { await client.close(); await initial.catch(() => {}); await successor?.catch(() => {}); }
});

for (const terminal of ["closing", "closed", "failed"] as const) test(`Client repeated ${terminal} cannot revoke a preparing successor`, async () => {
  const f = fixture(), client = f.client(); await client.connect(params);
  const closing = f.transport.close(), connecting = client.connect(params), state = observe(connecting);
  queueMicrotask(() => f.sample({ state: terminal, reason: "same retired native activity" })); await flush();
  try { assert.equal(state.outcome, "resolved"); assert.equal(client.connectionGeneration, 2); }
  finally { await closing; await client.close(); await connecting.catch(() => {}); }
});

test("Client ignores a Recording reattachment's old closed sample as a second native retirement", async () => {
  const f = fixture({ recording: true }), client = f.client();
  try {
    await client.connect(params); await f.transport.close();
    const connecting = client.connect(params), state = observe(connecting); await flush();
    assert.equal(state.outcome, "resolved"); assert.equal(client.connectionGeneration, 2);
  } finally { await client.close(); }
});

test("Client recovery reconciles terminal state before allocating a slot after a missed loss observation", async () => {
  const f = fixture({ recording: true });
  f.transport.subscribeStatus(s => { if (s.state === "closing" || s.state === "closed") throw Error("external wrapper observer"); });
  const client = f.client(); await client.connect(params);
  const request = client.requestRaw("held", {}), old = observe(request); await flush(); await f.transport.close();
  const connecting = client.connect(params), next = observe(connecting); await flush();
  try { assert.equal(old.outcome, "rejected"); assert.equal(next.outcome, "resolved"); assert.equal(client.getPendingRequestCount(), 0); }
  finally { await client.close(); await connecting.catch(() => {}); await request.catch(() => {}); }
});

test("Client observes an already-open provider even without an initial subscription sample", async () => {
  const f = fixture({ noSample: true }); await f.raw.connect(); const client = f.client();
  const connecting = client.connect(params), state = observe(connecting); await Promise.resolve();
  f.peers[0]!.close("lost existing native activity"); await flush();
  try { assert.equal(state.outcome, "rejected"); assert.equal(client.connectionGeneration, 0); }
  finally { await client.close(); await connecting.catch(() => {}); }
});

for (const phase of ["connecting", "open"] as const) test(`Client ${phase} observation rearms retirement of the next native activity`, async () => {
  const f = fixture({ holdSecondAdmission: phase === "connecting" }), client = f.client(); await client.connect(params); await f.raw.close();
  const native = f.raw.connect(); void native.catch(() => {}); if (phase === "open") await native;
  const connecting = client.connect(params), state = observe(connecting); await Promise.resolve();
  f.peers[1]!.close("new native lost"); await flush();
  try { assert.equal(state.outcome, "rejected"); assert.equal(client.connectionGeneration, 1); assert.equal(f.peers.length, 2); }
  finally { f.gate.resolve(); await native.catch(() => {}); await client.close(); await connecting.catch(() => {}); }
});

test("Client current native loss still terminates held RPCs and never replays them", async () => {
  const f = fixture(), client = f.client(); await client.connect(params);
  const request = client.requestRaw("held", { nonce: "one-intent" }), state = observe(request); await flush();
  const closing = f.raw.close(), connecting = client.connect(params), next = observe(connecting); await flush();
  try {
    assert.equal(state.outcome, "rejected"); assert.equal(next.outcome, "resolved"); assert.equal(client.getPendingRequestCount(), 0);
    f.deferred[0]!.peer.send(JSON.stringify({ id: f.deferred[0]!.id, result: "retired" })); await flush();
    assert.equal(f.requests.filter(m => m === "held").length, 1); assert.equal(client.connectionGeneration, 2);
    assert.equal(client.initializeResult?.userAgent, "native-retirement");
  } finally { await closing; await client.close(); await connecting.catch(() => {}); await request.catch(() => {}); }
});

test("Client pending initialization is terminated by a genuine new native loss", async () => {
  const raw = new MemoryTransport({ receive() {} }); const client = new JsonRpcAppServerClient({ hostId: "new-loss", transport: raw, requestTimeoutMs: 0 });
  const connecting = client.connect(params), state = observe(connecting); await flush(); assert.equal(client.getPendingRequestCount(), 1);
  await raw.close(); await flush();
  try { assert.equal(state.outcome, "rejected"); assert.equal(client.getPendingRequestCount(), 0); }
  finally { await client.close(); await connecting.catch(() => {}); }
});

test("Client explicit cancellation still owns its future connect outcome", async () => {
  const f = fixture(), client = f.client(); await client.connect(params); const closing = f.raw.close();
  const controller = new AbortController(), connecting = client.connect(params, controller.signal), state = observe(connecting); controller.abort(); await flush();
  try { assert.equal(state.outcome, "rejected"); assert.equal((state.error as { code: string }).code, "ABORTED"); }
  finally { await closing; await client.close(); await connecting.catch(() => {}); }
});

test("Client WebSocket close ACK cannot revoke local initialization before the new socket exists", async () => {
  class EchoSocket extends StatusSocket { override send(frame: string) { super.send(frame); const request = JSON.parse(frame); queueMicrotask(() => this.emitMessage(JSON.stringify({ id: request.id, result: response }))); } }
  const sockets: EchoSocket[] = [];
  const transport = new WebSocketTransport({ url: "ws://fixture.invalid", createSocket() { const socket = new EchoSocket(); sockets.push(socket); queueMicrotask(() => socket.emitOpen()); return socket; } });
  const client = new JsonRpcAppServerClient({ hostId: "ws-retirement", transport, requestTimeoutMs: 0 }); await client.connect(params);
  sockets[0]!.autoClose = false; const closing = transport.close(), connecting = client.connect(params), state = observe(connecting);
  queueMicrotask(() => sockets[0]!.emitClose(1000, "old ACK")); await flush();
  try { assert.equal(state.outcome, "resolved"); assert.equal(client.connectionGeneration, 2); assert.equal(sockets.length, 2); }
  finally { for (const s of sockets) s.autoClose = true; await closing; await client.close(); await connecting.catch(() => {}); }
});
