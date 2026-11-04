import { operatorLeaseClaim } from "../../scripts/full-upgrade/operator-lease.mjs";
const operatorLease = await operatorLeaseClaim(30000);
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { coldHomeValidator } from "../../apps/codex-core/src/generation-cold-home.js";
import { CodexGenerationRuntime } from "../../apps/codex-core/src/generation-runtime.js";
import type { GenerationRecord } from "../../apps/codex-core/src/generation-registry.js";
import type { GenerationSupervisor } from "../../apps/codex-core/src/generation-supervisor.js";
import { nativeHistoryFailures } from "../../apps/codex-core/src/native-history-read.js";

async function fixture(retainedFailure = false, supportedReader = true) {
  const root = await mkdtemp(join(tmpdir(), "oc-hold-"));
  const error = { code: -32600, message: "Synthetic historical rejection" };
  const manifest = nativeHistoryFailures({ version: 1, failures: retainedFailure ? [{ generationId: "old", threadId: "bad", reads: [false, true].map(includeTurns => ({ includeTurns, code: error.code, errorSha256: createHash("sha256").update(JSON.stringify(error)).digest("hex") })) }] : [] });
  const processes = new Map<string, { socket: string; close(): Promise<void> }>(), stops: string[] = [], calls: { id: string; method: string; params: any }[] = [];
  let mode = "exact", onQuiet = async () => {}, duringHistory = () => {};
  const supervisor: GenerationSupervisor = {
    async start(g) {
      if (!processes.has(g.id)) {
        const server = createServer(), ws = new WebSocketServer({ server }), socket = join(dirname(g.endpoint), "native.sock");
        ws.on("connection", client => client.on("message", raw => {
          const m = JSON.parse(String(raw)); calls.push({ id: g.id, method: m.method, params: m.params }); if (m.id === undefined) return;
          if (g.id === "old" && m.method === "thread/read") duringHistory();
          let response: any = { result: ["thread/list", "thread/loaded/list"].includes(m.method) ? { data: m.method === "thread/loaded/list" && mode === "loaded" ? ["bad"] : [] } : m.method === "thread/read" ? { thread: { id: m.params.threadId, status: { type: "idle" } } } : {} };
          if (m.method === "thread/read" && (retainedFailure && m.params.threadId === "bad" && mode !== "success" || mode === "extra" && m.params.threadId === "good")) {
            response = { error: mode === "code" ? { ...error, code: -32601 } : mode === "message" ? { ...error, message: "Different" } : mode === "second" && m.params.includeTurns ? { ...error, code: -32601 } : error };
          }
          client.send(JSON.stringify({ id: m.id, ...response }));
        }));
        await new Promise<void>(r => server.listen(socket, r));
        processes.set(g.id, { socket, async close() { for (const client of ws.clients) client.terminate(); await new Promise<void>(r => ws.close(() => r())); await new Promise<void>(r => server.close(() => r())); } });
      }
      return { protocolVersion: 1, pid: 10, codexPid: 20, dataDirectory: root, proxyBaseUrl: "http://127.0.0.1:1", codexHome: join(g.runtimeDataDirectory, "runtime"), nativeSocket: processes.get(g.id)!.socket, callbackProtocolVersion: 1, pendingCallbacks: 0, pendingOrchestrationMutations: 0 };
    },
    async inspect(g) { return this.start(g); },
    async identify(g) { return { ownerPid: 10, nativePid: 20, ownerStart: "1", nativeStart: "1", cliSha256: "fixed-cli", cliVersion: "codex-cli 0.162.1", unit: g.id }; },
    async stop(g) { await processes.get(g.id)?.close(); processes.delete(g.id); stops.push(g.id); },
    async discardUnready(g) { await this.stop(g, {} as any); },
    async processesQuiet() { await onQuiet(); return true; },
  };
  const validator = coldHomeValidator({ directory: join(root, "checks"), socketParentDirectory: root, supervisor, nativeHistoryFailures: supportedReader ? manifest : undefined });
  const options = { directory: join(root, "registry"), dataDirectory: root, proxyBaseUrl: "http://127.0.0.1:1", supervisor, requireHostUsage: true, replaceRetiredHome: validator, nativeHistoryFailures: manifest };
  let runtime = new CodexGenerationRuntime(options), sequence = 0, automaticAck = true, lease: ReturnType<CodexGenerationRuntime["claimHost"]>;
  const claim = () => { lease = runtime.claimHost("host", runtime.registry.ownerEpoch); sequence = 0; };
  const publish = () => runtime.publishHostUsage({ ...lease, sequence: ++sequence, blockedThreadIds: [], acknowledgedFenceEpoch: automaticAck ? runtime.fences().fenceEpoch : 0, discoveryComplete: true, unscopedBusy: false });
  for (const id of ["old", "new"]) await runtime.prepare({ id, endpoint: join(root, id, "control.sock"), runtimeDataDirectory: join(root, id, "data"), executable: "/fixed/cli", bundle: "/fixed/app.cjs", node: process.execPath, cwd: root });
  await runtime.activate("old", 0); runtime.registry.discover("good", "old"); if (retainedFailure) runtime.registry.discover("bad", "old"); claim(); publish();
  const request = (id: string, retained: boolean) => ({ id, retained, expectedOwner: runtime.registry.ownerEpoch, expectedHost: runtime.preparationOwner(), expectedEpoch: runtime.registry.epoch(), expectedIncarnation: runtime.registry.get(id)!.incarnation });
  const retire = async () => { const heartbeat = setInterval(publish, 5); try { return await runtime.retire("old"); } finally { clearInterval(heartbeat); } };
  return { get runtime() { return runtime; }, validator, manifest, request, publish, retire, stops, processes, calls, root,
    setMode(value: string) { mode = value; }, onQuiet(value: () => Promise<void>) { onQuiet = value; },
    duringHistory(value: () => void) { duringHistory = value; },
    replaceHost(ack = false) { claim(); automaticAck = ack; publish(); },
    acknowledge(value: boolean) { automaticAck = value; publish(); },
    async reopen() { await runtime.close(); runtime = new CodexGenerationRuntime(options); claim(); publish(); },
    async close() { await runtime.close(); for (const process of processes.values()) await process.close(); await rm(root, { recursive: true, force: true }); } };
}

test("retaining the original default survives same-CLI default switching and writer replacement without stopping its Native", async () => {
  const f = await fixture(true);
  try {
    f.runtime.setRetention(f.request("old", true)); await f.runtime.activate("new", 1); await f.reopen();
    f.runtime.startMonitor(5); await new Promise(r => setTimeout(r, 40));
    assert.deepEqual(await f.retire(), { retired: false, reasons: ["operator-retained"] });
    assert.deepEqual(f.stops, []); assert.equal(f.processes.has("old"), true);
    assert.equal(f.runtime.registry.route("good")!.generationId, "old"); const ticket = f.runtime.registry.acceptCreation(); assert.equal(ticket.generationId, "new"); f.runtime.registry.resolveCreation(ticket, "new-thread");
    assert.equal((await f.runtime.handoffObservation()).coverage, "complete"); await f.runtime.coldReadNative();
  } finally { await f.close(); }
});

test("retention requires exact owner, Host, epoch, incarnation and an open router", async () => {
  const f = await fixture();
  try {
    const req = f.request("old", true);
    for (const change of [{ expectedOwner: "stale" }, { expectedHost: "stale" }, { expectedEpoch: 0 }, { expectedIncarnation: 0 }, { retained: "true" }, { executable: "/other" }]) assert.throws(() => f.runtime.setRetention({ ...req, ...change }));
    assert.equal(f.runtime.registry.metadata("retention:old"), null);
    const handoff = f.runtime.owner.snapshot(); f.runtime.owner.fence({ operatorLease, operationId: "retain-fenced", fence: "retention-test", expectedOwner: handoff.owner, expectedEpoch: handoff.epoch });
    assert.throws(() => f.runtime.setRetention(req));
  } finally { await f.close(); }
});

test("a retention change cannot race an in-progress retirement", async () => {
  const f = await fixture(); let release!: () => void, entered!: () => void;
  try {
    await f.runtime.activate("new", 1);
    const reached = new Promise<void>(r => { entered = r; });
    f.onQuiet(async () => { entered(); await new Promise<void>(r => { release = r; }); });
    const retiring = f.retire(); await reached;
    assert.throws(() => f.runtime.setRetention(f.request("old", true)), /identity changed/);
    release(); assert.equal((await retiring).retired, true);
  } finally { release?.(); await f.close(); }
});

test("releasing a hold permits source preflight then exact historical cold validation in the same HOME", async () => {
  const f = await fixture(true);
  try {
    const before = f.runtime.registry.get("old")!; f.runtime.setRetention(f.request("old", true)); await f.runtime.activate("new", 1);
    f.runtime.setRetention(f.request("old", false)); assert.equal((await f.retire()).retired, true);
    assert.equal(f.processes.has("old"), false); const receipt = await f.validator(f.runtime.registry.get("old")!, before, ["good", "bad"], { appBundleOnly: true }) as any;
    assert.deepEqual(receipt.history.failures, f.manifest.failures); assert.equal(receipt.originalHome, join(before.runtimeDataDirectory, "runtime"));
    assert.deepEqual(f.calls.filter(c => c.id.startsWith("validation-") && c.method === "thread/read" && c.params.threadId === "bad").map(c => c.params.includeTurns), [false, true]);
    assert.equal(f.calls.some(c => ["thread/resume", "turn/start"].includes(c.method)), false);
    await f.runtime.ensure("old", true, true); assert.equal(f.runtime.registry.get("old")!.runtimeDataDirectory, before.runtimeDataDirectory); assert.equal(f.runtime.registry.get("old")!.executable, before.executable);
  } finally { await f.close(); }
});

test("unsupported retained-history cold reader blocks retirement while the original owner remains available", async () => {
  const f = await fixture(true, false);
  try {
    await f.runtime.activate("new", 1); await assert.rejects(f.retire(), /does not support/);
    assert.deepEqual(f.stops, []); assert.equal(f.runtime.registry.get("old")!.state, "draining"); assert.deepEqual(f.runtime.fences().fencedGenerationIds, []);
  } finally { await f.close(); }
});

test("a binding discovered during the source history read blocks stop until a fresh full preflight", async () => {
  const f = await fixture();
  try {
    await f.runtime.activate("new", 1);
    f.duringHistory(() => f.runtime.registry.discover("late", "old"));
    assert.deepEqual(await f.retire(), { retired: false, reasons: ["native-history-changed"] }); assert.deepEqual(f.stops, []);
    f.duringHistory(() => {}); assert.equal((await f.retire()).retired, true);
  } finally { await f.close(); }
});

test("Host replacement or regressed acknowledgement during history/OS inspection requires a new retirement attempt", async () => {
  for (const phase of ["history", "quiet"]) for (const replacement of ["unacknowledged", "acknowledged", "same-host-stale-ack"]) {
    const f = await fixture();
    try {
      await f.runtime.activate("new", 1);
      const change = () => replacement === "same-host-stale-ack" ? f.acknowledge(false) : f.replaceHost(replacement === "acknowledged");
      if (phase === "history") f.duringHistory(change); else f.onQuiet(async () => change());
      assert.deepEqual(await f.retire(), { retired: false, reasons: ["host-fence-changed"] }, `${phase}/${replacement}`);
      assert.deepEqual(f.stops, []); assert.equal(f.runtime.registry.get("old")!.state, "draining");
      f.duringHistory(() => {}); f.onQuiet(async () => {}); f.acknowledge(true);
      assert.equal((await f.retire()).retired, true);
    } finally { await f.close(); }
  }
});

test("source preflight rejects extra, changed, loaded or repaired retained failures before stop", async () => {
  for (const mode of ["extra", "code", "message", "second", "success", "loaded"]) {
    const f = await fixture(true);
    try {
      await f.runtime.activate("new", 1); f.setMode(mode); await assert.rejects(f.retire(), undefined, mode);
      assert.deepEqual(f.stops, []); assert.equal(f.runtime.registry.get("old")!.state, "draining"); assert.equal(f.processes.has("old"), true);
    } finally { await f.close(); }
  }
});

test("cold validation also rejects every difference, retains current original data and stops only validation processes", async () => {
  const f = await fixture(true);
  try {
    await f.runtime.activate("new", 1); assert.equal((await f.retire()).retired, true);
    const old = f.runtime.registry.get("old")!;
    for (const mode of ["extra", "code", "message", "second", "success", "loaded"]) {
      f.setMode(mode); await assert.rejects(f.validator(old, old, ["good", "bad"], { appBundleOnly: true }), undefined, mode);
      assert.equal(f.runtime.registry.get("old")!.state, "retired"); assert.equal(f.processes.has("old"), false); assert.equal([...f.processes.keys()].some(id => id.startsWith("validation-")), false);
    }
    f.setMode("exact"); await f.runtime.ensure("old", true, true); assert.equal(f.runtime.registry.get("old")!.incarnation, old.incarnation + 1);
  } finally { await f.close(); }
});
