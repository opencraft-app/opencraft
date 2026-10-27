import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { CodexGenerationRuntime } from "../../apps/codex-core/src/generation-runtime.js";
import type { GenerationSupervisor, GenerationProcessIdentity } from "../../apps/codex-core/src/generation-supervisor.js";
import type { GenerationRecord } from "../../apps/codex-core/src/generation-registry.js";
import { CodexCoreControlClient, CodexCoreUnavailableError } from "@opencraft/account-pool-host";
import { startControlServer } from "../../apps/codex-core/src/control-server.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "oc-gen-life-"));
  const running = new Map<string, { close(): Promise<void>; serial: number }>(), serials = new Map<string, number>();
  const stopped: string[] = [], cold: string[] = [];
  const native = new Map<string, { status: "idle" | "active"; goal: boolean; loaded?:boolean; pendingCallbacks?:number; pendingOrchestrationMutations?:number }>([["old", { status: "idle", goal: false }], ["new", { status: "idle", goal: false }]]);
  let quiet = true, failStop = false;
  const supervisor: GenerationSupervisor = {
    async start(g) {
      if (!running.has(g.id)) {
        const server = createServer(), ws = new WebSocketServer({ server }), sockets = new Set<WebSocket>();
        ws.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("message", data => {
          const m = JSON.parse(String(data)); if (m.id === undefined) return;
          const state = native.get(g.id)!; let result: unknown = {};
          if (m.method === "thread/loaded/list") result = { data: g.id === "spare" && !state.loaded ? [] : [`${g.id}-thread`] };
          if (m.method === "thread/read") result = { thread: { id: `${g.id}-thread`, ephemeral: false, status: { type: state.status } } };
          if (m.method === "thread/goal/get") result = { goal: state.goal ? { status: "active" } : null };
          socket.send(JSON.stringify({ id: m.id, result }));
        }); });
        const path = join(root, g.id + ".sock");
        await new Promise<void>(resolve => server.listen(path, resolve));
        const serial = (serials.get(g.id) ?? 0) + 1; serials.set(g.id, serial);
        running.set(g.id, { serial, async close() { for (const socket of sockets) socket.terminate(); ws.close(); await new Promise<void>(resolve => server.close(() => resolve())); } });
      }
      return { protocolVersion: 1, pid: 100, codexPid: 200 + running.get(g.id)!.serial, dataDirectory: root,
        proxyBaseUrl: "http://127.0.0.1:1234", codexHome: join(g.runtimeDataDirectory, "runtime"), nativeSocket: join(root, g.id + ".sock"),pendingCallbacks:native.get(g.id)!.pendingCallbacks,pendingOrchestrationMutations:native.get(g.id)!.pendingOrchestrationMutations };
    },
    async identify(g, h) { return { ownerPid: h.pid, nativePid: h.codexPid, ownerStart: "1", nativeStart: String(running.get(g.id)!.serial), cliSha256: g.executable, cliVersion: g.executable.includes("/old/") ? "codex-cli 0.162.0" : "codex-cli 0.162.1", unit: g.id }; },
    async stop(g, _identity) { if (failStop) { failStop = false; throw new Error("synthetic stop lost"); } const process = running.get(g.id); if (process) { await process.close(); running.delete(g.id); } stopped.push(g.id); },
    async discardUnready(g) { const process = running.get(g.id); if (process) { await process.close(); running.delete(g.id); } },
    async processesQuiet() { return quiet; },
  };
  const runtime = new CodexGenerationRuntime({ directory: join(root, "routing"), dataDirectory: root, proxyBaseUrl: "http://127.0.0.1:1234", supervisor,
    requireHostUsage: true, replaceRetiredHome: async (old, current) => { assert.equal(running.has(old.id), false, "backup cannot inspect a live HOME"); cold.push(old.id); return { replacement: current.executable, backupVerified: true }; } });
  for (const id of ["old", "new"]) await runtime.prepare({ id, endpoint: join(root, id, "control.sock"), runtimeDataDirectory: join(root, id, "data"), executable: `/fixed/${id}/codex`, bundle: `/fixed/${id}/app-server.cjs`, node: process.execPath, cwd: root });
  await runtime.activate("old", 0); runtime.registry.discover("old-thread", "old");
  let sequence = 0;
  const host = () => runtime.claimHost("host", runtime.registry.ownerEpoch);
  let lease = host();
  const publish = (blockedThreadIds: string[] = [], acknowledgedFenceEpoch = runtime.fences().fenceEpoch, unscopedBusy = false) => runtime.publishHostUsage({ ...lease, sequence: ++sequence, blockedThreadIds, acknowledgedFenceEpoch, unscopedBusy, discoveryComplete: true });
  publish(); await runtime.activate("new", 1);
  const waitFence = async () => { for (let n = 0; n < 200 && !runtime.fences().fencedGenerationIds.includes("old"); n++) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(runtime.fences().fencedGenerationIds.includes("old"), true); };
  return { runtime, supervisor, stopped, cold, native, publish, waitFence, running, setQuiet(value: boolean) { quiet = value; }, failNextStop() { failStop = true; },
    replaceHost() { const previous = lease; lease = host(); sequence = 0; return previous; },
    async close() { await runtime.close(); for (const process of running.values()) await process.close(); await rm(root, { recursive: true, force: true }); } };
}

test("Host queue and Native goal keep the old owner serving without installing an admission fence", async () => {
  const f = await fixture();
  try {
    f.publish(["old-thread"]); assert.deepEqual((await f.runtime.retire("old")).reasons, ["host-thread-work"]);
    assert.deepEqual(f.runtime.fences().fencedGenerationIds, []); assert.deepEqual(f.stopped, []);
    f.publish(); f.native.get("old")!.goal = true;
    assert.deepEqual((await f.runtime.retire("old")).reasons, ["native-goal"]); assert.deepEqual(f.runtime.fences().fencedGenerationIds, []);
  } finally { await f.close(); }
});

test("native HOME directory resolves old and new Threads without waking retired writers or taking the Host lease", async () => {
  const f = await fixture();
  try {
    f.runtime.registry.discover("new-thread", "new");
    const old = f.runtime.directory("old-thread"), current = f.runtime.directory("new-thread");
    assert.equal(old.routingEpoch, f.runtime.registry.ownerEpoch); assert.equal(old.admissionEpoch, 2);
    assert.deepEqual(old.route, { threadId: "old-thread", generationId: "old" });
    assert.deepEqual(current.route, { threadId: "new-thread", generationId: "new" });
    assert.equal(new Set(old.homes.map(home => home.codexHome)).size, 2);
    const leaseBefore = f.runtime.registry.metadata("host-usage");
    const retiring = f.runtime.retire("old"); await f.waitFence(); f.publish(); await retiring;
    const leaseAfterRetirement = f.runtime.registry.metadata("host-usage");
    assert.equal(f.running.has("old"), false);
    assert.equal(f.runtime.directory("old-thread").homes.find(home => home.generationId === "old")!.codexHome,
      old.homes.find(home => home.generationId === "old")!.codexHome);
    assert.equal(f.running.has("old"), false, "a directory read cannot cold-open an old HOME");
    assert.deepEqual(f.runtime.registry.metadata("host-usage"), leaseAfterRetirement, "readers cannot replace the Host lease");
    assert.equal((leaseBefore as any).lease, (leaseAfterRetirement as any).lease);
    assert.equal(f.runtime.directory("unknown-thread").route, null);
  } finally { await f.close(); }
});

test("a native HOME directory from a replacement routing owner cannot satisfy an earlier read", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-directory-epoch-")), token = "synthetic-directory-token".repeat(3), endpoint = join(root, "control.sock");
  const control = await startControlServer(endpoint, token, async request => ({ status: 200, value: request.url === "/health"
    ? { protocolVersion: 1, pid: 1, codexPid: 2, nativeSocket: join(root, "native.sock"), routingEpoch: "before" }
    : { protocolVersion: 1, routingEpoch: "replacement", admissionEpoch: 2, homes: [{ generationId: "new", codexHome: "/native/new/runtime", incarnation: 1 }], route: null } }));
  try { await assert.rejects(new CodexCoreControlClient(endpoint, token).generationDirectory("old-thread"), CodexCoreUnavailableError); }
  finally { await control.close(); await rm(root, { recursive: true, force: true }); }
});

test("work accepted before a Host fence is visible in the acknowledgement and prevents retirement", async () => {
  const f = await fixture();
  try {
    const retiring = f.runtime.retire("old"); await f.waitFence();
    f.publish(["old-thread"]);
    assert.equal((await retiring).retired, false); assert.deepEqual(f.stopped, []);
    assert.equal(f.runtime.registry.get("old")!.state, "draining"); assert.deepEqual(f.runtime.fences().fencedGenerationIds, []);
  } finally { await f.close(); }
});

test("an acknowledged empty Host fence permits retirement and validated cold replacement in the same HOME", async () => {
  const f = await fixture();
  try {
    const root = f.runtime.registry.get("old")!.runtimeDataDirectory;
    const retiring = f.runtime.retire("old"); await f.waitFence(); f.publish();
    assert.equal((await retiring).retired, true); assert.deepEqual(f.stopped, ["old"]); assert.equal(f.running.has("new"), true);
    assert.equal(f.runtime.registry.get("old")!.state, "retired"); assert.deepEqual(f.runtime.fences().fencedGenerationIds, []);
    await f.runtime.ensure("old");
    assert.deepEqual(f.cold, ["old"]); assert.equal(f.runtime.registry.get("old")!.runtimeDataDirectory, root);
    assert.equal(f.runtime.registry.get("old")!.executable, "/fixed/new/codex"); assert.equal(f.runtime.registry.route("old-thread")!.incarnation, 2);
  } finally { await f.close(); }
});

test("a live native shell blocks retirement after the Host acknowledgement", async () => {
  const f = await fixture();
  try {
    f.setQuiet(false); const retiring = f.runtime.retire("old"); await f.waitFence(); f.publish();
    assert.deepEqual((await retiring).reasons, ["native-process"]); assert.deepEqual(f.stopped, []);
  } finally { await f.close(); }
});

test("failed stopping keeps a durable retirement fence and retries before any HOME replacement", async () => {
  const f = await fixture();
  try {
    f.failNextStop(); const retiring = f.runtime.retire("old"); const rejected = assert.rejects(retiring, /synthetic stop lost/);
    await f.waitFence(); f.publish(); await rejected;
    assert.equal(f.runtime.registry.get("old")!.state, "retiring"); await assert.rejects(f.runtime.ensure("old"), /maintenance/);
    assert.deepEqual(f.cold, []); assert.equal(f.running.has("old"), true);
    assert.equal((await f.runtime.retire("old")).retired, true); assert.equal(f.runtime.registry.get("old")!.state, "retired");
  } finally { await f.close(); }
});

test("old Host leases and snapshots cannot overwrite the current retirement proof", async () => {
  const f = await fixture();
  try {
    const previous = f.replaceHost();
    assert.throws(() => f.runtime.publishHostUsage({ ...previous, sequence: 100, blockedThreadIds: [], unscopedBusy: false, discoveryComplete: true, acknowledgedFenceEpoch: f.runtime.fences().fenceEpoch }), /Stale/);
    f.publish(["old-thread"]); assert.deepEqual((await f.runtime.retire("old")).reasons, ["host-thread-work"]);
  } finally { await f.close(); }
});

test("explicit rollback after retirement reopens the preserved payload and current HOME", async () => {
  const f = await fixture();
  try {
    const retiring = f.runtime.retire("old"); await f.waitFence(); f.publish(); assert.equal((await retiring).retired, true);
    assert.equal(await f.runtime.activate("old", 2), 3);
    assert.equal(f.runtime.registry.current().generation.executable, "/fixed/old/codex");
    assert.equal(f.runtime.registry.get("new")!.state, "draining"); assert.deepEqual(f.cold, ["old"]);
  } finally { await f.close(); }
});


test("automatic historical reads never downgrade a newer HOME after default rollback", async () => {
  const f = await fixture();
  try {
    await f.runtime.activate("old", 2);
    const retiring = f.runtime.retire("new");
    for (let n = 0; n < 200 && !f.runtime.fences().fencedGenerationIds.includes("new"); n++) await new Promise(resolve => setTimeout(resolve, 5));
    f.publish(); assert.equal((await retiring).retired, true);
    await f.runtime.ensure("new"); assert.equal(f.runtime.registry.get("new")!.executable, "/fixed/new/codex");
    assert.equal(f.runtime.registry.current().generation.id, "old");
  } finally { await f.close(); }
});


test("pending owned callbacks and unacknowledged creation receipts block retirement before fencing",async()=>{
  const f=await fixture();
  try{
    for(const field of ["pendingCallbacks","pendingOrchestrationMutations"] as const){
      f.native.get("old")![field]=1;assert.deepEqual((await f.runtime.retire("old")).reasons,["native-orchestration-callback"]);assert.deepEqual(f.runtime.fences().fencedGenerationIds,[]);f.native.get("old")![field]=0;
    }
    assert.equal(f.running.has("old"),true);
  }finally{await f.close();}
});

test("P2c readiness expires across Host leases, native incarnation changes and default CAS", async () => {
  const f = await fixture();
  try {
    let proof = await f.runtime.preparation("old");
    f.replaceHost();
    await assert.rejects(f.runtime.activate("old", 2, proof), /preparation/);
    proof = await f.runtime.preparation("old");
    await f.running.get("old")!.close(); f.running.delete("old");
    await assert.rejects(f.runtime.activate("old", 2, proof), /preparation/);
    proof = await f.runtime.preparation("old");
    assert.equal(await f.runtime.activate("old", 2, proof), 3);
    await assert.rejects(f.runtime.activate("new", 2), /epoch/);
    assert.equal(f.runtime.registry.route("old-thread")!.generationId, "old");
  } finally { await f.close(); }
});

async function spare(f: Awaited<ReturnType<typeof fixture>>) {
  const { state, incarnation, ...base } = f.runtime.registry.get("new")!;
  const root = base.cwd;
  f.native.set("spare", { status: "idle", goal: false });
  await f.runtime.prepare({ ...base, id: "spare", runtimeDataDirectory: join(root, "spare", "data"), endpoint: join(root, "spare", "control.sock") });
  return f.runtime.preparation("spare");
}
test("P2c only a never admitted ready candidate can be revoked; HOME and old work are retained", async () => {
  const f = await fixture();
  try {
    const proof = await spare(f);
    await assert.rejects(f.runtime.discard("spare"), /cannot be discarded/);
    assert.deepEqual(await f.runtime.revoke("spare", 2, proof), { revoked: true });
    assert.equal(f.runtime.registry.get("spare")!.state, "discarded");
    assert.equal(f.running.has("new"), true); assert.equal(f.running.has("old"), true);
    assert.equal(f.runtime.registry.current().generation.id, "new");
    const previous = await f.runtime.preparation("old");
    await assert.rejects(f.runtime.revoke("old", 2, previous), /never admitted/);
  } finally { await f.close(); }
});
test("P2c uncertain candidate stop leaves durable revoking fence and never starts it again", async () => {
  const f = await fixture();
  try {
    const proof = await spare(f); f.failNextStop();
    await assert.rejects(f.runtime.revoke("spare", 2, proof), /synthetic stop lost/);
    assert.equal(f.runtime.registry.get("spare")!.state, "revoking");
    // Even an explicit retry cannot call start through the persisted fence.
    await f.running.get("spare")!.close(); f.running.delete("spare");
    const start = f.supervisor.start; let starts = 0;
    f.supervisor.start = async g => { starts++; return start(g); };
    await assert.rejects(f.runtime.revoke("spare", 2, proof)); assert.equal(starts, 0);
    await assert.rejects(f.runtime.ensure("spare"), /maintenance/);
    await assert.rejects(f.runtime.activate("spare", 2), /maintenance/);
    assert.equal(f.runtime.registry.current().generation.id, "new");
  } finally { await f.close(); }
});
test("P2c a ready candidate with any historical binding or live OS work cannot be revoked", async () => {
  const f = await fixture();
  try {
    let proof = await spare(f); f.setQuiet(false);
    await assert.rejects(f.runtime.revoke("spare", 2, proof), /not quiet/);
    f.setQuiet(true); f.runtime.registry.discover("historical-spare", "spare");
    proof = await f.runtime.preparation("spare");
    await assert.rejects(f.runtime.revoke("spare", 2, proof), /never admitted/);
    assert.equal(f.running.has("spare"), true);
  } finally { await f.close(); }
});


test("P2c revocation holds the lifecycle fence throughout a suspended quiet probe", async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), quiet = new Promise<void>(resolve => { entered = resolve; });
  try {
    const proof = await spare(f);
    f.supervisor.processesQuiet = async () => { entered(); await held; return true; };
    const revoke = f.runtime.revoke("spare", 2, proof);
    await quiet;
    await assert.rejects(f.runtime.ensure("spare", true, true), /maintenance/);
    await assert.rejects(f.runtime.preparation("spare"), /maintenance/);
    await assert.rejects(f.runtime.activate("spare", 2), /maintenance/);
    release(); await revoke;
    assert.equal(f.runtime.registry.get("spare")!.state, "discarded"); assert.equal(f.running.has("spare"), false);
  } finally { release(); await f.close(); }
});
test("P2c in-flight starting prevents revocation before stop can race delayed start", async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  try {
    const proof = await spare(f), start = f.supervisor.start;
    f.supervisor.start = async g => { if (g.id === "spare") { entered(); await held; } return start(g); };
    const ensuring = f.runtime.ensure("spare", true, true); await started;
    await assert.rejects(f.runtime.revoke("spare", 2, proof), /maintenance/);
    release(); await ensuring;
    f.supervisor.start = start;
    await f.runtime.revoke("spare", 2, await f.runtime.preparation("spare"));
    assert.equal(f.running.has("spare"), false);
  } finally { release(); await f.close(); }
});
test("P2c native preparation checks expected routing/Host identity and activation records the exact operation", async () => {
  const f = await fixture();
  try {
    const owner = f.runtime.registry.ownerEpoch, host = f.runtime.preparationOwner();
    await assert.rejects(f.runtime.preparation("old", "other-owner", host), /owner or Host/);
    f.replaceHost();
    await assert.rejects(f.runtime.preparation("old", owner, host), /owner or Host/);
    const proof = await f.runtime.preparation("old", owner, f.runtime.preparationOwner());
    const operationId = "a".repeat(64);
    await f.runtime.activate("old", 2, proof, owner, f.runtime.preparationOwner(), operationId);
    assert.deepEqual(f.runtime.registry.metadata("last-activation"), { operationId, generationId: "old", epoch: 3, owner });
  } finally { await f.close(); }
});


test("P2c a ready candidate with direct native work is retained even without a routing claim", async () => {
  const f = await fixture();
  try {
    const proof = await spare(f); f.native.get("spare")!.loaded = true;
    await assert.rejects(f.runtime.revoke("spare", 2, proof), /native threads or unknown work/);
    assert.equal(f.running.has("spare"), true); assert.equal(f.runtime.registry.get("spare")!.state, "ready");
  } finally { await f.close(); }
});
