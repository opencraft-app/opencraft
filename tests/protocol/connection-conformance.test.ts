import assert from "node:assert/strict";
import test from "node:test";
import { AppHostServer } from "@opencraft/app-host-server";
import { MessagePortAppHostClient } from "@opencraft/app-host-client";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { ConnectionLifecycleOwner } from "../../packages/workbench-runtime/src/connection-lifecycle";

// Independent observable specification: no imports of owner transitions, retry
// helpers or Runtime projections. Each event is replayed through both adapters.
type Event = "connect" | "ack" | "loss" | "manual" | "retry" | "deadline" | "stable" | "late" | "freeze" | "dispose";
class Specification {
  phase = "idle"; failures = 0; error = false; stable = false; expired = false;
  constructor(private readonly stageMs = 30_000) {}
  step(event: Event) {
    if (this.phase === "disposed") return;
    if (event === "dispose") { this.phase = "disposed"; this.error = false; return; }
    if (event === "connect") {
      if (this.phase !== "usable" && this.phase !== "attempting") { this.phase = "attempting"; this.error = false; this.expired = false; }
    } else if (event === "freeze" && this.phase === "attempting") this.expired = true;
    else if (event === "ack" && this.phase === "attempting") {
      if (this.expired) { this.phase = "backoff"; this.error = true; this.failures++; }
      else { this.phase = "usable"; this.error = false; this.stable = true; }
    }
    else if (event === "manual" && ["attempting", "usable"].includes(this.phase)) { this.phase = "blocked"; this.error = true; }
    else if ((event === "loss" && ["attempting", "usable"].includes(this.phase)) || event === "deadline") {
      this.phase = "backoff"; this.error = true; this.failures++;
    } else if (event === "retry") { this.phase = "attempting"; this.error = false; this.expired = false; }
    else if (event === "stable") { this.failures = 0; this.stable = false; }
  }
  timers() {
    return this.phase === "attempting" ? [this.stageMs] : this.phase === "usable" ? this.stable ? [7_000] : []
      : this.phase === "backoff" ? [[2, 4, 8][Math.min(this.failures - 1, 2)]!] : [];
  }
}
function clock() {
  let now = 0;
  const timers = new Map<object, { callback(): void; delay: number }>();
  const retired: (() => void)[] = [];
  return { timers, retired, now: () => now,
    setTimeout(callback: () => void, delay: number) { const id = {}; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id: unknown) { const timer = timers.get(id as object); if (timer) retired.push(timer.callback); timers.delete(id as object); },
    freeze() { now += 300_000; },
    fire(delay: number) { const entry = [...timers].find(([, timer]) => timer.delay === delay); assert.ok(entry, `missing timer ${delay}`); timers.delete(entry[0]); now += delay; entry[1].callback(); },
  };
}
class Physical {
  status: any = { state: "idle" }; statuses = new Set<any>(); messages = new Set<any>(); requests: any[] = [];
  async connect() { this.publish({ state: "open" }); }
  async send(frame: string) { const request = JSON.parse(frame); if (request.method === "initialize") this.requests.push(request); }
  ack() { for (const request of this.requests.splice(0)) for (const listener of this.messages) listener(JSON.stringify({ jsonrpc: "2.0", id: request.id,
    result: { codexHome: "/tmp/conformance", platformFamily: "unix", platformOs: "linux", userAgent: "conformance" } })); }
  publish(status: any) { this.status = status; for (const listener of this.statuses) listener(status); }
  subscribeMessage(listener: any) { this.messages.add(listener); return () => this.messages.delete(listener); }
  subscribeStatus(listener: any) { this.statuses.add(listener); return () => this.statuses.delete(listener); }
  async close() { this.publish({ state: "closed" }); }
}
function ports() {
  const renderer = new Set<any>(), server = new Set<any>(); let closed = false;
  return {
    browser: { postMessage(message: any) { queueMicrotask(() => { if (!closed) for (const f of server) f(message); }); }, addEventListener(_type: any, f: any) { renderer.add(f); }, removeEventListener(_type: any, f: any) { renderer.delete(f); }, start() {}, close() { closed = true; } },
    host: { postMessage(message: any) { queueMicrotask(() => { if (!closed) for (const f of renderer) f({ data: message }); }); }, subscribe(f: any) { server.add(f); return () => server.delete(f); }, start() {}, close() { closed = true; } },
  };
}
const flush = async () => { for (let n = 0; n < 4; n++) await new Promise<void>(resolve => setImmediate(resolve)); };
async function adapter(kind: "owner" | "runtime" | "apphost") {
  const time = clock();
  if (kind === "owner") {
    let resolve: ((value: object) => void) | undefined;
    const old: (() => void)[] = [];
    const owner = new ConnectionLifecycleOwner({ clock: time, stableMs: 7_000, delaysMs: [2, 4, 8],
      run: () => new Promise<object>(done => { resolve = done; old.push(() => done({})); }), valid: () => true,
      invalidate() {}, changed() {}, usable() {}, backoff() {}, manual: () => false });
    return { time, connect: () => owner.connect(), ack: () => resolve?.({}),
      loss: (manual = false) => owner.lost(Error("synthetic loss"), manual),
      late: () => old.slice(0, -1).forEach(callback => callback()),
      state: () => ({ phase: owner.snapshot.phase, error: !!owner.snapshot.error }), dispose: async () => owner.dispose(), close: async () => {} };
  }
  const physical: Physical[] = [];
  const factory = () => { const value = new Physical(); physical.push(value); return value; };
  const server = new AppHostServer({ createTransport: factory }); const pair = ports();
  const connection = server.accept(pair.host, "conformance"); const host = new MessagePortAppHostClient(pair.browser, "conformance");
  const runtime = createAppServerWorkbenchRuntime({ hostId: "conformance", createTransport: kind === "runtime" ? factory : () => host.createTransport("conformance"),
    clock: time, reconnectStableMs: 7_000, reconnectDelaysMs: [2, 4, 8] });
  return { time, connect: () => runtime.connect(), ack: () => physical.at(-1)?.ack(),
    loss: (manual = false) => physical.at(-1)?.publish({ state: "failed", reason: "synthetic loss",
      ...(manual ? { failure: { code: "synthetic-manual", recovery: "manual" } } : {}) }),
    late: () => { for (const p of physical.slice(0, -1)) { p.ack(); p.publish({ state: "failed", reason: "late cleanup" }); } },
    state: () => { const s = runtime.getSnapshot(); return { phase: s.phase === "ready" ? "usable" : s.phase === "error" ? "blocked"
      : s.phase === "connecting" ? "attempting" : s.phase === "reconnecting" ? s.error ? "backoff" : "attempting" : s.phase, error: !!s.error }; },
    dispose: () => runtime.dispose(), close: async () => { host.close(); connection.close(); await server.close(); } };
}
function trace(seed: number) {
  const model = new Specification(); const events: Event[] = [];
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (let i = 0; i < 64; i++) {
    const choices: Event[] = model.phase === "idle" || model.phase === "blocked" ? ["connect", "late", "freeze"]
      : model.phase === "attempting" ? ["ack", "loss", "manual", "deadline", "connect", "late", "freeze"]
      : model.phase === "usable" ? ["loss", "manual", ...(model.stable ? ["stable" as const] : []), "connect", "late", "freeze"]
      : ["retry", "connect", "late", "freeze"];
    const event = choices[random() % choices.length]!; events.push(event); model.step(event);
  }
  return [...events, "dispose", "late"] as Event[];
}
for (const kind of ["owner", "runtime", "apphost"] as const) test(`model trace conformance through ${kind}, including suspended clocks and late callbacks`, { timeout: 60_000 }, async () => {
  for (let seed = 1; seed <= 24; seed++) {
    const model = new Specification(kind === "owner" ? 30_000 : 35_000), actual = await adapter(kind); const history: Event[] = [];
    try {
      for (const event of trace(seed)) {
        history.push(event); const before = model.phase;
        const retryDelay = model.timers()[0];
        if (event === "connect") void actual.connect().catch(() => {});
        else if (event === "ack") actual.ack();
        else if (event === "loss" || event === "manual") actual.loss(event === "manual");
        else if (event === "deadline" || event === "stable" || event === "retry") actual.time.fire(retryDelay!);
        else if (event === "late") { actual.late(); for (const callback of actual.time.retired.splice(0)) callback(); }
        else if (event === "freeze") actual.time.freeze();
        else if (event === "dispose") await actual.dispose();
        model.step(event); await flush();
        // Runtime deliberately retains its last public snapshot after disposal.
        if (model.phase === "disposed" && kind !== "owner") { assert.equal(actual.time.timers.size, 0); continue; }
        const where = `${kind} seed=${seed} before=${before} trace=${history.join(",")}`;
        assert.deepEqual(actual.state(), { phase: model.phase, error: model.error }, where);
        assert.deepEqual([...actual.time.timers.values()].map(timer => timer.delay).sort((a, b) => a - b), model.timers(), where);
      }
    } finally { await actual.dispose(); await actual.close(); }
  }
});
