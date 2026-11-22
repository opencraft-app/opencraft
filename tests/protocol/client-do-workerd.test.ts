// Client DO prototype in workerd (Miniflare, no Cloudflare account): one
// Durable Object per authenticated client instance holds the access session,
// subscriptions and per-Thread resume cursors across disconnects, hibernation
// and eviction, while a fake WorkspaceHost DO owns the Thread event logs and
// fans events out by RPC. Local timings are NOT representative of Cloudflare.
// See docs/architecture/platform/gateway-split.md ("Client DO 原型结果").
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const COMPATIBILITY_DATE = "2026-07-30";
const WORKSPACE = "ws-a";
const THREAD = "thread-1";
const KEY = `${WORKSPACE}/${THREAD}`;
let directory: string;
let script: string;
const running = new Set<Miniflare>();

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "client-do-workerd-"));
  const outfile = join(directory, "worker.mjs");
  await build({
    entryPoints: [resolve(import.meta.dirname, "workerd/client-do-worker.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    mainFields: ["module", "main"],
    conditions: ["workerd", "worker", "import"],
    external: ["cloudflare:*"],
    logLevel: "silent",
  });
  script = await readFile(outfile, "utf8");
});
after(async () => {
  for (const miniflare of running) await miniflare.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function start(options: { persist?: string; detachMs?: number } = {}): Miniflare {
  const miniflare = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.mjs", contents: script }],
    compatibilityDate: COMPATIBILITY_DATE,
    durableObjects: {
      CLIENT: { className: "ClientDO", useSQLite: true },
      WORKSPACE: { className: "WorkspaceHostDO", useSQLite: true },
    },
    bindings: { TOKEN_SECRET: "test-secret", DETACH_MS: options.detachMs ?? 60_000 },
    ...(options.persist ? { durableObjectsPersist: options.persist } : {}),
  });
  running.add(miniflare);
  return miniflare;
}
async function stop(miniflare: Miniflare) {
  running.delete(miniflare);
  await miniflare.dispose();
}

const post = async (miniflare: Miniflare, path: string, body: unknown) =>
  (await miniflare.dispatchFetch(`http://edge${path}`, { method: "POST", body: JSON.stringify(body) })).json();
const token = async (miniflare: Miniflare, clientInstanceId: string, ttlMs = 3_600_000, actorId = "human-1") =>
  (await miniflare.dispatchFetch("http://edge/__test/token", { method: "POST", body: JSON.stringify({ clientInstanceId, actorId, expiresAt: Date.now() + ttlMs }) })).text();
const append = (miniflare: Miniflare, event: unknown, thread = THREAD) =>
  post(miniflare, "/__test/workspace", { workspaceId: WORKSPACE, method: "append", args: [WORKSPACE, thread, event] }) as Promise<{ seq: number; outcomes: Record<string, string> }>;
const workspace = (miniflare: Miniflare, method: "stats" | "subscribers", args: unknown[] = []) =>
  post(miniflare, "/__test/workspace", { workspaceId: WORKSPACE, method, args }) as Promise<any>;
const client = (miniflare: Miniflare, clientInstanceId: string, method: "inspect" | "abort") =>
  post(miniflare, "/__test/client", { clientInstanceId, method }) as Promise<any>;

type Frame = { type: string; [field: string]: any };

/** A client instance's socket: records frames, optionally acknowledges every event. */
class TestSocket {
  readonly frames: Frame[] = [];
  closed: { code: number; reason: string } | null = null;
  #waiters: (() => void)[] = [];
  constructor(readonly socket: any, readonly autoAck: boolean) {
    socket.addEventListener("message", (message: { data: string }) => {
      const frame = JSON.parse(message.data) as Frame;
      this.frames.push(frame);
      if (autoAck && frame.type === "thread/event") this.send({ type: "event/ack", workspaceId: frame.workspaceId, threadId: frame.threadId, seq: frame.seq });
      this.#wake();
    });
    socket.addEventListener("close", (event: { code: number; reason: string }) => { this.closed = { code: event.code, reason: event.reason }; this.#wake(); });
  }
  #wake() { for (const waiter of this.#waiters.splice(0)) waiter(); }
  send(frame: unknown) { this.socket.send(JSON.stringify(frame)); }
  events(thread = THREAD): number[] { return this.frames.filter(frame => frame.type === "thread/event" && frame.threadId === thread).map(frame => frame.seq); }
  async until<T>(check: () => T | undefined | false, label: string, timeoutMs = 5_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = check();
      if (value) return value;
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}; frames: ${JSON.stringify(this.frames.slice(-5))}`);
      await new Promise<void>(done => { this.#waiters.push(done); setTimeout(done, 50); });
    }
  }
  frame(type: string, from = 0) { return this.until(() => this.frames.slice(from).find(frame => frame.type === type), type); }
  async close() { this.socket.close(1000, "bye"); await this.until(() => this.closed, "close"); }
}

async function connect(miniflare: Miniflare, bearer: string, cursors: Record<string, number> = {}, autoAck = true): Promise<TestSocket> {
  const response = await miniflare.dispatchFetch("http://edge/apphost", { headers: { Upgrade: "websocket", Authorization: `Bearer ${bearer}` } });
  assert.equal(response.status, 101, await response.text().catch(() => ""));
  const socket = response.webSocket!;
  socket.accept();
  const connection = new TestSocket(socket, autoAck);
  connection.send({ type: "client/hello", v: 1, cursors });
  await connection.frame("client/ready");
  return connection;
}
async function subscribe(connection: TestSocket, after = 0, thread = THREAD) {
  const from = connection.frames.length;
  connection.send({ type: "thread/subscribe", workspaceId: WORKSPACE, threadId: thread, after });
  await connection.frame("thread/subscribed", from);
}
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
const settle = async (miniflare: Miniflare, clientInstanceId: string, seq: number) => {
  // Acks are asynchronous frames; wait until the Client DO has stored them.
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await client(miniflare, clientInstanceId, "inspect");
    if (state.subscriptions.every((subscription: { acked: number }) => subscription.acked >= seq)) return state;
    await new Promise(done => setTimeout(done, 20));
  }
  assert.fail(`acks for ${clientInstanceId} did not reach ${seq}`);
};

test("the edge rejects missing, forged and expired tokens before reaching a Client DO", async () => {
  const miniflare = start();
  try {
    const upgrade = (authorization?: string) => miniflare.dispatchFetch("http://edge/apphost", {
      headers: { Upgrade: "websocket", ...(authorization ? { Authorization: authorization } : {}) },
    });
    assert.equal((await upgrade()).status, 401);
    const valid = await token(miniflare, "client-x");
    const [id, actor, expires] = valid.split(".");
    assert.equal((await upgrade(`Bearer ${id}.human-2.${expires}.${valid.split(".")[3]}`)).status, 401, "actor swapped");
    assert.equal((await upgrade(`Bearer ${id}.${actor}.${Number(expires) + 1}.${valid.split(".")[3]}`)).status, 401, "expiry extended");
    assert.equal((await upgrade(`Bearer ${await token(miniflare, "client-x", -1)}`)).status, 401, "expired");
  } finally { await stop(miniflare); }
});

test("two Client DOs watching one Thread each receive every event in order; local latency and hops", async t => {
  const miniflare = start();
  try {
    const a = await connect(miniflare, await token(miniflare, "client-a"));
    const b = await connect(miniflare, await token(miniflare, "client-b"));
    await subscribe(a);
    await subscribe(b);
    const count = 50;
    const latencies: number[] = [];
    for (let index = 1; index <= count; index++) {
      const started = performance.now();
      const { seq, outcomes } = await append(miniflare, { text: `event ${index}` });
      assert.equal(seq, index);
      assert.deepEqual(outcomes, { "client-a": "forwarded", "client-b": "forwarded" });
      await a.until(() => a.events().length >= index, `a #${index}`);
      await b.until(() => b.events().length >= index, `b #${index}`);
      latencies.push(performance.now() - started);
    }
    assert.deepEqual(a.events(), range(1, count));
    assert.deepEqual(b.events(), range(1, count));
    const stats = await workspace(miniflare, "stats");
    assert.equal(stats.deliverRpcs, count * 2, "one WorkspaceHost → Client DO RPC per viewer per event");
    const clientA = await settle(miniflare, "client-a", count);
    assert.equal(clientA.counters.deliverCalls, count);
    assert.equal(clientA.counters.pullCalls, 1, "only the initial subscribe read the log; no gap fills");
    latencies.sort((x, y) => x - y);
    const at = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]!.toFixed(2);
    t.diagnostic(`LOCAL workerd/Miniflare only, not representative of Cloudflare: append→both sockets p50=${at(0.5)}ms p95=${at(0.95)}ms max=${at(1)}ms over ${count} events, 2 viewers`);
    t.diagnostic("RPC hops per event: test→edge→WorkspaceHost 1 (append), WorkspaceHost→ClientDO 1 per viewer (fan-out), ClientDO→socket 0 RPC; steady-state log reads 0");
  } finally { await stop(miniflare); }
});

test("a disconnected client resumes with its cursor and receives exactly the missed events; fan-out to a gone socket is not lost", async () => {
  const miniflare = start();
  try {
    const bearer = await token(miniflare, "client-a");
    const a = await connect(miniflare, bearer);
    const b = await connect(miniflare, await token(miniflare, "client-b"));
    await subscribe(a);
    await subscribe(b);
    for (let index = 1; index <= 5; index++) await append(miniflare, { index });
    await a.until(() => a.events().length === 5, "a 1..5");
    await settle(miniflare, "client-a", 5);
    await a.close();

    for (let index = 6; index <= 10; index++) {
      const { outcomes } = await append(miniflare, { index });
      assert.equal(outcomes["client-a"], "detached", "the Client DO keeps its cursor; the event stays in the WorkspaceHost log");
      assert.equal(outcomes["client-b"], "forwarded");
    }
    const detached = await client(miniflare, "client-a", "inspect");
    assert.deepEqual(detached.subscriptions, [{ workspaceId: WORKSPACE, threadId: THREAD, acked: 5, delivered: 5 }]);
    assert.ok(detached.alarm, "a detached client instance has a reclaim alarm");

    const resumed = await connect(miniflare, bearer, { [KEY]: 5 });
    await resumed.until(() => resumed.events().length === 5, "replay");
    assert.deepEqual(resumed.events(), range(6, 10), "exactly the missed events, replayed before ready");
    assert.ok(resumed.frames.findIndex(frame => frame.type === "client/ready") > resumed.frames.findLastIndex(frame => frame.type === "thread/event"));
    await append(miniflare, { index: 11 });
    await resumed.until(() => resumed.events().length === 6, "live 11");
    await new Promise(done => setTimeout(done, 100));
    assert.deepEqual(resumed.events(), range(6, 11), "no duplicates after going live");
    assert.deepEqual(b.events(), range(1, 11));
  } finally { await stop(miniflare); }
});

test("a cursor between acknowledged and delivered is accepted; stale, forged and unknown cursors are rejected without changing state", async () => {
  const miniflare = start();
  try {
    const bearer = await token(miniflare, "client-c");
    const c = await connect(miniflare, bearer, {}, false);
    await subscribe(c);
    for (let index = 1; index <= 7; index++) await append(miniflare, { index });
    await c.until(() => c.events().length === 7, "1..7");
    c.send({ type: "event/ack", workspaceId: WORKSPACE, threadId: THREAD, seq: 5 });
    c.send({ type: "event/ack", workspaceId: WORKSPACE, threadId: THREAD, seq: 9 });
    await c.frame("error");
    assert.equal(c.frames.find(frame => frame.type === "error")!.reason, "invalid-ack", "an ack beyond what was delivered is refused");
    await settle(miniflare, "client-c", 5);
    await c.close();
    await append(miniflare, { index: 8 });

    const probe = await miniflare.dispatchFetch("http://edge/apphost", { headers: { Upgrade: "websocket", Authorization: `Bearer ${bearer}` } });
    const socket = probe.webSocket!;
    socket.accept();
    const reconnect = new TestSocket(socket, false);
    for (const [cursors, reason] of [
      [{ [KEY]: 3 }, "stale"],
      [{ [KEY]: 8 }, "forged"],
      [{ [`${WORKSPACE}/thread-x`]: 0 }, "unknown-subscription"],
    ] as const) {
      const from = reconnect.frames.length;
      reconnect.send({ type: "client/hello", v: 1, cursors });
      const failed = await reconnect.frame("resume/failed", from);
      assert.equal(failed.failures[0].reason, reason);
    }
    reconnect.send({ type: "client/hello", v: 2, cursors: {} });
    await reconnect.frame("error");
    assert.deepEqual((await client(miniflare, "client-c", "inspect")).subscriptions, [{ workspaceId: WORKSPACE, threadId: THREAD, acked: 5, delivered: 7 }]);
    reconnect.send({ type: "client/hello", v: 1, cursors: { [KEY]: 7 } });
    await reconnect.frame("client/ready");
    assert.deepEqual(reconnect.events(), [8], "received-but-unacknowledged 6..7 are not resent when the client reports 7");
  } finally { await stop(miniflare); }
});

test("a new attachment supersedes the old socket of the same client instance", async () => {
  const miniflare = start();
  try {
    const bearer = await token(miniflare, "client-d");
    const first = await connect(miniflare, bearer);
    await subscribe(first);
    const second = await connect(miniflare, bearer, { [KEY]: 0 });
    await first.until(() => first.closed, "superseded close");
    assert.equal(first.closed!.code, 4000);
    await append(miniflare, { index: 1 });
    await second.until(() => second.events().length === 1, "event on new socket");
    assert.deepEqual(first.events(), []);
  } finally { await stop(miniflare); }
});

test("eviction keeps subscriptions and cursors: aborted instance and restarted runtime on the same storage", async () => {
  const persist = join(directory, "evict");
  let miniflare = start({ persist });
  const bearer = await token(miniflare, "client-e");
  try {
    const e = await connect(miniflare, bearer);
    await subscribe(e);
    for (let index = 1; index <= 3; index++) await append(miniflare, { index });
    await e.until(() => e.events().length === 3, "1..3");
    await settle(miniflare, "client-e", 3);

    // In-process eviction: a fresh ClientDO instance on the same storage. workerd
    // ties the hibernatable sockets to the aborted instance, so they close.
    await client(miniflare, "client-e", "abort");
    await e.until(() => e.closed, "close after abort");
    const afterAbort = await client(miniflare, "client-e", "inspect");
    assert.deepEqual(afterAbort.counters, { deliverCalls: 0, pullCalls: 0, forwarded: 0 }, "a new instance");
    assert.deepEqual(afterAbort.subscriptions, [{ workspaceId: WORKSPACE, threadId: THREAD, acked: 3, delivered: 3 }]);
    assert.equal((await append(miniflare, { index: 4 })).outcomes["client-e"], "detached");
  } finally { await stop(miniflare); }

  miniflare = start({ persist });
  try {
    const restored = await client(miniflare, "client-e", "inspect");
    assert.equal(restored.session.clientInstanceId, "client-e");
    assert.deepEqual(restored.subscriptions, [{ workspaceId: WORKSPACE, threadId: THREAD, acked: 3, delivered: 3 }]);
    assert.deepEqual(await workspace(miniflare, "subscribers", [THREAD]), ["client-e"]);
    await append(miniflare, { index: 5 });
    const e = await connect(miniflare, bearer, { [KEY]: 3 });
    await e.until(() => e.events().length === 2, "4..5");
    await append(miniflare, { index: 6 });
    await e.until(() => e.events().length === 3, "live 6");
    assert.deepEqual(e.events(), [4, 5, 6]);
  } finally { await stop(miniflare); }
});

test("the alarm reclaims an expired client instance and removes its WorkspaceHost subscriptions", async () => {
  const miniflare = start();
  try {
    const f = await connect(miniflare, await token(miniflare, "client-f", 1_000));
    await subscribe(f);
    assert.deepEqual(await workspace(miniflare, "subscribers", [THREAD]), ["client-f"]);
    await f.until(() => f.closed, "reclaimed close", 5_000);
    assert.deepEqual(f.closed, { code: 4001, reason: "expired" });
    assert.deepEqual(await workspace(miniflare, "subscribers", [THREAD]), []);
    const state = await client(miniflare, "client-f", "inspect");
    assert.equal(state.session, null);
    assert.deepEqual(state.subscriptions, []);
    assert.equal(state.alarm, null);
  } finally { await stop(miniflare); }
});

test("the alarm reclaims a long-disconnected client instance; a later stale cursor is unknown", async () => {
  const miniflare = start({ detachMs: 500 });
  try {
    const bearer = await token(miniflare, "client-g");
    const g = await connect(miniflare, bearer);
    await subscribe(g);
    await append(miniflare, { index: 1 });
    await g.until(() => g.events().length === 1, "1");
    await settle(miniflare, "client-g", 1);
    await g.close();
    for (let attempt = 0; attempt < 60 && (await workspace(miniflare, "subscribers", [THREAD])).length; attempt++)
      await new Promise(done => setTimeout(done, 100));
    assert.deepEqual(await workspace(miniflare, "subscribers", [THREAD]), []);
    assert.deepEqual((await client(miniflare, "client-g", "inspect")).subscriptions, []);

    const probe = await miniflare.dispatchFetch("http://edge/apphost", { headers: { Upgrade: "websocket", Authorization: `Bearer ${bearer}` } });
    probe.webSocket!.accept();
    const again = new TestSocket(probe.webSocket, true);
    again.send({ type: "client/hello", v: 1, cursors: { [KEY]: 1 } });
    assert.equal((await again.frame("resume/failed")).failures[0].reason, "unknown-subscription");
  } finally { await stop(miniflare); }
});

test("logout reclaims immediately", async () => {
  const miniflare = start();
  try {
    const h = await connect(miniflare, await token(miniflare, "client-h"));
    await subscribe(h);
    h.send({ type: "client/logout" });
    await h.until(() => h.closed, "logout close");
    assert.deepEqual(h.closed, { code: 4001, reason: "logout" });
    assert.deepEqual(await workspace(miniflare, "subscribers", [THREAD]), []);
    assert.equal((await append(miniflare, { index: 1 })).outcomes["client-h"], undefined);
  } finally { await stop(miniflare); }
});
