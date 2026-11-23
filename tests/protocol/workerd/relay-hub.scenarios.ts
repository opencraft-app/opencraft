// RelayHub scenarios (Miniflare via tests/protocol/relay-hub-workerd.test.ts
// and the real-Cloudflare rehearsal, scripts/cloudflare/rehearsal.ts): one
// RelayHubDO per installation owns the outbound Headless control link, stream
// reservations (10 s, alarm-expired) and the 512 active+connecting stream
// budget, replacing the Node relay's Redis leases and inter-node forwarding.
// The fake Headless below follows plugins/relay-connect: it parses opens with
// the shared `parseOpen`, dials DATA_PATH with the stream id and token, and
// echoes bytes. Miniflare timings are LOCAL-ONLY and not representative of Cloudflare.
// See docs/architecture/platform/cloudflare-deployment.md ("RelayHub 原型结果").
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import {
  CONTROL_PATH,
  DATA_PATH,
  MAX_RELAY_STREAMS,
  RELAY_PROTOCOL,
  STREAM_HEADER,
  parseOpen,
} from "@opencraft/relay-protocol";
import type {
  TestWebSocket,
  WorkerInstance,
  WorkerRuntime,
  WorkerScenario,
  WorkerSpec,
} from "../../cloudflare/worker-runtime.ts";

export const RELAY_HUB_WORKER: WorkerSpec = {
  id: "relay",
  entry: resolve(import.meta.dirname, "relay-hub-worker.ts"),
  durableObjects: { RELAY: "RelayHubDO" },
};

const credential = () => randomBytes(32).toString("base64url");
const INSTALLATIONS = {
  "inst-a": { credential: credential(), host: "inst-a.relay.test" },
  "inst-b": { credential: credential(), host: "inst-b.relay.test" },
};
/**
 * Wait budgets scale with the runtime of the instance started last: scenarios
 * run one at a time (node:test runs a file's tests in order; so does the rehearsal).
 */
let scale = 1;

async function start(runtime: WorkerRuntime, options: { reservationMs?: number } = {}): Promise<WorkerInstance> {
  const worker = await runtime.start(RELAY_HUB_WORKER, {
    vars: {
      INSTALLATIONS: JSON.stringify(INSTALLATIONS),
      ROUTE_KEY: "test-route-key",
      ...(options.reservationMs ? { RESERVATION_MS: options.reservationMs } : {}),
    },
  });
  scale = runtime.patience;
  return worker;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until<T>(
  check: () => T | undefined | false | Promise<T | undefined | false>,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs * scale;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

/** One accepted WebSocket; records frames and its close. */
class Socket {
  readonly messages: (string | ArrayBuffer)[] = [];
  closed: { code: number; reason: string } | null = null;
  onMessage?: (data: string | ArrayBuffer) => void;
  constructor(readonly socket: TestWebSocket) {
    socket.addEventListener("message", (event) => {
      this.messages.push(event.data);
      this.onMessage?.(event.data);
    });
    socket.addEventListener("close", (event) => {
      this.closed = { code: event.code, reason: event.reason };
    });
  }
  get open() {
    return this.closed === null;
  }
  send(data: string | ArrayBuffer | Uint8Array) {
    this.socket.send(data);
  }
  close(code = 1000, reason = "bye") {
    this.socket.close(code, reason);
  }
  waitClosed(label: string) {
    return until(() => this.closed ?? undefined, `${label} close`);
  }
}

async function upgrade(worker: WorkerInstance, url: string, headers: Record<string, string> = {}) {
  const response = await worker.upgrade(url, headers);
  return {
    status: response.status,
    socket: response.socket ? new Socket(response.socket) : undefined,
    text: response.text,
  };
}

/** The outbound Headless side, shaped like plugins/relay-connect (control + data dials + echo target). */
class FakeHeadless {
  readonly streams = new Map<string, Socket>();
  opens = 0;
  lastOpen?: { id: string; token: string };
  mode: "accept" | "ignore" = "accept";
  control!: Socket;
  constructor(
    readonly worker: WorkerInstance,
    readonly installation: keyof typeof INSTALLATIONS,
  ) {}
  async connect() {
    const { status, socket } = await upgrade(this.worker, `http://relay.test${CONTROL_PATH}`, {
      authorization: `Bearer ${INSTALLATIONS[this.installation].credential}`,
      "sec-websocket-protocol": RELAY_PROTOCOL,
    });
    assert.equal(status, 101, "control link accepted");
    this.control = socket!;
    const control = socket!;
    control.onMessage = (raw) => {
      const frame = parseOpen(JSON.parse(String(raw)));
      this.opens++;
      this.lastOpen = frame;
      if (this.mode === "ignore" || control !== this.control) return; // Headless-side discard: the reservation must expire.
      void this.dial(frame.id, frame.token);
    };
    return this;
  }
  async dial(id: string, token: string) {
    const { status, socket } = await upgrade(this.worker, `http://relay.test${DATA_PATH}`, {
      authorization: `Bearer ${token}`,
      [STREAM_HEADER]: id,
      "sec-websocket-protocol": RELAY_PROTOCOL,
    });
    if (status !== 101) return status;
    this.streams.set(id, socket!);
    socket!.onMessage = (data) => {
      if (socket!.open) socket!.send(data);
    }; // echo target
    return status;
  }
  openStreams() {
    return [...this.streams.values()].filter((s) => s.open).length;
  }
}

const openClient = (
  worker: WorkerInstance,
  installation: keyof typeof INSTALLATIONS = "inst-a",
  path = "/app/socket",
) => upgrade(worker, `http://${INSTALLATIONS[installation].host}${path}`);
const inspect = async (worker: WorkerInstance, installation = "inst-a") =>
  (await worker.fetch(`http://relay.test/__test/inspect?installation=${installation}`)).json() as Promise<any>;
async function echo(client: Socket, text: string) {
  const from = client.messages.length;
  const arrived = new Promise<void>((done) => {
    client.onMessage = () => done();
  });
  client.send(text);
  await Promise.race([arrived, sleep(5_000 * scale)]);
  client.onMessage = undefined;
  return until(() => client.messages.length > from && client.messages[from], `echo of ${text}`);
}

export const RELAY_HUB_SCENARIOS: readonly WorkerScenario[] = [
  {
    name: "a client stream opens through the installation's RelayHubDO, round-trips bytes and closes both ends",
    async run({ runtime }) {
      const worker = await start(runtime);
      const headless = await new FakeHeadless(worker, "inst-a").connect();
      const client = await openClient(worker);
      assert.equal(client.status, 101);
      assert.equal(headless.opens, 1, "one open on the control link");
      const id = await until(() => [...headless.streams.keys()][0], "Headless data dial");
      assert.match(id!, /^[0-9a-f-]{36}$/u, "stream ids keep the relay-protocol shape");
      assert.equal(await echo(client.socket!, "hello relay"), "hello relay");
      const bytes = new Uint8Array([0, 1, 2, 254, 255]);
      const from = client.socket!.messages.length;
      client.socket!.send(bytes.buffer);
      const binary = await until(() => client.socket!.messages[from], "binary echo");
      assert.deepEqual(new Uint8Array(binary as ArrayBuffer), bytes, "binary frames pass unchanged");
      assert.deepEqual((await inspect(worker)).active, 1);

      client.socket!.close(1000, "done");
      const data = headless.streams.get(id!)!;
      assert.equal((await data.waitClosed("data")).code, 1000, "the Headless data socket closes with the client");
      await until(async () => (await inspect(worker)).active === 0, "stream slot released");

      // Installation isolation: inst-b has no control link, so it is unavailable; inst-a is unaffected.
      assert.equal((await openClient(worker, "inst-b")).status, 503);
      assert.equal(
        (await openClient(worker, "inst-a", "/__opencraft_update/apply")).status,
        403,
        "relay paths are never business routes",
      );
      assert.equal(
        (
          await upgrade(worker, `http://relay.test${DATA_PATH}`, {
            authorization: `Bearer ${credential()}`,
            [STREAM_HEADER]: id!,
            "sec-websocket-protocol": RELAY_PROTOCOL,
          })
        ).status,
        401,
        "a used or forged token is rejected",
      );
      assert.equal(headless.control.open, true);
    },
  },
  {
    name: "budget exhaustion rejects new opens without closing the control link, and frees after a close",
    async run({ runtime }) {
      // 512 client upgrades plus 512 Headless dials all start from this one driver process. Against
      // a deployed worker every handshake is a new outbound TLS connection, and a driver behind an
      // egress proxy opens them far slower than workerd admits them (about 50/s measured in the
      // rehearsal sandbox), so late dials would miss the 10 s reservation and be refused as expired.
      // The deadline itself is asserted by the reservation scenario; here it scales with patience.
      const worker = await start(runtime, runtime.patience > 1 ? { reservationMs: 10_000 * runtime.patience } : {});
      const headless = await new FakeHeadless(worker, "inst-a").connect();
      const clients = await Promise.all(Array.from({ length: MAX_RELAY_STREAMS }, () => openClient(worker)));
      const statuses: Record<string, number> = {};
      for (const c of clients) {
        const key = `${c.status}${c.text ? ` ${c.text.slice(0, 80)}` : ""}`;
        statuses[key] = (statuses[key] ?? 0) + 1;
      }
      if (!clients.every((c) => c.status === 101)) {
        const { openTimeouts, rejectedInstance, rejectedTokens } = await inspect(worker);
        assert.fail(
          `the full budget is admitted: ${JSON.stringify(statuses)}; openTimeouts ${openTimeouts}, rejectedInstance ${rejectedInstance}, rejectedTokens ${rejectedTokens}, opens ${headless.opens}`,
        );
      }
      await until(() => headless.openStreams() === MAX_RELAY_STREAMS, "all data streams");
      const opensAtCapacity = headless.opens;

      const overflow = await openClient(worker);
      assert.equal(overflow.status, 503, "the excess open is refused");
      await sleep(75 * scale);
      assert.equal(headless.opens, opensAtCapacity, "no open is sent beyond the budget");
      assert.equal(headless.control.open, true, "capacity is not a protocol violation");
      const state = await inspect(worker);
      assert.equal(state.active, MAX_RELAY_STREAMS);
      assert.equal(state.rejectedInstance, 1);
      assert.equal(state.replacedControls, 0, "no hidden control reconnect");
      const survivor = clients[1]!.socket!;
      assert.equal(await echo(survivor, "still connected"), "still connected", "existing traffic still flows");

      clients[0]!.socket!.close(1000, "release");
      await until(async () => (await inspect(worker)).active === MAX_RELAY_STREAMS - 1, "slot released");
      const replacement = await openClient(worker);
      assert.equal(replacement.status, 101, "a later open is admitted once a stream closed");
      assert.equal(await echo(replacement.socket!, "replacement"), "replacement");
      for (const c of [...clients, replacement]) if (c.socket?.open) c.socket.close();
    },
  },
  {
    name: "a reservation the Headless discards expires via the DO alarm and frees its slot",
    async run({ runtime }) {
      // Default timing: the reservation carries the Node relay's 10 s deadline.
      const real = await start(runtime);
      const discarding = await new FakeHeadless(real, "inst-a").connect();
      discarding.mode = "ignore";
      const pending = openClient(real);
      pending.catch(() => {});
      const reserved = await until(async () => {
        const s = await inspect(real);
        return s.reservations === 1 && s;
      }, "reservation");
      assert.equal(reserved.reservationMs, 10_000);
      assert.ok(
        reserved.reservationDeadlines[0] > 9_000 && reserved.reservationDeadlines[0] <= 10_000,
        "10 s reservation deadline",
      );
      assert.ok(typeof reserved.alarm === "number", "an alarm owns the deadline");
      // Short timing (RESERVATION_MS=300 binding) proves the alarm path without a 10 s wait.
      const worker = await start(runtime, { reservationMs: 300 });
      const headless = await new FakeHeadless(worker, "inst-a").connect();
      headless.mode = "ignore";
      const started = Date.now();
      const expired = await openClient(worker);
      const elapsed = Date.now() - started;
      assert.equal(expired.status, 503, "the waiting client is refused at expiry");
      assert.ok(elapsed >= 250 && elapsed < 5_000, `expired after ${elapsed} ms`);
      const state = await inspect(worker);
      assert.equal(state.reservations, 0);
      assert.equal(state.openTimeouts, 1);
      assert.equal(headless.control.open, true, "expiry does not touch the control link");
      assert.equal(
        await headless.dial(headless.lastOpen!.id, headless.lastOpen!.token),
        401,
        "a late dial for the expired reservation is refused",
      );
      headless.mode = "accept";
      assert.equal((await openClient(worker)).status, 101, "the slot is free again");
      await runtime.stop(real);
      await pending.catch(() => {});
    },
  },
  {
    name: "a malformed control message closes the link with 1008 and retires its streams",
    async run({ runtime }) {
      const worker = await start(runtime);
      const headless = await new FakeHeadless(worker, "inst-a").connect();
      const client = await openClient(worker);
      assert.equal(client.status, 101);
      headless.control.send("{invalid");
      assert.equal((await headless.control.waitClosed("control")).code, 1008);
      assert.equal(
        (await client.socket!.waitClosed("client")).code,
        1008,
        "client streams of the violating link are closed",
      );
      const state = await inspect(worker);
      assert.equal(state.controls, 0);
      assert.equal(state.active, 0);
      assert.equal(state.controlViolations, 1);
      assert.equal((await openClient(worker)).status, 503, "no control link, no new streams");
    },
  },
  {
    name: "a reconnecting control link replaces the old one and closes the old link's streams",
    async run({ runtime }) {
      const worker = await start(runtime);
      const first = await new FakeHeadless(worker, "inst-a").connect();
      const old = await openClient(worker);
      assert.equal(old.status, 101);
      const second = await new FakeHeadless(worker, "inst-a").connect();
      assert.equal((await old.socket!.waitClosed("old stream")).code, 1012, "streams of the replaced link are closed");
      const fresh = await openClient(worker);
      assert.equal(fresh.status, 101);
      assert.equal(second.opens, 1, "new opens go to the new link only");
      assert.equal(first.opens, 1);
      assert.equal(await echo(fresh.socket!, "via second"), "via second");
      const state = await inspect(worker);
      assert.equal(state.generation, 2);
      assert.equal(state.controls, 1);
      assert.equal(state.active, 1);
      assert.equal(state.replacedControls, 1);
      // The old link's close handshake completes in the DO (its webSocketClose ran) ...
      assert.equal(
        (
          await until(async () => {
            const s = await inspect(worker);
            return s.controlCloses === 1 && s;
          }, "old control close handshake")
        ).controls,
        1,
      );
      // ... but local workerd releases the TCP connection of a hibernatable socket closed from another
      // event context only when the object hibernates, and open streams keep it awake; the ws client
      // therefore reports the close after its own 30 s closeTimeout at the latest. Not awaited here; see the doc.
    },
  },
  {
    name: "throughput and latency (labelled per runtime; Miniflare figures are local-only, NOT Cloudflare)",
    async run({ runtime, diagnostic }) {
      const worker = await start(runtime);
      await new FakeHeadless(worker, "inst-a").connect();
      const opens: number[] = [];
      for (let i = 0; i < 30; i++) {
        const t = performance.now();
        const c = await openClient(worker);
        opens.push(performance.now() - t);
        c.socket!.close();
      }
      const client = (await openClient(worker)).socket!;
      const rtts: number[] = [];
      for (let i = 0; i < 300; i++) {
        const t = performance.now();
        await echo(client, `ping-${i}`);
        rtts.push(performance.now() - t);
      }
      const chunk = new Uint8Array(16_384).fill(7),
        total = 8 * 1024 * 1024;
      let received = 0;
      const from = client.messages.length;
      const t = performance.now();
      for (let sent = 0; sent < total; sent += chunk.byteLength) client.send(chunk);
      await until(
        () => {
          for (const m of client.messages.splice(from)) received += (m as ArrayBuffer).byteLength;
          return received >= total;
        },
        "bulk echo",
        60_000,
      );
      const seconds = (performance.now() - t) / 1000;
      const pct = (values: number[], p: number) =>
        [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]!.toFixed(2);
      diagnostic(
        `${runtime.label}: stream open p50=${pct(opens, 0.5)}ms p95=${pct(opens, 0.95)}ms; ` +
          `echo RTT p50=${pct(rtts, 0.5)}ms p99=${pct(rtts, 0.99)}ms; bulk echo ${((2 * total) / 1024 / 1024 / seconds).toFixed(1)} MiB/s through the DO (8 MiB each way, 16 KiB frames)`,
      );
      assert.equal(received, total);
      client.close();
    },
  },
];
