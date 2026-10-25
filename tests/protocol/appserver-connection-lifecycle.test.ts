import assert from "node:assert/strict";
import test from "node:test";
import { JsonRpcAppServerClient, type DuplexTransport, type ServerRequestResponseContext } from "@opencraft/appserver-client";
import { MemoryTransport, type InMemoryAppServerPeer } from "@opencraft/appserver-transport-memory";
import { encodeJsonRpcMessage, isJsonRpcRequest, parseJsonRpcMessage } from "@opencraft/appserver-protocol";
import { WebSocketTransport } from "@opencraft/appserver-transport-websocket";
import { installBrowserDynamicToolHandler } from "@opencraft/browser-appserver";
import { WebSocket, WebSocketServer } from "ws";

const params = { clientInfo: { name: "lifecycle-test", version: "1" }, capabilities: { experimentalApi: true } };
const initialized = { codexHome: "/tmp/lifecycle-fixture", platformFamily: "unix", platformOs: "linux", userAgent: "fixture" };
for (const revoke of ["close", "abort"] as const) test(`initialization revoked before acquisition by ${revoke} allocates no transport`, async () => {
  let allocations = 0;
  const transport = new MemoryTransport({ receive() {} });
  const connect = transport.connect.bind(transport);
  transport.connect = signal => { allocations++; return connect(signal); };
  const client = new JsonRpcAppServerClient({ hostId: "revoked", transport });
  const abort = new AbortController();
  const rejected = assert.rejects(client.connect(params, abort.signal), error =>
    error instanceof Error && (error as Error & { code?: string }).code === (revoke === "close" ? "CLOSED" : "ABORTED"));
  if (revoke === "close") await client.close(); else abort.abort();
  await rejected;
  assert.equal(allocations, 0);
  await client.close();
});
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function fixture(wrap?: (memory: MemoryTransport) => DuplexTransport) {
  let peer!: InMemoryAppServerPeer;
  let incarnation = 0;
  const frames: Array<{ incarnation: number; message: ReturnType<typeof parseJsonRpcMessage> }> = [];
  const memory = new MemoryTransport({
    connected(value) { peer = value; incarnation++; },
    receive(frame, current) {
      const message = parseJsonRpcMessage(frame);
      if (isJsonRpcRequest(message) && message.method === "initialize") current.send(encodeJsonRpcMessage({ id: message.id, result: initialized }));
      else frames.push({ incarnation, message });
    },
  });
  const client = new JsonRpcAppServerClient({ hostId: "lifecycle-fixture", transport: wrap?.(memory) ?? memory });
  return { client, frames, get peer() { return peer; }, send(value: Parameters<typeof encodeJsonRpcMessage>[0]) { peer.send(encodeJsonRpcMessage(value)); } };
}

for (const fails of [false, true]) test(`lost connection rejects its inbound receipt and drops late ${fails ? "error" : "result"}`, async () => {
  const f = fixture(), gate = deferred<unknown>();
  let receipt!: ServerRequestResponseContext;
  f.client.handleServerRequest("fixture/held", (_p, _r, context) => { receipt = context; return gate.promise; });
  try {
    await f.client.connect(params);
    f.send({ id: 7, method: "fixture/held", params: {} }); await turn();
    f.peer.close("network loss");
    let rejected = false;
    void receipt.delivered.catch(() => { rejected = true; }); await turn();
    assert.equal(rejected, true, "disconnect must settle delivery even while the handler remains pending");
    await f.client.connect(params);
    if (fails) gate.reject(new Error("old operation failed")); else gate.resolve({ old: true });
    await turn(); assert.deepEqual(f.frames, []);
  } finally { gate.resolve(null); await f.client.close(); }
});

test("resolved is scoped to a live request and cannot suppress an ID reused after reconnect", async () => {
  const f = fixture();
  const receipts: ServerRequestResponseContext[] = [];
  f.client.handleServerRequest("fixture/instant", (p, _r, c) => { receipts.push(c); return p; });
  try {
    await f.client.connect(params);
    f.send({ id: 7, method: "fixture/instant", params: { threadId: "old" } }); await turn();
    await receipts[0]!.delivered;
    f.send({ method: "serverRequest/resolved", params: { requestId: 7, threadId: "old" } }); await turn();
    f.peer.close("server restarted"); await f.client.connect(params);
    f.send({ id: 7, method: "fixture/instant", params: { threadId: "new" } }); await turn();
    await receipts[1]!.delivered;
    assert.equal(f.frames.length, 2, "the new request must physically receive its response");
    assert.equal(f.frames[1]!.incarnation, 2);
  } finally { await f.client.close(); }
});

test("resolved immediately settles its receipt without leaving a marker for a successor", async () => {
  const f = fixture(), old = deferred<unknown>();
  const receipts: ServerRequestResponseContext[] = [];
  f.client.handleServerRequest("fixture/held", (_p, _r, c) => { receipts.push(c); return receipts.length === 1 ? old.promise : { current: true }; });
  try {
    await f.client.connect(params);
    f.send({ id: 7, method: "fixture/held", params: { threadId: "t" } }); await turn();
    f.send({ method: "serverRequest/resolved", params: { requestId: 7, threadId: "t" } }); await turn();
    let settled = false; void receipts[0]!.delivered.then(() => { settled = true; }); await turn();
    assert.equal(settled, true);
    f.send({ id: 7, method: "fixture/held", params: { threadId: "t" } }); await turn();
    assert.equal(f.frames.length, 1);
    old.resolve({ old: true }); await turn();
    assert.equal(f.frames.length, 1, "old completion must not reply to the successor");
  } finally { old.resolve(null); await f.client.close(); }
});

test("disconnect aborts a queued response send and never acknowledges its delivery", async () => {
  const gate = deferred<void>(); let signal: AbortSignal | undefined;
  const f = fixture(memory => ({
    get status() { return memory.status; }, connect: s => memory.connect(s), close: () => memory.close(),
    subscribeStatus: listener => memory.subscribeStatus(listener), subscribeMessage: listener => memory.subscribeMessage(listener),
    async send(frame, currentSignal) {
      if (!isJsonRpcRequest(parseJsonRpcMessage(frame))) {
        signal = currentSignal;
        await gate.promise;
        currentSignal?.throwIfAborted();
      }
      await memory.send(frame);
    },
  }));
  let receipt!: ServerRequestResponseContext;
  f.client.handleServerRequest("fixture/instant", (_p, _r, c) => { receipt = c; return {}; });
  try {
    await f.client.connect(params);
    f.send({ id: 7, method: "fixture/instant", params: {} }); await turn();
    f.peer.close("lost during queue wait");
    assert.equal(signal?.aborted, true);
    await assert.rejects(receipt.delivered, /transport closed/);
    await f.client.connect(params); gate.resolve(); await turn();
    assert.deepEqual(f.frames, []);
  } finally { gate.resolve(); await f.client.close(); }
});

test("client close invalidates a held inbound request without waiting for its handler", async () => {
  const f = fixture(), gate = deferred<unknown>(); let receipt!: ServerRequestResponseContext;
  f.client.handleServerRequest("fixture/held", (_p, _r, c) => { receipt = c; return gate.promise; });
  await f.client.connect(params); f.send({ id: 7, method: "fixture/held", params: {} }); await turn();
  await f.client.close();
  let rejected = false; void receipt.delivered.catch(() => { rejected = true; }); await turn();
  try { assert.equal(rejected, true); } finally { gate.resolve(null); await turn(); }
  assert.deepEqual(f.frames, []);
});

test("synchronous connecting observers share one client initialization", async () => {
  let initializations = 0;
  const transport = new MemoryTransport({ receive(frame, peer) {
    const request = parseJsonRpcMessage(frame);
    if (isJsonRpcRequest(request) && request.method === "initialize") {
      initializations++;
      peer.send(encodeJsonRpcMessage({ id: request.id, result: initialized }));
    }
  } });
  const client = new JsonRpcAppServerClient({ hostId: "reentry", transport });
  let second: Promise<unknown> | undefined;
  let entered = false;
  client.subscribeStatus(status => {
    if (status.state === "connecting" && !entered) { entered = true; second = client.connect(params); }
  });
  try {
    await client.connect(params); await second;
    assert.equal(initializations, 1);
    assert.equal(client.connectionGeneration, 1);
  } finally { await client.close(); }
});

for (const eventType of ["queued", "started"] as const) {
  test(`cancellation in ${eventType} observation cannot start or send a retired request`, async () => {
    const f = fixture(); const controller = new AbortController(); const events: string[] = [];
    try {
      await f.client.connect(params);
      f.client.subscribeRequestLifecycle(event => {
        if (!("method" in event) || event.method !== "fixture/mutation") return;
        events.push(event.type);
        if (event.type === eventType) controller.abort();
      });
      await assert.rejects(f.client.requestRaw("fixture/mutation", {}, { signal: controller.signal }), { code: "ABORTED" });
      await turn();
      assert.deepEqual(f.frames, []);
      assert.deepEqual(events, eventType === "queued" ? ["queued", "aborted"] : ["queued", "started", "aborted"]);
    } finally { await f.client.close(); }
  });
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length === 0) return [[]];
  return values.flatMap((value, index) => permutations(values.filter((_v, i) => i !== index)).map(tail => [value, ...tail]));
}

test("bounded lifecycle model enumerates completion/resolution/loss/reconnect/ID reuse", async () => {
  type Event = "finish" | "resolved" | "loss" | "reconnect" | "successor";
  const traces = permutations<Event>(["finish", "resolved", "loss", "reconnect", "successor"])
    .filter(trace => trace.indexOf("loss") < trace.indexOf("reconnect") && trace.indexOf("reconnect") < trace.indexOf("successor"));
  assert.equal(traces.length, 20);
  for (const fails of [false, true]) for (const trace of traces) {
    const f = fixture(), old = deferred<unknown>(); let calls = 0;
    // Reference model: loss/resolution revoke only that request's reply right.
    let oldMayReply = true, connected = true, connection = 1;
    const expected: Array<{ incarnation: number; id: number; owner: string }> = [];
    f.client.handleServerRequest("fixture/model", () => ++calls === 1 ? old.promise : { owner: "new" });
    try {
      await f.client.connect(params); f.send({ id: 7, method: "fixture/model", params: { threadId: "old" } }); await turn();
      for (const event of trace) {
        if (event === "loss") { oldMayReply = false; connected = false; f.peer.close("model loss"); }
        if (event === "reconnect") { connected = true; connection++; await f.client.connect(params); }
        if (event === "resolved") {
          if (connected) { oldMayReply = false; f.send({ method: "serverRequest/resolved", params: { requestId: 7, threadId: "old" } }); }
        }
        if (event === "finish") {
          if (oldMayReply && connected) expected.push({ incarnation: connection, id: 7, owner: "old" });
          oldMayReply = false;
          if (fails) old.reject(new Error("old")); else old.resolve({ owner: "old" });
        }
        if (event === "successor") {
          expected.push({ incarnation: connection, id: 7, owner: "new" });
          f.send({ id: 7, method: "fixture/model", params: { threadId: "new" } });
        }
        await turn();
      }
      const actual = f.frames.map(({ incarnation, message }) => {
        assert.ok("id" in message, "only RPC responses are delivered");
        return { incarnation, id: message.id, owner: "error" in message ? "old" : (message as { result: { owner: string } }).result.owner };
      });
      assert.deepEqual(actual, expected, `${fails ? "reject" : "resolve"}: ${trace.join(" → ")}`);
    } finally { old.resolve(null); await f.client.close(); }
  }
});

test("real WebSocket and browser interceptor discard an old physical connection's late result", { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const sockets: WebSocket[] = [], replies: unknown[] = [];
  const started = deferred<void>(), slow = deferred<unknown>();
  server.on("connection", socket => {
    sockets.push(socket);
    socket.on("message", raw => {
      const message = parseJsonRpcMessage(raw.toString());
      if (isJsonRpcRequest(message) && message.method === "initialize") socket.send(encodeJsonRpcMessage({ id: message.id, result: initialized }));
      else replies.push(message);
    });
  });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const transport = new WebSocketTransport({ url: `ws://127.0.0.1:${address.port}`, createSocket: url => new WebSocket(url) as unknown as globalThis.WebSocket });
  const client = new JsonRpcAppServerClient({ hostId: "browser-fixture", transport });
  const remove = installBrowserDynamicToolHandler(client, {
    open() { throw new Error("unused"); }, getTabContext() { throw new Error("unused"); },
    browserUse() { started.resolve(); return slow.promise; },
  }, { hostId: "browser-fixture" });
  try {
    await client.connect(params);
    sockets[0]!.send(encodeJsonRpcMessage({ id: 11, method: "item/tool/call", params: { namespace: "opencraft_browser", tool: "browser_use", arguments: { action: "wait", text: "fixture" }, threadId: "t", turnId: "u", callId: "c" } }));
    await started.promise;
    const disconnected = deferred<void>(); const off = client.subscribeStatus(s => { if (s.state === "closed") disconnected.resolve(); });
    sockets[0]!.close(); await disconnected.promise; off(); await client.connect(params);
    slow.resolve({ oldConnection: true });
    // A round trip drains any earlier frames on the replacement socket.
    await new Promise<void>(resolve => { sockets[1]!.once("pong", () => resolve()); sockets[1]!.ping(); });
    await turn(); assert.deepEqual(replies, []); assert.equal(client.connectionGeneration, 2);
  } finally {
    slow.resolve(null); remove(); await client.close(); for (const socket of sockets) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("owner expiry before initialization commit cannot poison cached readiness for the successor", async () => {
  let requests = 0, permit = true;
  const transport = new MemoryTransport({ receive(frame, peer) {
    const request = parseJsonRpcMessage(frame);
    if (isJsonRpcRequest(request) && request.method === "initialize") {
      requests++;
      permit = false; // The reply arrives after the owner's independent deadline.
      peer.send(encodeJsonRpcMessage({ id: request.id, result: initialized }));
    }
  } });
  const client = new JsonRpcAppServerClient({ hostId: "commit-guard", transport });
  try {
    await assert.rejects(client.connect(params, undefined, () => { if (!permit) throw Error("owner expired"); }), /owner expired/);
    assert.equal(client.initializeResult, null); assert.equal(client.connectionGeneration, 0);
    await client.connect(params);
    assert.equal(requests, 2); assert.equal(client.connectionGeneration, 1);
  } finally { await client.close(); }
});

test("revocation between client readiness and owner commit invalidates the cached initialization", async () => {
  let requests = 0;
  const transport = new MemoryTransport({ receive(frame, peer) {
    const request = parseJsonRpcMessage(frame);
    if (isJsonRpcRequest(request) && request.method === "initialize") {
      requests++; peer.send(encodeJsonRpcMessage({ id: request.id, result: initialized }));
    }
  } });
  const client = new JsonRpcAppServerClient({ hostId: "cached-commit-guard", transport });
  const old = new AbortController();
  try {
    await client.connect(params, old.signal, () => old.signal.throwIfAborted());
    assert.notEqual(client.initializeResult, null);
    old.abort(new Error("owner deadline before its commit"));
    assert.equal(transport.status.state, "open", "local retirement does not close a healthy physical channel");
    assert.equal(client.initializeResult, null);
    await client.connect(params, new AbortController().signal);
    assert.equal(requests, 2, "the successor cannot inherit the revoked owner's readiness cache");
    assert.equal(client.connectionGeneration, 2);
  } finally { await client.close(); }
});

test("ordinary completed connect cancellation keeps its established initialization", async () => {
  const f = fixture(), abort = new AbortController();
  try {
    await f.client.connect(params, abort.signal);
    abort.abort();
    assert.notEqual(f.client.initializeResult, null);
    assert.equal(f.client.status.state, "open");
  } finally { await f.client.close(); }
});
