import test from "node:test";
import assert from "node:assert/strict";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import { RecordingTransport, type RecordedFrame } from "@opencraft/appserver-transport-replay";

const params = { clientInfo: { name: "recording-lifetime", version: "1" } };
const result = { codexHome: "/recording", platformFamily: "unix", platformOs: "linux", userAgent: "recording-lifetime" };
const flush = async () => { for (let i = 0; i < 64; i++) await Promise.resolve(); };
function observe(p: Promise<unknown>) { const state = { outcome: "pending", value: undefined as unknown }; void p.then(v => { state.outcome = "resolved"; state.value = v; }, e => { state.outcome = "rejected"; state.value = e; }); return state; }
function fixture(sink?: (frame: RecordedFrame) => void) {
  const wires: string[] = [];
  const raw = new MemoryTransport({ receive(frame, peer) {
    const m = JSON.parse(frame); wires.push(m.method);
    if (m.method !== "held") peer.send(JSON.stringify({ id: m.id, result: m.method === "initialize" ? result : m.params }));
  } });
  const recording = new RecordingTransport({ transport: raw, sink });
  const client = () => new JsonRpcAppServerClient({ hostId: "recording-lifetime", transport: recording, requestTimeoutMs: 0 });
  return { raw, recording, wires, client };
}

test("Recording status observer failure cannot strand a Client held request", async () => {
  const f = fixture(); f.recording.subscribeStatus(s => { if (s.state === "closing" || s.state === "closed") throw Error("observer"); });
  const client = f.client();
  try {
    await client.connect(params); const call = observe(client.requestRaw("held", {})); await flush();
    await f.recording.close(); await flush();
    assert.equal(f.raw.status.state, "closed"); assert.equal(call.outcome, "rejected"); assert.equal(client.getPendingRequestCount(), 0);
  } finally { await client.close(); }
});

test("Recording connect does not rebroadcast the raw subscription initial sample", async () => {
  const f = fixture(), statuses: string[] = [];
  f.recording.subscribeStatus(s => statuses.push(s.state));
  try { await f.recording.connect(); assert.deepEqual(statuses, ["idle", "connecting", "open"]); }
  finally { await f.recording.close(); }
});

test("Recording successor retains message forwarding after the old close ACK", async () => {
  const f = fixture(), frames: string[] = []; f.recording.subscribeMessage(frame => frames.push(frame));
  await f.recording.connect(); let successor: Promise<void> | undefined, once = false;
  f.recording.subscribeStatus(s => { if (s.state === "closing" && !once) { once = true; successor = f.recording.connect(); } });
  try {
    await f.recording.close(); await successor; await f.recording.send(JSON.stringify({ id: 1, method: "echo", params: { after: true } })); await flush();
    assert.equal(f.recording.status.state, "open"); assert.equal(frames.length, 1);
    assert.equal(f.recording.recording.filter(frame => frame.direction === "server-to-client").length, 1);
  } finally { await f.recording.close(); }
});

test("earlier raw observer reentering wrapper close cannot suppress queued terminal delivery", async () => {
  const f = fixture(); let closing: Promise<void> | undefined, once = false;
  f.raw.subscribeStatus(s => { if (s.state === "closing" && !once) { once = true; closing = f.recording.close(); } });
  const client = f.client();
  try {
    await client.connect(params); const call = observe(client.requestRaw("held", {})); await flush();
    await f.raw.close(); await closing; await flush(); assert.equal(call.outcome, "rejected"); assert.equal(client.getPendingRequestCount(), 0);
  } finally { await client.close(); }
});

test("throwing message observer cannot prevent Client initialization response delivery", async () => {
  const f = fixture(); f.recording.subscribeMessage(() => { throw Error("message observer"); }); const client = f.client();
  try { const call = observe(client.connect(params)); await flush(); assert.equal(call.outcome, "resolved"); assert.equal(client.connectionGeneration, 1); }
  finally { await client.close(); }
});

for (const direction of ["client-to-server", "server-to-client"] as const) test(`throwing ${direction} recording sink cannot interrupt native RPC progress`, async () => {
  const f = fixture(frame => { if (frame.direction === direction) throw Error("sink"); }); const client = f.client();
  try {
    const call = observe(client.connect(params)); await flush(); assert.equal(call.outcome, "resolved"); assert.deepEqual(f.wires, ["initialize"]);
    assert.deepEqual(f.recording.recording.map(frame => frame.direction), ["client-to-server", "server-to-client"]);
  } finally { await client.close(); }
});

test("Recording sink is a bare non-authoritative callback", async () => {
  const seen: unknown[] = [], f = fixture(function (this: unknown) { seen.push(this); }); const client = f.client();
  try { await client.connect(params); assert.deepEqual(seen, [undefined, undefined]); }
  finally { await client.close(); }
});

test("stale message unsubscribe token cannot remove a later same-function registration", async () => {
  const f = fixture(), seen: string[] = []; const listener = (frame: string) => seen.push(frame);
  const removeOld = f.recording.subscribeMessage(listener); removeOld(); f.recording.subscribeMessage(listener); removeOld();
  try { await f.recording.connect(); await f.recording.send(JSON.stringify({ id: 1, method: "echo", params: {} })); await flush(); assert.equal(seen.length, 1); }
  finally { await f.recording.close(); }
});

test("message observer registered during delivery is admitted on the next frame", async () => {
  const f = fixture(), seen: string[] = []; const later = () => seen.push("later");
  f.recording.subscribeMessage(() => { seen.push("first"); f.recording.subscribeMessage(later); });
  try {
    await f.recording.connect(); await f.recording.send(JSON.stringify({ id: 1, method: "echo", params: {} })); await flush();
    assert.deepEqual(seen, ["first"]);
    await f.recording.send(JSON.stringify({ id: 2, method: "echo", params: {} })); await flush(); assert.deepEqual(seen, ["first", "first", "later"]);
  } finally { await f.recording.close(); }
});

test("message delivery stops when a preceding callback retires its attachment", async () => {
  const f = fixture(), seen: string[] = []; let closing: Promise<void> | undefined, successor: Promise<void> | undefined, once = false;
  f.recording.subscribeMessage(() => { if (!once) { once = true; closing = f.recording.close(); successor = f.recording.connect(); } });
  f.recording.subscribeMessage(frame => seen.push(frame));
  try {
    await f.recording.connect(); await f.recording.send(JSON.stringify({ id: 1, method: "echo", params: {} })); await flush(); await closing; await successor;
    assert.deepEqual(seen, []);
    await f.recording.send(JSON.stringify({ id: 2, method: "echo", params: {} })); await flush(); assert.equal(seen.length, 1);
  } finally { await f.recording.close(); }
});

test("native close failure remains visible without releasing successor attachment", async () => {
  let once = false;
  const raw = new MemoryTransport({ disconnected() { if (!once) { once = true; throw Error("native cleanup"); } }, receive(frame, peer) { peer.send(frame); } });
  const recording = new RecordingTransport({ transport: raw }), seen: string[] = []; recording.subscribeMessage(frame => seen.push(frame));
  await recording.connect(); let successor: Promise<void> | undefined;
  recording.subscribeStatus(s => { if (s.state === "closing" && !successor) successor = recording.connect(); });
  try {
    await assert.rejects(recording.close(), /native cleanup/); await successor;
    await recording.send("after"); await flush(); assert.equal(recording.status.state, "open"); assert.deepEqual(seen, ["after"]);
  } finally { await recording.close(); }
});

test("normal sequential recorded Client reconnect initializes exactly once per connection", async () => {
  const f = fixture(), client = f.client();
  try { await client.connect(params); await f.recording.close(); await client.connect(params); assert.equal(client.connectionGeneration, 2); assert.deepEqual(f.wires, ["initialize", "initialize"]); }
  finally { await client.close(); }
});

test("failed close releases its old tap even when no wrapper successor exists", async () => {
  let once = false;
  const raw = new MemoryTransport({ disconnected() { if (!once) { once = true; throw Error("native cleanup"); } }, receive(frame, peer) { peer.send(frame); } });
  const recording = new RecordingTransport({ transport: raw }), seen: string[] = []; recording.subscribeMessage(frame => seen.push(frame));
  await recording.connect();
  try {
    await assert.rejects(recording.close(), /native cleanup/);
    await raw.connect(); await raw.send("outside-wrapper"); await flush(); assert.deepEqual(seen, []);
  } finally { await raw.close(); }
});

test("sink exception cannot mask the actual native send failure", async () => {
  const nativeError = Error("native receive");
  const raw = new MemoryTransport({ receive() { throw nativeError; } });
  const recording = new RecordingTransport({ transport: raw, sink() { throw Error("sink"); } });
  try { await recording.connect(); await assert.rejects(recording.send("request"), error => error === nativeError); }
  finally { await recording.close(); }
});

test("new recording tap serves a successor while the retired close ACK is held", async () => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let cleanups = 0;
  const raw = new MemoryTransport({ disconnected() { if (++cleanups === 1) return gate; }, receive(frame, peer) { peer.send(frame); } });
  const recording = new RecordingTransport({ transport: raw }), seen: string[] = []; recording.subscribeMessage(frame => seen.push(frame));
  await recording.connect();
  const closing = recording.close(); let closed = false; void closing.then(() => { closed = true; });
  try {
    await recording.connect(); await recording.send("before-old-ack"); await flush();
    assert.equal(closed, false); assert.deepEqual(seen, ["before-old-ack"]);
    release(); await closing; await recording.send("after-old-ack"); await flush(); assert.deepEqual(seen, ["before-old-ack", "after-old-ack"]);
  } finally { release(); await closing; await recording.close(); }
});
