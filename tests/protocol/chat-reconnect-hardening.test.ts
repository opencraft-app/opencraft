import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { retryDelayMs, wasEstablished, RECONNECT_DELAYS_MS, ESTABLISHED_CONNECTION_MS } from "../../packages/workbench-runtime/src/retry-schedule";
import { ConnectionLifecycleOwner } from "../../packages/workbench-runtime/src/connection-lifecycle";
import { relayIdleDeadline } from "../../packages/relay-protocol/src/node";
import { connectWebSocketAppHost, type AppHostRecoveryEvents } from "../../apps/workbench-web/src/runtime/websocket-app-host";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("retry schedule: exact explicit schedules, bounded jitter, established threshold", () => {
  assert.equal(retryDelayMs(0, { schedule: [7, 9] }), 7);
  assert.equal(retryDelayMs(5, { schedule: [7, 9] }), 9);
  assert.equal(retryDelayMs(0, { random: () => 0 }), Math.round(RECONNECT_DELAYS_MS[0]! * 0.8));
  assert.equal(retryDelayMs(99, { random: () => 1 }), Math.round(RECONNECT_DELAYS_MS.at(-1)! * 1.2));
  assert.equal(retryDelayMs(2, { jitter: false }), RECONNECT_DELAYS_MS[2]);
  assert.equal(wasEstablished(null, 1e9), false);
  assert.equal(wasEstablished(0, ESTABLISHED_CONNECTION_MS - 1), false);
  assert.equal(wasEstablished(0, ESTABLISHED_CONNECTION_MS), true);
});

function lifecycle() {
  let now = 0, seq = 0;
  const timers = new Map<number, { run(): void; delay: number }>();
  const runs: { resolve(binding: object): void }[] = [];
  const backoffs: number[] = [];
  const owner = new ConnectionLifecycleOwner<object>({
    clock: { now: () => now, setTimeout(run, delay) { const id = ++seq; timers.set(id, { run, delay }); return id; },
      clearTimeout(id) { timers.delete(id as number); } },
    delaysMs: [500, 1_000, 2_000, 5_000],
    run: () => new Promise(resolve => runs.push({ resolve })),
    valid: () => true, invalidate: () => {}, changed: () => {}, usable: () => {}, manual: () => false,
    backoff: (_, ms) => backoffs.push(ms),
  });
  const fire = async (delay: number) => {
    const entry = [...timers].find(([, t]) => t.delay === delay);
    assert.ok(entry, `missing ${delay}ms timer`);
    timers.delete(entry[0]); entry[1].run(); await tick();
  };
  return { owner, runs, backoffs, fire, advance(ms: number) { now += ms; } };
}

test("losing an established connection restarts backoff; flapping still escalates", async () => {
  const f = lifecycle();
  const first = f.owner.connect(); await tick(); f.runs[0]!.resolve({}); await first;
  f.owner.lost(new Error("refused")); // usable for 0ms: a flap
  assert.deepEqual(f.backoffs, [500]);
  await f.fire(500); f.runs[1]!.resolve({}); await tick();
  f.owner.lost(new Error("flap again"));
  assert.deepEqual(f.backoffs, [500, 1_000], "short-lived routes escalate");
  await f.fire(1_000); f.runs[2]!.resolve({}); await tick();
  f.advance(ESTABLISHED_CONNECTION_MS);
  f.owner.lost(new Error("dropped after working"));
  assert.deepEqual(f.backoffs, [500, 1_000, 500], "an established route restarts from the first delay");
  f.owner.dispose();
});

test("relay idle deadline resets on traffic in either direction and has no absolute lifetime", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const socket = Object.assign(new EventEmitter(), { sent: 0, send(this: { sent: number }) { this.sent++; } });
  let expired = 0;
  const cancel = relayIdleDeadline(socket as never, () => { expired++; }, 1_000);
  for (let i = 0; i < 10; i++) {
    context.mock.timers.tick(900);
    if (i % 2) socket.emit("message", Buffer.from("x")); else (socket as unknown as { send(): void }).send();
  }
  assert.equal(expired, 0, "nine seconds of steady traffic never expires a one-second idle bound");
  context.mock.timers.tick(1_000);
  assert.equal(expired, 1);
  cancel();
});

class FakeSocket {
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly listeners = new Map<string, Set<(event: { data?: string; code?: number }) => void>>();
  addEventListener(type: string, listener: (event: { data?: string; code?: number }) => void): void {
    let set = this.listeners.get(type); if (!set) this.listeners.set(type, set = new Set()); set.add(listener);
  }
  send(frame: string): void { this.sent.push(JSON.parse(frame)); }
  close(code = 1000): void { this.readyState = 3; this.emit("close", { code }); }
  open(): void { this.readyState = 1; this.emit("open"); }
  receive(message: unknown): void { this.emit("message", { data: JSON.stringify(message) }); }
  private emit(type: string, event: { data?: string; code?: number } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}
class Events implements AppHostRecoveryEvents {
  visible = true;
  listeners = new Set<(reason?: string) => void>();
  isVisible = () => this.visible;
  subscribe(listener: (reason?: string) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  fire(visible: boolean, reason: string) { this.visible = visible; for (const listener of this.listeners) listener(reason); }
}

async function heartbeatRoute(context: test.TestContext, heartbeatMs: number | undefined) {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let now = 1_000_000;
  context.mock.method(Date, "now", () => now);
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test/" } } });
  context.after(() => { if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else delete (globalThis as { window?: unknown }).window; });
  const socket = new FakeSocket(), events = new Events();
  const failures: string[] = [];
  const client = connectWebSocketAppHost(() => socket as unknown as WebSocket, {
    recoveryEvents: events, retryDelaysMs: [60_000], reportFailure: diagnostic => failures.push(diagnostic.failure),
  });
  const transport = client.createTransport("chat-host"), connected = transport.connect();
  await tick(); socket.open();
  socket.receive({ type: "ready", protocolVersion: 2, services: ["appserver"],
    capabilities: { connectionProbe: true, ...(heartbeatMs === undefined ? {} : { heartbeatMs }) } });
  await tick();
  const connect = socket.sent.find(message => message.type === "host/connect")!;
  socket.receive({ type: "response", requestId: connect.requestId, ok: true, result: { hostId: "chat-host", generation: 1 } });
  await connected;
  const advance = async (ms: number) => { for (let left = ms; left > 0; left -= 1_000) { now += 1_000; context.mock.timers.tick(1_000); } await tick(); };
  const probes = () => socket.sent.filter(message => message.type === "connection/probe");
  return { socket, events, transport, failures, advance, probes, close: () => client.close() };
}

test("hello opts into heartbeats and heartbeat frames never reach the App Host client", async context => {
  const route = await heartbeatRoute(context, 10_000);
  assert.equal(route.socket.sent.find(message => message.type === "hello")?.heartbeat, true);
  for (let i = 0; i < 12; i++) { await route.advance(10_000); route.socket.receive({ type: "connection/heartbeat" }); }
  assert.equal(route.transport.status.state, "open", "two minutes of regular heartbeats keep the route");
  assert.equal(route.probes().length, 0, "a heartbeat route sends no periodic legacy probes");
  assert.deepEqual(route.failures, []);
  route.close();
});

test("a silent visible heartbeat route is declared dead within ~30s, not minutes", async context => {
  const route = await heartbeatRoute(context, 10_000);
  await route.advance(25_000);
  assert.equal(route.probes().length, 0, "not suspect before 2.5 intervals");
  await route.advance(5_000);
  assert.equal(route.probes().length, 1, "suspect: one short liveness probe");
  await route.advance(5_000);
  assert.deepEqual(route.failures, ["liveness-timeout"]);
  assert.equal(route.transport.status.state, "failed");
  route.close();
});

test("an answered liveness probe keeps the route", async context => {
  const route = await heartbeatRoute(context, 10_000);
  await route.advance(30_000);
  const probe = route.probes().at(-1)!;
  route.socket.receive({ type: "response", requestId: probe.requestId, ok: true, result: null });
  await route.advance(4_000);
  assert.equal(route.transport.status.state, "open");
  assert.deepEqual(route.failures, []);
  route.close();
});

test("hidden time is not counted; returning to foreground validates a silent route immediately", async context => {
  const route = await heartbeatRoute(context, 10_000);
  route.events.fire(false, "visibilitychange");
  await route.advance(120_000);
  assert.equal(route.probes().length, 0, "a hidden page never spends liveness checks");
  assert.equal(route.transport.status.state, "open");
  route.events.fire(true, "visibilitychange");
  await route.advance(1_000);
  assert.equal(route.probes().length, 1, "foreground immediately probes a route silent for 2 minutes");
  await route.advance(5_000);
  assert.deepEqual(route.failures, ["liveness-timeout"], "and replaces it within five seconds when dead");
  route.close();
});

test("servers without heartbeat keep the legacy probe model", async context => {
  const route = await heartbeatRoute(context, undefined);
  assert.equal(route.socket.sent.find(message => message.type === "hello")?.heartbeat, true);
  await route.advance(40_000);
  assert.equal(route.transport.status.state, "open", "no liveness verdict without a negotiated heartbeat");
  assert.deepEqual(route.failures, []);
  route.close();
});

test("exponentialBackoffMs reproduces every migrated hand-written schedule exactly", async () => {
  const { exponentialBackoffMs } = await import("../../packages/workbench-runtime/src/retry-schedule");
  const cases: Array<[(n: number) => number, number, number]> = [
    [n => Math.min(10000, 250 * 2 ** Math.min(n, 6)), 250, 10_000],
    [n => Math.min(5000, 250 * 2 ** Math.min(n, 5)), 250, 5_000],
    [n => Math.min(30000, 250 * 2 ** Math.min(n, 7)), 250, 30_000],
    [n => Math.min(5000, 250 * 2 ** n), 250, 5_000],
    [n => Math.min(15000, 400 * 2 ** Math.min(n, 6)), 400, 15_000],
    [n => Math.min(30_000, 1_000 * 2 ** Math.min(n, 5)), 1_000, 30_000],
    [n => Math.min(60000, 5000 * 2 ** Math.min(n, 4)), 5_000, 60_000],
    [n => Math.min(60000, 2000 * 2 ** Math.min(n, 5)), 2_000, 60_000],
    [n => Math.min(60000, 10000 * 2 ** Math.min(3, n)), 10_000, 60_000],
    [n => Math.min(30_000, 2_000 * 2 ** n), 2_000, 30_000],
  ];
  for (const [original, initialMs, maxMs] of cases)
    for (let n = 0; n <= 2000; n++) assert.equal(exponentialBackoffMs(n, { initialMs, maxMs }), original(n), `${initialMs}/${maxMs} @${n}`);
  for (let failures = 1; failures <= 4; failures++)
    assert.equal(exponentialBackoffMs(failures - 1, { initialMs: 200, maxMs: 1_600 }), 200 * 2 ** (failures - 1));
  assert.equal(exponentialBackoffMs(Infinity, { initialMs: 1, maxMs: 7 }), 7);
  assert.equal(exponentialBackoffMs(-3, { initialMs: 5, maxMs: 7 }), 5);
});
