import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { CodexCoreReadIsolation } from "../../apps/opencraft-daemon/src/codex-core-read-isolation";
import { CodexCoreSocket } from "../../apps/opencraft-daemon/src/codex-core-socket";
import { CodexEngineAdapter } from "../../apps/opencraft-daemon/src/codex-engine-adapter";

type HistoryFixture = { reader: CodexCoreReadIsolation; main: CodexCoreSocket; statuses: string[]; requests: any[]; peers: WebSocket[]; endpoint: { nativeSocket: string } };
async function fixture(run: (f: HistoryFixture) => Promise<void>, options: {
  concurrency?: number; queue?: number; timeoutMs?: number;
  handle?: (message: any, socket: WebSocket) => boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "oc-history-fault-"));
  const path = join(root, "native.sock"), server = createServer(), wss = new WebSocketServer({ server });
  const requests: any[] = [], statuses: string[] = [], peers: WebSocket[] = [];
  wss.on("connection", socket => { peers.push(socket); socket.on("message", raw => {
    const message = JSON.parse(String(raw)); requests.push(message);
    if (message.id === undefined) return;
    if (options.handle?.(message, socket)) return;
    if (message.params?.threadId === "slow") return;
    const result = message.params?.threadId === "huge" ? { text: "x".repeat(10_000) } : { data: [], nextCursor: null, threadId: message.params?.threadId };
    socket.send(JSON.stringify({ id: message.id, result }));
  }); });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const health = async () => ({ nativeSocket: path });
  const reader = new CodexCoreReadIsolation(health, { maxPayload: 4096, concurrency: options.concurrency ?? 2, queue: options.queue ?? 2, timeoutMs: options.timeoutMs ?? 250 });
  const main = new CodexCoreSocket({ health, message: () => undefined, status: value => statuses.push(value.state) });
  try { await main.connect(); await run({ reader, main, statuses, requests, peers, endpoint: { nativeSocket: path } }); }
  finally { reader.close(); main.close(); for (const socket of wss.clients) socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}

test("oversized history fails only that RPC; peer reads and subscription socket remain open", async () => {
  await fixture(async ({ reader, main, statuses, requests }) => {
    const [huge, peer] = await Promise.all([
      reader.read({ id: "huge-id", method: "thread/read", params: { threadId: "huge", includeTurns: true } }),
      reader.read({ id: "peer-id", method: "thread/turns/list", params: { threadId: "peer", limit: 1 } }),
    ]);
    assert.deepEqual(JSON.parse(huge), { id: "huge-id", error: { code: -32072, message: "History response is too large; use a smaller history page", data: { code: "HISTORY_RESPONSE_TOO_LARGE", retryable: false } } });
    assert.equal(JSON.parse(peer).id, "peer-id"); assert.equal(JSON.parse(peer).error, undefined);
    assert.equal(main.status.state, "open"); assert.deepEqual(statuses, ["connecting", "open"]);
    assert.equal(JSON.parse(await reader.read({ id: 3, method: "thread/read", params: { threadId: "later" } })).error, undefined);
    assert(!requests.some(r => ["thread/resume", "turn/start", "thread/unsubscribe"].includes(r.method)));
  });
});

test("queued reads share the end-to-end deadline and disposal leaves the shared transport open", async () => {
  await fixture(async ({ reader, main }) => {
    const first = reader.read({ id: 1, method: "thread/read", params: { threadId: "slow" } });
    const second = reader.read({ id: 2, method: "thread/read", params: { threadId: "slow" } });
    const third = reader.read({ id: 3, method: "thread/read", params: { threadId: "peer" } });
    assert.equal(JSON.parse(await first).error.data.code, "HISTORY_READ_UNAVAILABLE");
    assert.equal(JSON.parse(await third).error.data.code, "HISTORY_READ_UNAVAILABLE"); await second;
    assert.equal(JSON.parse(await reader.read({ id: 30, method: "thread/read", params: { threadId: "recovered" } })).result.threadId, "recovered");
    const pending = reader.read({ id: 4, method: "thread/read", params: { threadId: "slow" } });
    reader.close(); assert.equal(JSON.parse(await pending).id, 4);
    assert.equal(main.status.state, "open");
  });
});

test("Host subscription/status checks request no history and schedule inspection uses bounded turn metadata", async () => {
  const adapter: any = Object.create(CodexEngineAdapter.prototype), calls: any[] = [];
  adapter.nativeCore = {}; adapter.nativeSubscribedThreads = new Set();
  adapter.requestPhysical = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === "thread/read") return { thread: { status: { type: "idle" } } };
    if (method === "thread/resume") { assert.equal(params.excludeTurns, true); return {}; }
    if (!params.cursor) return { data: [{ id: "recent", status: "completed" }], nextCursor: "older" };
    return { data: [{ id: "target", status: "failed" }], nextCursor: null };
  };
  assert.equal(await adapter.queueThreadIsIdle("long"), true);
  assert.equal((await adapter.findScheduledTurn("long", "target")).status, "failed");
  assert(calls.filter(c => c.method === "thread/read").every(c => c.params.includeTurns === false));
  assert(calls.filter(c => c.method === "thread/turns/list").every(c => c.params.limit === 100 && c.params.itemsView === "notLoaded"));
});

test("1000 sequential history reads reuse one initialized socket and preserve caller ids", async () => {
  await fixture(async ({ reader, requests, peers, main }) => {
    for (let i = 0; i < 1000; i++) {
      const method = ["thread/read", "thread/turns/list", "thread/items/list"][i % 3]!;
      const response = JSON.parse(await reader.read({ id: i % 2 ? "reused-id" : 7, method, params: { threadId: String(i) } }));
      assert.equal(response.id, i % 2 ? "reused-id" : 7);
      assert.equal(response.result.threadId, String(i));
    }
    assert.equal(requests.filter(r => r.method === "initialize").length, 1);
    assert.equal(new Set(requests.filter(r => r.method?.startsWith("thread/")).map(r => r.id)).size, 1000);
    assert.equal(peers.length, 2, "one history socket plus the separate main socket");
    assert.equal(main.status.state, "open");
  }, { timeoutMs: 2000 });
});

test("pool leases one request per socket and hands queued reads to a free slot", async () => {
  const held: Array<{ message: any; socket: WebSocket }> = [];
  await fixture(async ({ reader, requests }) => {
    const first = reader.read({ id: "first", method: "thread/read", params: { threadId: "held" } });
    const second = reader.read({ id: "second", method: "thread/read", params: { threadId: "held" } });
    const third = reader.read({ id: "third", method: "thread/read", params: { threadId: "queued" } });
    await waitUntil(() => held.length === 2);
    assert.notEqual(held[0]!.socket, held[1]!.socket);
    assert.equal(requests.filter(r => r.params?.threadId === "queued").length, 0);
    for (const { message, socket } of held) socket.send(JSON.stringify({ id: message.id, result: { threadId: "held" } }));
    assert.equal(JSON.parse(await third).result.threadId, "queued");
    await Promise.all([first, second]);
    assert.equal(requests.filter(r => r.method === "initialize").length, 2);
  }, { timeoutMs: 2000, handle(message, socket) {
    if (message.params?.threadId !== "held") return false;
    held.push({ message, socket }); return true;
  } });
});

test("late duplicate replies cannot complete a subsequent request reusing its caller id", async () => {
  let previous: string | undefined;
  await fixture(async ({ reader }) => {
    for (const threadId of ["one", "two", "three"]) {
      const reply = JSON.parse(await reader.read({ id: "same", method: "thread/read", params: { threadId } }));
      assert.equal(reply.id, "same"); assert.equal(reply.result.threadId, threadId);
    }
  }, { handle(message, socket) {
    if (message.method === "initialize") return false;
    if (previous) socket.send(JSON.stringify({ id: previous, result: { threadId: "stale" } }));
    previous = message.id; return false;
  } });
});

test("a malformed reply retires its slot without retrying or closing a healthy peer", async () => {
  await fixture(async ({ reader, requests, main }) => {
    const [bad, good] = await Promise.all([
      reader.read({ id: "bad", method: "thread/read", params: { threadId: "malformed" } }),
      reader.read({ id: "good", method: "thread/read", params: { threadId: "good" } }),
    ]);
    assert.equal(JSON.parse(bad).error.data.code, "HISTORY_READ_UNAVAILABLE");
    assert.equal(JSON.parse(good).result.threadId, "good");
    assert.equal(JSON.parse(await reader.read({ id: "next", method: "thread/read", params: { threadId: "next" } })).result.threadId, "next");
    assert.equal(requests.filter(r => r.params?.threadId === "malformed").length, 1);
    assert.equal(requests.filter(r => r.method === "initialize").length, 2);
    assert.equal(main.status.state, "open");
  }, { handle(message, socket) {
    if (message.params?.threadId !== "malformed") return false;
    socket.send("{bad"); return true;
  } });
});

test("reset fails old in-flight and queued reads; new reads initialize a new incarnation", async () => {
  await fixture(async ({ reader, requests, main }) => {
    const first = reader.read({ id: "same", method: "thread/read", params: { threadId: "slow" } });
    await waitUntil(() => requests.some(r => r.params?.threadId === "slow"));
    const queued = reader.read({ id: "queued", method: "thread/read", params: { threadId: "old-queue" } });
    reader.reset();
    assert.equal(JSON.parse(await first).error.data.code, "HISTORY_READ_UNAVAILABLE");
    assert.equal(JSON.parse(await queued).error.data.code, "HISTORY_READ_UNAVAILABLE");
    const next = JSON.parse(await reader.read({ id: "same", method: "thread/read", params: { threadId: "new" } }));
    assert.equal(next.result.threadId, "new");
    assert(!requests.some(r => r.params?.threadId === "old-queue"));
    assert.equal(requests.filter(r => r.method === "initialize").length, 2);
    assert.equal(main.status.state, "open");
  }, { concurrency: 1, timeoutMs: 1000 });
});

test("queue overflow and expired health create no late sockets or replay", async () => {
  let release!: (endpoint: { nativeSocket: string }) => void;
  let healthCalls = 0;
  const reader = new CodexCoreReadIsolation(() => { healthCalls++; return new Promise(resolve => { release = resolve; }); },
    { maxPayload: 4096, concurrency: 1, queue: 1, timeoutMs: 40 });
  try {
    const active = reader.read({ id: 1, method: "thread/read" });
    const queued = reader.read({ id: 2, method: "thread/read" });
    assert.equal(JSON.parse(await reader.read({ id: 3, method: "thread/read" })).error.data.code, "HISTORY_READ_UNAVAILABLE");
    // Delayed timer delivery must not admit work whose absolute deadline already passed.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 70);
    await Promise.all([active, queued]);
    release({ nativeSocket: "/does-not-exist/late.sock" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(healthCalls, 1, "expired queued work must not run another health request");
  } finally { reader.close(); }
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Fixture event did not arrive");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}


test("disconnect during a read fails once and a subsequent read replaces only that socket", async () => {
  await fixture(async ({ reader, main, requests }) => {
    const failed = JSON.parse(await reader.read({ id: 1, method: "thread/read", params: { threadId: "drop" } }));
    assert.equal(failed.error.data.code, "HISTORY_READ_UNAVAILABLE");
    const next = JSON.parse(await reader.read({ id: 1, method: "thread/read", params: { threadId: "fresh" } }));
    assert.equal(next.result.threadId, "fresh");
    assert.equal(requests.filter(r => r.params?.threadId === "drop").length, 1);
    assert.equal(requests.filter(r => r.method === "initialize").length, 2);
    assert.equal(main.status.state, "open");
  }, { handle(message, socket) {
    if (message.params?.threadId !== "drop") return false;
    socket.terminate(); return true;
  } });
});

test("close while health is pending cannot create a late socket", async () => {
  await fixture(async ({ endpoint, peers }) => {
    let release!: (endpoint: { nativeSocket: string }) => void;
    const reader = new CodexCoreReadIsolation(() => new Promise(resolve => { release = resolve; }));
    const pending = reader.read({ id: 1, method: "thread/read" });
    reader.close();
    assert.equal(JSON.parse(await pending).error.data.code, "HISTORY_READ_UNAVAILABLE");
    const count = peers.length;
    release(endpoint);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(peers.length, count);
    assert.equal(JSON.parse(await reader.read({ id: 2, method: "thread/read" })).error.data.code, "HISTORY_READ_UNAVAILABLE");
  });
});
