// RelayHub prototype in workerd (Miniflare, no Cloudflare account): one
// RelayHubDO per installation owns the outbound Headless control link, stream
// reservations (10 s, alarm-expired) and the 512 active+connecting stream
// budget, replacing the Node relay's Redis leases and inter-node forwarding.
// The fake Headless below follows plugins/relay-connect: it parses opens with
// the shared `parseOpen`, dials DATA_PATH with the stream id and token, and
// echoes bytes. Timings are LOCAL-ONLY and not representative of Cloudflare.
// See docs/architecture/platform/cloudflare-deployment.md ("RelayHub 原型结果").
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { CONTROL_PATH, DATA_PATH, MAX_RELAY_STREAMS, RELAY_PROTOCOL, STREAM_HEADER, parseOpen } from "@opencraft/relay-protocol";

const COMPATIBILITY_DATE = "2026-07-30";
const credential = () => randomBytes(32).toString("base64url");
const INSTALLATIONS = { "inst-a": { credential: credential(), host: "inst-a.relay.test" }, "inst-b": { credential: credential(), host: "inst-b.relay.test" } };
let directory: string;
let script: string;
const running = new Set<Miniflare>();

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "relay-hub-workerd-"));
  const outfile = join(directory, "worker.mjs");
  await build({
    entryPoints: [resolve(import.meta.dirname, "workerd/relay-hub-worker.ts")],
    outfile, bundle: true, format: "esm", platform: "neutral", target: "es2023",
    mainFields: ["module", "main"], conditions: ["workerd", "worker", "import"], external: ["cloudflare:*"], logLevel: "silent",
  });
  script = await readFile(outfile, "utf8");
});
after(async () => {
  for (const miniflare of running) await miniflare.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function start(options: { reservationMs?: number } = {}): Miniflare {
  const miniflare = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.mjs", contents: script }],
    compatibilityDate: COMPATIBILITY_DATE,
    durableObjects: { RELAY: { className: "RelayHubDO", useSQLite: true } },
    bindings: { INSTALLATIONS: JSON.stringify(INSTALLATIONS), ROUTE_KEY: "test-route-key",
      ...(options.reservationMs ? { RESERVATION_MS: options.reservationMs } : {}) },
  });
  running.add(miniflare);
  return miniflare;
}

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
async function until<T>(check: () => T | undefined | false | Promise<T | undefined | false>, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

/** One accepted WebSocket from Miniflare; records frames and its close. */
class Socket {
  readonly messages: (string | ArrayBuffer)[] = [];
  closed: { code: number; reason: string } | null = null;
  onMessage?: (data: string | ArrayBuffer) => void;
  constructor(readonly socket: any) {
    socket.accept();
    socket.addEventListener("message", (event: { data: string | ArrayBuffer }) => { this.messages.push(event.data); this.onMessage?.(event.data); });
    socket.addEventListener("close", (event: { code: number; reason: string }) => { this.closed = { code: event.code, reason: event.reason }; });
  }
  get open() { return this.closed === null; }
  send(data: string | ArrayBuffer | Uint8Array) { this.socket.send(data); }
  close(code = 1000, reason = "bye") { this.socket.close(code, reason); }
  waitClosed(label: string) { return until(() => this.closed, `${label} close`); }
}

async function upgrade(miniflare: Miniflare, url: string, headers: Record<string, string> = {}) {
  const response = await miniflare.dispatchFetch(url, { headers: { upgrade: "websocket", ...headers } });
  return { status: response.status, socket: response.webSocket ? new Socket(response.webSocket) : undefined, response };
}

/** The outbound Headless side, shaped like plugins/relay-connect (control + data dials + echo target). */
class FakeHeadless {
  readonly streams = new Map<string, Socket>();
  opens = 0;
  lastOpen?: { id: string; token: string };
  mode: "accept" | "ignore" = "accept";
  control!: Socket;
  constructor(readonly miniflare: Miniflare, readonly installation: keyof typeof INSTALLATIONS) {}
  async connect() {
    const { status, socket } = await upgrade(this.miniflare, `http://relay.test${CONTROL_PATH}`, {
      authorization: `Bearer ${INSTALLATIONS[this.installation].credential}`, "sec-websocket-protocol": RELAY_PROTOCOL });
    assert.equal(status, 101, "control link accepted");
    this.control = socket!;
    const control = socket!;
    control.onMessage = raw => {
      const frame = parseOpen(JSON.parse(String(raw)));
      this.opens++; this.lastOpen = frame;
      if (this.mode === "ignore" || control !== this.control) return; // Headless-side discard: the reservation must expire.
      void this.dial(frame.id, frame.token);
    };
    return this;
  }
  async dial(id: string, token: string) {
    const { status, socket } = await upgrade(this.miniflare, `http://relay.test${DATA_PATH}`, {
      authorization: `Bearer ${token}`, [STREAM_HEADER]: id, "sec-websocket-protocol": RELAY_PROTOCOL });
    if (status !== 101) return status;
    this.streams.set(id, socket!);
    socket!.onMessage = data => { if (socket!.open) socket!.send(data); }; // echo target
    return status;
  }
  openStreams() { return [...this.streams.values()].filter(s => s.open).length; }
}

const openClient = (miniflare: Miniflare, installation: keyof typeof INSTALLATIONS = "inst-a", path = "/app/socket") =>
  upgrade(miniflare, `http://${INSTALLATIONS[installation].host}${path}`);
const inspect = async (miniflare: Miniflare, installation = "inst-a") =>
  (await miniflare.dispatchFetch(`http://relay.test/__test/inspect?installation=${installation}`)).json() as Promise<any>;
async function echo(client: Socket, text: string) {
  const from = client.messages.length;
  const arrived = new Promise<void>(done => { client.onMessage = () => done(); });
  client.send(text);
  await Promise.race([arrived, sleep(5_000)]);
  client.onMessage = undefined;
  return until(() => client.messages.length > from && client.messages[from], `echo of ${text}`);
}

test("a client stream opens through the installation's RelayHubDO, round-trips bytes and closes both ends", async () => {
  const miniflare = start();
  const headless = await new FakeHeadless(miniflare, "inst-a").connect();
  const client = await openClient(miniflare);
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
  assert.deepEqual((await inspect(miniflare)).active, 1);

  client.socket!.close(1000, "done");
  const data = headless.streams.get(id!)!;
  assert.equal((await data.waitClosed("data")).code, 1000, "the Headless data socket closes with the client");
  await until(async () => (await inspect(miniflare)).active === 0, "stream slot released");

  // Installation isolation: inst-b has no control link, so it is unavailable; inst-a is unaffected.
  assert.equal((await openClient(miniflare, "inst-b")).status, 503);
  assert.equal((await openClient(miniflare, "inst-a", "/__opencraft_update/apply")).status, 403, "relay paths are never business routes");
  assert.equal((await upgrade(miniflare, `http://relay.test${DATA_PATH}`, { authorization: `Bearer ${credential()}`, [STREAM_HEADER]: id!, "sec-websocket-protocol": RELAY_PROTOCOL })).status, 401, "a used or forged token is rejected");
  assert.equal(headless.control.open, true);
});

test("budget exhaustion rejects new opens without closing the control link, and frees after a close", async () => {
  const miniflare = start();
  const headless = await new FakeHeadless(miniflare, "inst-a").connect();
  const clients = await Promise.all(Array.from({ length: MAX_RELAY_STREAMS }, () => openClient(miniflare)));
  assert.ok(clients.every(c => c.status === 101), "the full budget is admitted");
  await until(() => headless.openStreams() === MAX_RELAY_STREAMS, "all data streams");
  const opensAtCapacity = headless.opens;

  const overflow = await openClient(miniflare);
  assert.equal(overflow.status, 503, "the excess open is refused");
  await sleep(75);
  assert.equal(headless.opens, opensAtCapacity, "no open is sent beyond the budget");
  assert.equal(headless.control.open, true, "capacity is not a protocol violation");
  const state = await inspect(miniflare);
  assert.equal(state.active, MAX_RELAY_STREAMS);
  assert.equal(state.rejectedInstance, 1);
  assert.equal(state.replacedControls, 0, "no hidden control reconnect");
  const survivor = clients[1]!.socket!;
  assert.equal(await echo(survivor, "still connected"), "still connected", "existing traffic still flows");

  clients[0]!.socket!.close(1000, "release");
  await until(async () => (await inspect(miniflare)).active === MAX_RELAY_STREAMS - 1, "slot released");
  const replacement = await openClient(miniflare);
  assert.equal(replacement.status, 101, "a later open is admitted once a stream closed");
  assert.equal(await echo(replacement.socket!, "replacement"), "replacement");
  for (const c of [...clients, replacement]) if (c.socket?.open) c.socket.close();
});

test("a reservation the Headless discards expires via the DO alarm and frees its slot", async () => {
  // Default timing: the reservation carries the Node relay's 10 s deadline.
  const real = start();
  const discarding = await new FakeHeadless(real, "inst-a").connect();
  discarding.mode = "ignore";
  const pending = openClient(real);
  pending.catch(() => {});
  const reserved = await until(async () => { const s = await inspect(real); return s.reservations === 1 && s; }, "reservation");
  assert.equal(reserved.reservationMs, 10_000);
  assert.ok(reserved.reservationDeadlines[0] > 9_000 && reserved.reservationDeadlines[0] <= 10_000, "10 s reservation deadline");
  assert.ok(typeof reserved.alarm === "number", "an alarm owns the deadline");
  // Short timing (RESERVATION_MS=300 binding) proves the alarm path without a 10 s wait.
  const miniflare = start({ reservationMs: 300 });
  const headless = await new FakeHeadless(miniflare, "inst-a").connect();
  headless.mode = "ignore";
  const started = Date.now();
  const expired = await openClient(miniflare);
  const elapsed = Date.now() - started;
  assert.equal(expired.status, 503, "the waiting client is refused at expiry");
  assert.ok(elapsed >= 250 && elapsed < 5_000, `expired after ${elapsed} ms`);
  const state = await inspect(miniflare);
  assert.equal(state.reservations, 0);
  assert.equal(state.openTimeouts, 1);
  assert.equal(headless.control.open, true, "expiry does not touch the control link");
  assert.equal(await headless.dial(headless.lastOpen!.id, headless.lastOpen!.token), 401, "a late dial for the expired reservation is refused");
  headless.mode = "accept";
  assert.equal((await openClient(miniflare)).status, 101, "the slot is free again");
  running.delete(real);
  await real.dispose();
  await pending.catch(() => {});
});

test("a malformed control message closes the link with 1008 and retires its streams", async () => {
  const miniflare = start();
  const headless = await new FakeHeadless(miniflare, "inst-a").connect();
  const client = await openClient(miniflare);
  assert.equal(client.status, 101);
  headless.control.send("{invalid");
  assert.equal((await headless.control.waitClosed("control")).code, 1008);
  assert.equal((await client.socket!.waitClosed("client")).code, 1008, "client streams of the violating link are closed");
  const state = await inspect(miniflare);
  assert.equal(state.controls, 0);
  assert.equal(state.active, 0);
  assert.equal(state.controlViolations, 1);
  assert.equal((await openClient(miniflare)).status, 503, "no control link, no new streams");
});

test("a reconnecting control link replaces the old one and closes the old link's streams", async () => {
  const miniflare = start();
  const first = await new FakeHeadless(miniflare, "inst-a").connect();
  const old = await openClient(miniflare);
  assert.equal(old.status, 101);
  const second = await new FakeHeadless(miniflare, "inst-a").connect();
  assert.equal((await old.socket!.waitClosed("old stream")).code, 1012, "streams of the replaced link are closed");
  const fresh = await openClient(miniflare);
  assert.equal(fresh.status, 101);
  assert.equal(second.opens, 1, "new opens go to the new link only");
  assert.equal(first.opens, 1);
  assert.equal(await echo(fresh.socket!, "via second"), "via second");
  const state = await inspect(miniflare);
  assert.equal(state.generation, 2);
  assert.equal(state.controls, 1);
  assert.equal(state.active, 1);
  assert.equal(state.replacedControls, 1);
  // The old link's close handshake completes in the DO (its webSocketClose ran) ...
  assert.equal((await until(async () => { const s = await inspect(miniflare); return s.controlCloses === 1 && s; }, "old control close handshake")).controls, 1);
  // ... but local workerd releases the TCP connection of a hibernatable socket closed from another
  // event context only when the object hibernates, and open streams keep it awake; the ws client
  // therefore reports the close after its own 30 s closeTimeout at the latest. Not awaited here; see the doc.
});

test("local-only throughput and latency (Miniflare on this machine, NOT Cloudflare)", async () => {
  const miniflare = start();
  await new FakeHeadless(miniflare, "inst-a").connect();
  const opens: number[] = [];
  for (let i = 0; i < 30; i++) {
    const t = performance.now();
    const c = await openClient(miniflare);
    opens.push(performance.now() - t);
    c.socket!.close();
  }
  const client = (await openClient(miniflare)).socket!;
  const rtts: number[] = [];
  for (let i = 0; i < 300; i++) {
    const t = performance.now();
    await echo(client, `ping-${i}`);
    rtts.push(performance.now() - t);
  }
  const chunk = new Uint8Array(16_384).fill(7), total = 8 * 1024 * 1024;
  let received = 0;
  const from = client.messages.length;
  const t = performance.now();
  for (let sent = 0; sent < total; sent += chunk.byteLength) client.send(chunk);
  await until(() => { for (const m of client.messages.splice(from)) received += (m as ArrayBuffer).byteLength; return received >= total; }, "bulk echo", 60_000);
  const seconds = (performance.now() - t) / 1000;
  const pct = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]!.toFixed(2);
  console.log(`[relay-hub LOCAL-ONLY, Miniflare/workerd, not Cloudflare] stream open p50=${pct(opens, 0.5)}ms p95=${pct(opens, 0.95)}ms; ` +
    `echo RTT p50=${pct(rtts, 0.5)}ms p99=${pct(rtts, 0.99)}ms; bulk echo ${(2 * total / 1024 / 1024 / seconds).toFixed(1)} MiB/s through the DO (8 MiB each way, 16 KiB frames)`);
  assert.equal(received, total);
  client.close();
});
