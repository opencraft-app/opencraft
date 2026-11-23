// Client DO scenarios (Miniflare via tests/protocol/client-do-workerd.test.ts
// and the real-Cloudflare rehearsal, scripts/cloudflare/rehearsal.ts): one
// Durable Object per authenticated client instance holds the access session,
// subscriptions and per-Thread resume cursors across disconnects, hibernation
// and eviction, while a fake WorkspaceHost DO owns the Thread event logs and
// fans events out by RPC. Miniflare timings are NOT representative of Cloudflare.
// See docs/architecture/platform/gateway-split.md ("Client DO 原型结果").
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  sleep,
  type TestWebSocket,
  type WorkerInstance,
  type WorkerRuntime,
  type WorkerScenario,
  type WorkerSpec,
} from "../../cloudflare/worker-runtime.ts";

export const CLIENT_DO_WORKER: WorkerSpec = {
  id: "client",
  entry: resolve(import.meta.dirname, "client-do-worker.ts"),
  durableObjects: { CLIENT: "ClientDO", WORKSPACE: "WorkspaceHostDO" },
};

const WORKSPACE = "ws-a";
const THREAD = "thread-1";
const KEY = `${WORKSPACE}/${THREAD}`;
let sequence = 0;

/** Scenario wait budgets scale with the runtime that started the instance. */
const patience = new WeakMap<WorkerInstance, number>();
async function start(
  runtime: WorkerRuntime,
  options: { persist?: string; detachMs?: number } = {},
): Promise<WorkerInstance> {
  const worker = await runtime.start(CLIENT_DO_WORKER, {
    vars: { TOKEN_SECRET: "test-secret", DETACH_MS: options.detachMs ?? 60_000 },
    ...(options.persist ? { persist: options.persist } : {}),
  });
  patience.set(worker, runtime.patience);
  return worker;
}

const post = async (worker: WorkerInstance, path: string, body: unknown) =>
  (await worker.fetch(`http://edge${path}`, { method: "POST", body: JSON.stringify(body) })).json();
const token = async (worker: WorkerInstance, clientInstanceId: string, ttlMs = 3_600_000, actorId = "human-1") =>
  (
    await worker.fetch("http://edge/__test/token", {
      method: "POST",
      body: JSON.stringify({ clientInstanceId, actorId, expiresAt: Date.now() + ttlMs }),
    })
  ).text();
const append = (worker: WorkerInstance, event: unknown, thread = THREAD) =>
  post(worker, "/__test/workspace", {
    workspaceId: WORKSPACE,
    method: "append",
    args: [WORKSPACE, thread, event],
  }) as Promise<{ seq: number; outcomes: Record<string, string> }>;
const workspace = (worker: WorkerInstance, method: "stats" | "subscribers", args: unknown[] = []) =>
  post(worker, "/__test/workspace", { workspaceId: WORKSPACE, method, args }) as Promise<any>;
const client = (worker: WorkerInstance, clientInstanceId: string, method: "inspect" | "abort") =>
  post(worker, "/__test/client", { clientInstanceId, method }) as Promise<any>;

type Frame = { type: string; [field: string]: any };

/** A client instance's socket: records frames, optionally acknowledges every event. */
class TestSocket {
  readonly frames: Frame[] = [];
  closed: { code: number; reason: string } | null = null;
  #waiters: (() => void)[] = [];
  constructor(
    readonly socket: TestWebSocket,
    readonly autoAck: boolean,
    readonly patience = 1,
  ) {
    socket.addEventListener("message", (message) => {
      const frame = JSON.parse(String(message.data)) as Frame;
      this.frames.push(frame);
      if (autoAck && frame.type === "thread/event")
        this.send({ type: "event/ack", workspaceId: frame.workspaceId, threadId: frame.threadId, seq: frame.seq });
      this.#wake();
    });
    socket.addEventListener("close", (event) => {
      this.closed = { code: event.code, reason: event.reason };
      this.#wake();
    });
  }
  #wake() {
    for (const waiter of this.#waiters.splice(0)) waiter();
  }
  send(frame: unknown) {
    this.socket.send(JSON.stringify(frame));
  }
  events(thread = THREAD): number[] {
    return this.frames
      .filter((frame) => frame.type === "thread/event" && frame.threadId === thread)
      .map((frame) => frame.seq);
  }
  async until<T>(check: () => T | undefined | false, label: string, timeoutMs = 5_000): Promise<T> {
    const deadline = Date.now() + timeoutMs * this.patience;
    for (;;) {
      const value = check();
      if (value) return value;
      if (Date.now() > deadline)
        assert.fail(`timed out waiting for ${label}; frames: ${JSON.stringify(this.frames.slice(-5))}`);
      await new Promise<void>((done) => {
        this.#waiters.push(done);
        setTimeout(done, 50);
      });
    }
  }
  frame(type: string, from = 0) {
    return this.until(() => this.frames.slice(from).find((frame) => frame.type === type), type);
  }
  async close() {
    this.socket.close(1000, "bye");
    await this.until(() => this.closed, "close");
  }
}

async function connect(
  worker: WorkerInstance,
  bearer: string,
  cursors: Record<string, number> = {},
  autoAck = true,
): Promise<TestSocket> {
  const response = await worker.upgrade("http://edge/apphost", { Authorization: `Bearer ${bearer}` });
  assert.equal(response.status, 101, response.text ?? "");
  const connection = new TestSocket(response.socket!, autoAck, patience.get(worker));
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
const settle = async (worker: WorkerInstance, clientInstanceId: string, seq: number) => {
  // Acks are asynchronous frames; wait until the Client DO has stored them.
  for (let attempt = 0; attempt < 100 * (patience.get(worker) ?? 1); attempt++) {
    const state = await client(worker, clientInstanceId, "inspect");
    if (state.subscriptions.every((subscription: { acked: number }) => subscription.acked >= seq)) return state;
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.fail(`acks for ${clientInstanceId} did not reach ${seq}`);
};

export const CLIENT_DO_SCENARIOS: readonly WorkerScenario[] = [
  {
    name: "the edge rejects missing, forged and expired tokens before reaching a Client DO",
    async run({ runtime }) {
      const worker = await start(runtime);
      try {
        const upgrade = (authorization?: string) =>
          worker.upgrade("http://edge/apphost", authorization ? { Authorization: authorization } : {});
        assert.equal((await upgrade()).status, 401);
        const valid = await token(worker, "client-x");
        const [id, actor, expires] = valid.split(".");
        assert.equal(
          (await upgrade(`Bearer ${id}.human-2.${expires}.${valid.split(".")[3]}`)).status,
          401,
          "actor swapped",
        );
        assert.equal(
          (await upgrade(`Bearer ${id}.${actor}.${Number(expires) + 1}.${valid.split(".")[3]}`)).status,
          401,
          "expiry extended",
        );
        assert.equal((await upgrade(`Bearer ${await token(worker, "client-x", -1)}`)).status, 401, "expired");
      } finally {
        await runtime.stop(worker);
      }
    },
  },
  {
    name: "two Client DOs watching one Thread each receive every event in order; local latency and hops",
    async run({ runtime, diagnostic }) {
      const worker = await start(runtime);
      try {
        const a = await connect(worker, await token(worker, "client-a"));
        const b = await connect(worker, await token(worker, "client-b"));
        await subscribe(a);
        await subscribe(b);
        const count = 50;
        const latencies: number[] = [];
        for (let index = 1; index <= count; index++) {
          const started = performance.now();
          const { seq, outcomes } = await append(worker, { text: `event ${index}` });
          assert.equal(seq, index);
          assert.deepEqual(outcomes, { "client-a": "forwarded", "client-b": "forwarded" });
          await a.until(() => a.events().length >= index, `a #${index}`);
          await b.until(() => b.events().length >= index, `b #${index}`);
          latencies.push(performance.now() - started);
        }
        assert.deepEqual(a.events(), range(1, count));
        assert.deepEqual(b.events(), range(1, count));
        const stats = await workspace(worker, "stats");
        assert.equal(stats.deliverRpcs, count * 2, "one WorkspaceHost → Client DO RPC per viewer per event");
        const clientA = await settle(worker, "client-a", count);
        assert.equal(clientA.counters.deliverCalls, count);
        assert.equal(clientA.counters.pullCalls, 1, "only the initial subscribe read the log; no gap fills");
        latencies.sort((x, y) => x - y);
        const at = (q: number) =>
          latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]!.toFixed(2);
        diagnostic(
          `${runtime.label}: append→both sockets p50=${at(0.5)}ms p95=${at(0.95)}ms max=${at(1)}ms over ${count} events, 2 viewers`,
        );
        diagnostic(
          "RPC hops per event: test→edge→WorkspaceHost 1 (append), WorkspaceHost→ClientDO 1 per viewer (fan-out), ClientDO→socket 0 RPC; steady-state log reads 0",
        );
      } finally {
        await runtime.stop(worker);
      }
    },
  },
  {
    name: "a disconnected client resumes with its cursor and receives exactly the missed events; fan-out to a gone socket is not lost",
    async run({ runtime }) {
      const worker = await start(runtime);
      try {
        const bearer = await token(worker, "client-a");
        const a = await connect(worker, bearer);
        const b = await connect(worker, await token(worker, "client-b"));
        await subscribe(a);
        await subscribe(b);
        for (let index = 1; index <= 5; index++) await append(worker, { index });
        await a.until(() => a.events().length === 5, "a 1..5");
        await settle(worker, "client-a", 5);
        await a.close();

        for (let index = 6; index <= 10; index++) {
          const { outcomes } = await append(worker, { index });
          assert.equal(
            outcomes["client-a"],
            "detached",
            "the Client DO keeps its cursor; the event stays in the WorkspaceHost log",
          );
          assert.equal(outcomes["client-b"], "forwarded");
        }
        const detached = await client(worker, "client-a", "inspect");
        assert.deepEqual(detached.subscriptions, [
          { workspaceId: WORKSPACE, threadId: THREAD, acked: 5, delivered: 5 },
        ]);
        assert.ok(detached.alarm, "a detached client instance has a reclaim alarm");

        const resumed = await connect(worker, bearer, { [KEY]: 5 });
        await resumed.until(() => resumed.events().length === 5, "replay");
        assert.deepEqual(resumed.events(), range(6, 10), "exactly the missed events, replayed before ready");
        assert.ok(
          resumed.frames.findIndex((frame) => frame.type === "client/ready") >
            resumed.frames.findLastIndex((frame) => frame.type === "thread/event"),
        );
        await append(worker, { index: 11 });
        await resumed.until(() => resumed.events().length === 6, "live 11");
        await sleep(100 * runtime.patience);
        assert.deepEqual(resumed.events(), range(6, 11), "no duplicates after going live");
        assert.deepEqual(b.events(), range(1, 11));
      } finally {
        await runtime.stop(worker);
      }
    },
  },
  {
    name: "a cursor between acknowledged and delivered is accepted; stale, forged and unknown cursors are rejected without changing state",
    async run({ runtime }) {
      const worker = await start(runtime);
      try {
        const bearer = await token(worker, "client-c");
        const c = await connect(worker, bearer, {}, false);
        await subscribe(c);
        for (let index = 1; index <= 7; index++) await append(worker, { index });
        await c.until(() => c.events().length === 7, "1..7");
        c.send({ type: "event/ack", workspaceId: WORKSPACE, threadId: THREAD, seq: 5 });
        c.send({ type: "event/ack", workspaceId: WORKSPACE, threadId: THREAD, seq: 9 });
        await c.frame("error");
        assert.equal(
          c.frames.find((frame) => frame.type === "error")!.reason,
          "invalid-ack",
          "an ack beyond what was delivered is refused",
        );
        await settle(worker, "client-c", 5);
        await c.close();
        await append(worker, { index: 8 });

        const probe = await worker.upgrade("http://edge/apphost", { Authorization: `Bearer ${bearer}` });
        const reconnect = new TestSocket(probe.socket!, false, runtime.patience);
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
        assert.deepEqual((await client(worker, "client-c", "inspect")).subscriptions, [
          { workspaceId: WORKSPACE, threadId: THREAD, acked: 5, delivered: 7 },
        ]);
        reconnect.send({ type: "client/hello", v: 1, cursors: { [KEY]: 7 } });
        await reconnect.frame("client/ready");
        assert.deepEqual(
          reconnect.events(),
          [8],
          "received-but-unacknowledged 6..7 are not resent when the client reports 7",
        );
      } finally {
        await runtime.stop(worker);
      }
    },
  },
  {
    name: "a new attachment supersedes the old socket of the same client instance",
    async run({ runtime }) {
      const worker = await start(runtime);
      try {
        const bearer = await token(worker, "client-d");
        const first = await connect(worker, bearer);
        await subscribe(first);
        const second = await connect(worker, bearer, { [KEY]: 0 });
        await first.until(() => first.closed, "superseded close");
        assert.equal(first.closed!.code, 4000);
        await append(worker, { index: 1 });
        await second.until(() => second.events().length === 1, "event on new socket");
        assert.deepEqual(first.events(), []);
      } finally {
        await runtime.stop(worker);
      }
    },
  },
  {
    name: "eviction keeps subscriptions and cursors: aborted instance and restarted runtime on the same storage",
    async run({ runtime }) {
      const persist = `client-evict-${++sequence}`;
      let worker = await start(runtime, { persist });
      const bearer = await token(worker, "client-e");
      try {
        const e = await connect(worker, bearer);
        await subscribe(e);
        for (let index = 1; index <= 3; index++) await append(worker, { index });
        await e.until(() => e.events().length === 3, "1..3");
        await settle(worker, "client-e", 3);

        // In-process eviction: a fresh ClientDO instance on the same storage. workerd
        // ties the hibernatable sockets to the aborted instance, so they close.
        await client(worker, "client-e", "abort");
        await e.until(() => e.closed, "close after abort");
        const afterAbort = await client(worker, "client-e", "inspect");
        assert.deepEqual(afterAbort.counters, { deliverCalls: 0, pullCalls: 0, forwarded: 0 }, "a new instance");
        assert.deepEqual(afterAbort.subscriptions, [
          { workspaceId: WORKSPACE, threadId: THREAD, acked: 3, delivered: 3 },
        ]);
        assert.equal((await append(worker, { index: 4 })).outcomes["client-e"], "detached");
      } finally {
        await runtime.stop(worker);
      }

      worker = await start(runtime, { persist });
      try {
        const restored = await client(worker, "client-e", "inspect");
        assert.equal(restored.session.clientInstanceId, "client-e");
        assert.deepEqual(restored.subscriptions, [
          { workspaceId: WORKSPACE, threadId: THREAD, acked: 3, delivered: 3 },
        ]);
        assert.deepEqual(await workspace(worker, "subscribers", [THREAD]), ["client-e"]);
        await append(worker, { index: 5 });
        const e = await connect(worker, bearer, { [KEY]: 3 });
        await e.until(() => e.events().length === 2, "4..5");
        await append(worker, { index: 6 });
        await e.until(() => e.events().length === 3, "live 6");
        assert.deepEqual(e.events(), [4, 5, 6]);
      } finally {
        await runtime.stop(worker);
      }
    },
  },
  {
    name: "the alarm reclaims an expired client instance and removes its WorkspaceHost subscriptions",
    async run({ runtime }) {
      const worker = await start(runtime);
      try {
        const f = await connect(worker, await token(worker, "client-f", 1_000));
        await subscribe(f);
        assert.deepEqual(await workspace(worker, "subscribers", [THREAD]), ["client-f"]);
        await f.until(() => f.closed, "reclaimed close", 5_000);
        assert.deepEqual(f.closed, { code: 4001, reason: "expired" });
        assert.deepEqual(await workspace(worker, "subscribers", [THREAD]), []);
        const state = await client(worker, "client-f", "inspect");
        assert.equal(state.session, null);
        assert.deepEqual(state.subscriptions, []);
        assert.equal(state.alarm, null);
      } finally {
        await runtime.stop(worker);
      }
    },
  },
  {
    name: "the alarm reclaims a long-disconnected client instance; a later stale cursor is unknown",
    async run({ runtime }) {
      const worker = await start(runtime, { detachMs: 500 });
      try {
        const bearer = await token(worker, "client-g");
        const g = await connect(worker, bearer);
        await subscribe(g);
        await append(worker, { index: 1 });
        await g.until(() => g.events().length === 1, "1");
        await settle(worker, "client-g", 1);
        await g.close();
        for (
          let attempt = 0;
          attempt < 60 * runtime.patience && (await workspace(worker, "subscribers", [THREAD])).length;
          attempt++
        )
          await new Promise((done) => setTimeout(done, 100));
        assert.deepEqual(await workspace(worker, "subscribers", [THREAD]), []);
        assert.deepEqual((await client(worker, "client-g", "inspect")).subscriptions, []);

        const probe = await worker.upgrade("http://edge/apphost", { Authorization: `Bearer ${bearer}` });
        const again = new TestSocket(probe.socket!, true, runtime.patience);
        again.send({ type: "client/hello", v: 1, cursors: { [KEY]: 1 } });
        assert.equal((await again.frame("resume/failed")).failures[0].reason, "unknown-subscription");
      } finally {
        await runtime.stop(worker);
      }
    },
  },
  {
    name: "logout reclaims immediately",
    async run({ runtime }) {
      const worker = await start(runtime);
      try {
        const h = await connect(worker, await token(worker, "client-h"));
        await subscribe(h);
        h.send({ type: "client/logout" });
        await h.until(() => h.closed, "logout close");
        assert.deepEqual(h.closed, { code: 4001, reason: "logout" });
        assert.deepEqual(await workspace(worker, "subscribers", [THREAD]), []);
        assert.equal((await append(worker, { index: 1 })).outcomes["client-h"], undefined);
      } finally {
        await runtime.stop(worker);
      }
    },
  },
];
