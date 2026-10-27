import test from "node:test";
import assert from "node:assert/strict";
import { MemoryTransport, type InMemoryAppServerPeer } from "@opencraft/appserver-transport-memory";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";

function held() {
  let resolve!: () => void, reject!: (cause: unknown) => void;
  const promise = new Promise<void>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function outcome(promise: Promise<unknown>) {
  let state = "pending";
  void promise.then(() => { state = "resolved"; }, () => { state = "rejected"; });
  return () => state;
}

test("Memory peers have distinct connection incarnations and retired peers cannot close the successor", async () => {
  const peers: InMemoryAppServerPeer[] = [];
  const transport = new MemoryTransport({ connected(peer) { peers.push(peer); }, receive() {} });
  await transport.connect(); await transport.close(); await transport.connect();
  try {
    assert.notEqual(peers[0], peers[1]);
    peers[0]!.close("retired"); assert.equal(transport.status.state, "open");
  } finally { await transport.close(); }
});

test("Memory queued delivery remains bound to its original peer", async () => {
  const peers: InMemoryAppServerPeer[] = [], queued: (() => void)[] = [], frames: string[] = [];
  const transport = new MemoryTransport({ server: { connected(p) { peers.push(p); }, receive() {} }, schedule: cb => queued.push(cb) });
  transport.subscribeMessage(frame => frames.push(frame));
  await transport.connect(); peers[0]!.send("old queued"); await transport.close(); await transport.connect();
  peers[0]!.send("old late"); peers[1]!.send("current"); queued.splice(0).forEach(cb => cb());
  try { assert.deepEqual(frames, ["current"]); } finally { await transport.close(); }
});

test("Memory native delivery rechecks its peer after synchronous message-consumer reentry", async () => {
  const peers: InMemoryAppServerPeer[] = [], received: string[] = [];
  const transport = new MemoryTransport({ server: { connected(p) { peers.push(p); }, receive() {} }, schedule: cb => cb() });
  let successor: Promise<void> | undefined;
  transport.subscribeMessage(() => { peers[0]!.close(); successor = transport.connect(); });
  transport.subscribeMessage(frame => received.push(frame));
  await transport.connect(); peers[0]!.send("old fanout"); await successor;
  try { assert.deepEqual(received, []); assert.equal(transport.status.state, "open"); } finally { await transport.close(); }
});

test("Memory old disconnected acknowledgement cannot publish closed over a successor", async () => {
  const ack = held(); let disconnects = 0;
  const transport = new MemoryTransport({ receive() {}, disconnected() { return ++disconnects === 1 ? ack.promise : undefined; } });
  await transport.connect(); const closing = transport.close(); const observed = outcome(closing); await flush();
  assert.equal(observed(), "pending"); assert.equal(transport.status.state, "closing");
  await transport.connect(); ack.resolve(); await closing;
  try { assert.equal(transport.status.state, "open"); } finally { await transport.close(); }
});

for (const completion of ["resolve", "reject"] as const) test(`Memory retired connected ${completion} cannot revive or fail its successor`, async () => {
  const admission = held(); let calls = 0;
  const transport = new MemoryTransport({ receive() {}, connected() { return ++calls === 1 ? admission.promise : undefined; } });
  const old = transport.connect(); const observed = outcome(old);
  try {
    await transport.close(); await flush(); assert.equal(observed(), "rejected");
    await transport.connect(); if (completion === "resolve") admission.resolve(); else admission.reject(new Error("old native failure")); await flush();
    assert.equal(transport.status.state, "open");
  } finally { admission.resolve(); await old.catch(() => {}); await transport.close(); }
});

test("Memory abort settles local connect without waiting for an uncooperative connected hook", async () => {
  const admission = held(), controller = new AbortController();
  const transport = new MemoryTransport({ receive() {}, connected() { return admission.promise; } });
  const connecting = transport.connect(controller.signal), observed = outcome(connecting);
  try {
    controller.abort(); await flush(); assert.equal(observed(), "rejected"); assert.equal(transport.status.state, "closed");
  } finally { admission.resolve(); await connecting.catch(() => {}); await transport.close(); }
});

test("Memory concurrent connect callers join one native admission", async () => {
  const admission = held(); let admissions = 0;
  const transport = new MemoryTransport({ receive() {}, connected() { admissions++; return admission.promise; } });
  const a = transport.connect(), b = transport.connect(); admission.resolve(); await Promise.all([a, b]);
  try { assert.equal(admissions, 1); } finally { await transport.close(); }
});

for (const action of ["close", "abort"] as const) test(`Memory connecting observer ${action} prevents obsolete server admission`, async () => {
  let admissions = 0; const controller = new AbortController();
  const transport = new MemoryTransport({ receive() {}, connected() { admissions++; } });
  transport.subscribeStatus(s => { if (s.state === "connecting") { if (action === "close") void transport.close(); else controller.abort(); } });
  const connecting = transport.connect(controller.signal); const observed = outcome(connecting); await flush();
  try { assert.equal(admissions, 0); assert.equal(observed(), "rejected"); assert.equal(transport.status.state, "closed"); }
  finally { await connecting.catch(() => {}); await transport.close(); }
});

test("Memory server closing synchronously during admission cannot later publish open", async () => {
  const transport = new MemoryTransport({ receive() {}, connected(peer) { peer.close("refused"); } });
  const connecting = transport.connect(); const observed = outcome(connecting); await flush();
  try { assert.equal(observed(), "rejected"); assert.equal(transport.status.state, "closed"); }
  finally { await connecting.catch(() => {}); await transport.close(); }
});

test("Memory preserves a current admission failure and releases its own peer once", async () => {
  const failure = new Error("current admission"); const peers: InMemoryAppServerPeer[] = [], cleaned: InMemoryAppServerPeer[] = [];
  const transport = new MemoryTransport({ receive() {}, connected(p) { peers.push(p); throw failure; }, disconnected(p) { cleaned.push(p); } });
  try {
    await assert.rejects(transport.connect(), error => error === failure); await flush();
    assert.equal(transport.status.state, "failed"); assert.deepEqual(cleaned, peers);
  } finally { await transport.close(); }
});

test("Memory completed connect abort is a no-op", async () => {
  const controller = new AbortController(), transport = new MemoryTransport({ receive() {} });
  await transport.connect(controller.signal); controller.abort(); await flush();
  try { assert.equal(transport.status.state, "open"); } finally { await transport.close(); }
});

test("Memory late receive continuation only holds its retired peer", async () => {
  const receipt = held(), frames: string[] = [];
  const transport = new MemoryTransport({ async receive(_frame, peer) { await receipt.promise; peer.send("old reply"); } });
  transport.subscribeMessage(frame => frames.push(frame)); await transport.connect(); const sending = transport.send("old request");
  await transport.close(); await transport.connect(); receipt.resolve(); await sending; await flush();
  try { assert.deepEqual(frames, []); } finally { await transport.close(); }
});

test("Memory old cleanup failure rejects its caller without failing a new connection", async () => {
  const ack = held(); let disconnects = 0;
  const transport = new MemoryTransport({ receive() {}, disconnected() { return ++disconnects === 1 ? ack.promise : undefined; } });
  await transport.connect(); const closing = transport.close(); const observed = outcome(closing); await flush(); await transport.connect();
  ack.reject(new Error("old cleanup")); await flush();
  try { assert.equal(observed(), "rejected"); assert.equal(transport.status.state, "open"); } finally { await transport.close(); }
});

test("Memory current cleanup failure remains visible and a fresh connection can recover", async () => {
  const failure = new Error("current cleanup"); let disconnects = 0;
  const transport = new MemoryTransport({ receive() {}, disconnected() { if (++disconnects === 1) throw failure; } });
  await transport.connect(); await assert.rejects(transport.close(), error => error === failure);
  assert.equal(transport.status.state, "failed");
  await transport.connect();
  try { assert.equal(transport.status.state, "open"); } finally { await transport.close(); }
});

test("Memory late admission is cleaned exactly once after it settles, using its own peer", async () => {
  const admission = held(), peers: InMemoryAppServerPeer[] = [], cleaned: InMemoryAppServerPeer[] = [];
  const transport = new MemoryTransport({ receive() {}, connected(p) { peers.push(p); return peers.length === 1 ? admission.promise : undefined; }, disconnected(p) { cleaned.push(p); } });
  const old = transport.connect(); outcome(old);
  await transport.close(); assert.deepEqual(cleaned, []); await transport.connect();
  admission.resolve(); await old.catch(() => {}); await flush();
  try { assert.deepEqual(cleaned, [peers[0]]); assert.equal(transport.status.state, "open"); }
  finally { await transport.close(); assert.deepEqual(cleaned, peers); }
});

test("Memory Client reconnect initializes a fresh peer and retains normal request/reply", async () => {
  const peers: InMemoryAppServerPeer[] = [];
  const transport = new MemoryTransport({ connected(p) { peers.push(p); }, receive(frame, peer) {
    const request = JSON.parse(frame);
    peer.send(JSON.stringify({ id: request.id, result: request.method === "initialize"
      ? { codexHome: "/fixture", platformFamily: "unix", platformOs: "linux", userAgent: "memory-generation" } : request.params }));
  } });
  const client = new JsonRpcAppServerClient({ hostId: "memory-generation", transport });
  const params = { clientInfo: { name: "memory-generation", version: "1" } };
  try {
    await client.connect(params); assert.deepEqual(await client.requestRaw("echo", { current: 1 }), { current: 1 });
    await transport.close(); await client.connect(params); peers[0]!.close();
    assert.deepEqual(await client.requestRaw("echo", { current: 2 }), { current: 2 }); assert.equal(client.connectionGeneration, 2);
  } finally { await client.close(); }
});
