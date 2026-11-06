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
import { CodexCoreControlClient, CodexCoreUnavailableError, CodexExecutionUnavailableError } from "@opencraft/account-pool-host";
import { startControlServer } from "../../apps/codex-core/src/control-server.js";

async function fixture(now?: () => number) {
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
    now, requireHostUsage: true, replaceRetiredHome: async (old, current) => { assert.equal(running.has(old.id), false, "backup cannot inspect a live HOME"); cold.push(old.id); return { replacement: current.executable, backupVerified: true }; } });
  for (const id of ["old", "new"]) await runtime.prepare({ id, endpoint: join(root, id, "control.sock"), runtimeDataDirectory: join(root, id, "data"), executable: `/fixed/${id}/codex`, bundle: `/fixed/${id}/app-server.cjs`, node: process.execPath, cwd: root });
  await runtime.activate("old", 0); runtime.registry.discover("old-thread", "old");
  let sequence = 0;
  const host = () => runtime.claimHost("host", runtime.registry.ownerEpoch);
  let lease = host();
  const publish = (blockedThreadIds: string[] = [], acknowledgedFenceEpoch = runtime.fences().fenceEpoch, unscopedBusy = false) => runtime.publishHostUsage({ ...lease, sequence: ++sequence, blockedThreadIds, acknowledgedFenceEpoch, unscopedBusy, discoveryComplete: true });
  publish(); await runtime.activate("new", 1);
  const waitFence = async () => { for (let n = 0; n < 200 && !runtime.fences().fencedGenerationIds.includes("old"); n++) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(runtime.fences().fencedGenerationIds.includes("old"), true); };
  return { root, runtime, supervisor, stopped, cold, native, publish, waitFence, running, setQuiet(value: boolean) { quiet = value; }, failNextStop() { failStop = true; },
    replaceHost() { const previous = lease; lease = host(); sequence = 0; return previous; },
    async close() { await runtime.close(); for (const process of running.values()) await process.close(); await rm(root, { recursive: true, force: true }); } };
}

test("execution failure restarts only its instance without waiting for busy Native, goals, Host or OS work", async () => {
  const f = await fixture();
  let disconnected = true;
  try {
    const before = f.runtime.registry.get("new")!.incarnation;
    const oldIdentity = await f.supervisor.start(f.runtime.registry.get("old")!);
    f.native.get("new")!.status = "active";
    f.native.get("new")!.goal = true;
    f.setQuiet(false); f.publish(["new-thread"], undefined, true);
    f.supervisor.inspect = async g => {
      if (g.id === "new" && disconnected) throw new CodexExecutionUnavailableError("disconnected");
      return f.supervisor.start(g);
    };
    f.supervisor.inspectNative = g => f.supervisor.start(g);
    f.supervisor.restartFailed = async (g, identity) => { await f.supervisor.stop(g, identity); disconnected = false; };
    await f.runtime.recoverExecutions();
    assert.deepEqual(f.stopped, ["new"]);
    assert.equal(f.runtime.registry.get("new")!.incarnation, before + 1);
    assert.equal((await f.supervisor.start(f.runtime.registry.get("old")!)).codexPid, oldIdentity.codexPid);
    assert.equal(f.runtime.fences().executionRecoveries?.find(row => row.generationId === "new")?.state, "recovered");
    assert.equal(f.cold.length, 0, "fault recovery does not migrate or replace the current HOME");
  } finally { await f.close(); }
});

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

test("a failed replacement is recorded and can be replaced again while the original source stays fixed", async () => {
  let time = 1_000, stops = 0;
  const f = await fixture(() => time);
  try {
    const g = f.runtime.registry.get("new")!, source = await f.supervisor.identify(g, await f.supervisor.start(g));
    f.supervisor.inspectNative = g => f.supervisor.start(g);
    f.supervisor.inspect = async g => {
      if (g.id === "new" && stops < 2) throw new CodexExecutionUnavailableError("disconnected");
      return f.supervisor.start(g);
    };
    f.supervisor.restartFailed = async (g, expected) => {
      const current = await f.supervisor.identify(g, await f.supervisor.start(g));
      if (current.nativeStart !== expected.nativeStart) return; // Original source is already gone; do not stop its successor.
      await f.supervisor.stop(g, expected); stops++;
    };
    await f.runtime.recoverExecutions();
    const first = JSON.parse(await (await import("node:fs/promises")).readFile(join(f.root, "routing/execution-recovery.json"), "utf8"))[0];
    assert.equal(first.state, "recovering"); assert.deepEqual(first.source, source);
    assert.notEqual(first.target.nativeStart, source.nativeStart, "replacement identity is durable before execution verification");
    time += 1_000;
    await f.runtime.recoverExecutions();
    assert.equal(stops, 2, "the failed replacement is actually restarted after backoff");
    assert.equal(f.runtime.fences().executionRecoveries?.[0]?.state, "recovered");
  } finally {await f.close();}
});

test("generation router keeps Native history readable while the execution admission fence remains blocked", async () => {
  const {CodexGenerationRouter, startGenerationSocket} = await import("../../apps/codex-core/src/generation-router.js");
  const {default: Client} = await import("ws");
  const f = await fixture();
  let socket: import("ws").WebSocket | undefined, listener: Awaited<ReturnType<typeof startGenerationSocket>> | undefined;
  try {
    f.runtime.registry.discover("new-thread", "new");
    f.supervisor.inspect = async g => {if (g.id === "new") throw new CodexExecutionUnavailableError("disconnected"); return f.supervisor.start(g);};
    f.supervisor.inspectNative = g => f.supervisor.start(g);
    f.supervisor.restartFailed = async () => {throw new Error("Stop not yet confirmed");};
    await f.runtime.recoverExecutions();
    listener = await startGenerationSocket(join(f.root, "router.sock"), new CodexGenerationRouter(f.runtime));
    socket = new Client(`ws+unix://${join(f.root, "router.sock")}:/`);
    await new Promise<void>((yes, no) => {socket!.once("open", yes); socket!.once("error", no);});
    let sequence = 0;
    const rpc = (method: string, params: object) => new Promise<any>(resolve => {
      const id = ++sequence;
      const receive = (raw: import("ws").RawData) => {const response = JSON.parse(String(raw)); if (response.id === id) {socket!.off("message", receive); resolve(response);}};
      socket!.on("message", receive); socket!.send(JSON.stringify({id, method, params}));
    });
    assert.equal((await rpc("initialize", {clientInfo: {name: "history-fault", version: "1"}})).error, undefined);
    assert.equal((await rpc("thread/read", {threadId: "new-thread", includeTurns: false})).result.thread.id, "new-thread");
    assert.equal((await rpc("thread/turns/list", {threadId: "new-thread"})).error, undefined);
    assert.equal((await rpc("turn/start", {threadId: "new-thread", input: []})).error.data.notSubmitted, true);
  } finally {socket?.terminate(); await listener?.close(); await f.close();}
});

test("controller restart explains only fault-scoped unknown leases and preserves their evidence without replay", async () => {
  let time = 1_000, disconnected = true;
  const f = await fixture(() => time);
  let replacement: CodexGenerationRuntime | undefined, denied: CodexGenerationRuntime | undefined;
  try {
    const g = f.runtime.registry.get("new")!;
    const rpc = f.runtime.owner.enter({generationId: "new", incarnation: g.incarnation, method: "command/exec"});
    const callback = f.runtime.owner.retainNativeCallback({generationId: "new", incarnation: g.incarnation, method: "item/tool/call", threadId: "new-thread"});
    callback.sent();
    f.supervisor.inspect = async g => {if (g.id === "new" && disconnected) throw new CodexExecutionUnavailableError("disconnected"); return f.supervisor.start(g);};
    f.supervisor.inspectNative = g => f.supervisor.start(g);
    f.supervisor.restartFailed = async () => {throw new Error("Stop is not yet confirmed");};
    await f.runtime.recoverExecutions();
    const fault = f.runtime.fences().executionRecoveries!.find(row => row.generationId === "new")!;
    callback.retireForExecutionFault(fault.id); rpc();
    assert.equal(f.runtime.owner.snapshot().activeCalls, 0);
    const options = (f.runtime as any).options;
    await f.runtime.close();
    replacement = new CodexGenerationRuntime(options);
    assert.equal(replacement.owner.isOpen(), false, "unconfirmed startup cannot admit before reading the journal");
    await replacement.initializeExecutionRecovery();
    assert.equal(replacement.owner.isOpen(), true, "fault-scoped uncertainty allows recovery to continue");
    assert.equal((replacement.registry.metadata(`router-lease:${callback.id}`) as any).executionFaultId, fault.id);
    assert.ok((replacement.registry.metadata(`router-lease:${callback.id}`) as any).uncertainty, "unknown evidence is retained");
    time += 1_000;
    f.supervisor.restartFailed = async (generation, identity) => {await f.supervisor.stop(generation, identity); disconnected = false;};
    await replacement.recoverExecutions();
    assert.equal(replacement.fences().executionRecoveries?.find(row => row.id === fault.id)?.state, "recovered");
    assert.equal(replacement.owner.currentResponsibilityConfirmed(), true);
    await replacement.close(); replacement = new CodexGenerationRuntime(options);
    await replacement.initializeExecutionRecovery();
    assert.equal(replacement.owner.isOpen(), true, "the completed fault remains restartable");
    // A second failure must not discard the source proof that still explains
    // the first failure's retained unknown callback record.
    const secondGeneration = replacement.registry.get("new")!;
    const secondRpc = replacement.owner.enter({generationId: "new", incarnation: secondGeneration.incarnation, method: "process/spawn"});
    const secondCallback = replacement.owner.retainNativeCallback({generationId: "new", incarnation: secondGeneration.incarnation, threadId: "new-thread"});
    disconnected = true;
    f.supervisor.restartFailed = async () => {throw new Error("Second source stop pending");};
    await replacement.recoverExecutions();
    const secondFault = replacement.fences().executionRecoveries!.find(row => row.generationId === "new")!;
    assert.notEqual(secondFault.id, fault.id);
    secondCallback.retireForExecutionFault(secondFault.id); secondRpc();
    await replacement.close(); replacement = new CodexGenerationRuntime(options);
    await replacement.initializeExecutionRecovery();
    assert.equal(replacement.owner.isOpen(), true, "both generations' unknown proofs survive a repeated incident");
    time += 1_000;
    f.supervisor.restartFailed = async (generation, identity) => {await f.supervisor.stop(generation, identity); disconnected = false;};
    await replacement.recoverExecutions();
    assert.equal(replacement.owner.currentResponsibilityConfirmed(), true);
    assert.ok((replacement.registry.metadata(`router-lease:${callback.id}`) as any).uncertainty);
    replacement.owner.uncertain("unattributed");
    await replacement.close(); replacement = undefined;
    denied = new CodexGenerationRuntime(options);
    await assert.rejects(denied.initializeExecutionRecovery(), /unconfirmed/, "unrelated uncertainty still requires its original recovery contract");
  } finally {await denied?.close(); await replacement?.close(); await f.close();}
});


test("confirmed failure stays durably blocked when source capture fails and retries capture after backoff", async () => {
  let time = 1_000, captures = 0, disconnected = true;
  const f = await fixture(() => time);
  try {
    f.supervisor.inspectNative = g => f.supervisor.start(g);
    f.supervisor.inspect = async g => {
      if (g.id === "new" && disconnected) throw new CodexExecutionUnavailableError("disconnected");
      return f.supervisor.start(g);
    };
    f.supervisor.captureExecutionIdentity = async (_g, identity) => {
      if (++captures === 1) throw new Error("systemd identity observation temporarily unavailable");
      return {...identity, invocationId: "synthetic-invocation"};
    };
    f.supervisor.restartFailed = async (g, identity) => { await f.supervisor.stop(g, identity); disconnected = false; };
    await f.runtime.recoverExecutions();
    const file = join(f.root, "routing/execution-recovery.json");
    const first = JSON.parse(await (await import("node:fs/promises")).readFile(file, "utf8"))[0];
    assert.equal(first.state, "recovering"); assert.equal(first.source, undefined);
    assert.equal(first.retryAt, 2_000); assert.equal(f.runtime.executionRecoveryPending("new"), true);
    assert.deepEqual(f.stopped, [], "an unverified source cannot authorize stopping an instance");
    await f.runtime.recoverExecutions();
    assert.equal(captures, 1, "identity observation also respects the persisted backoff");
    time = first.retryAt;
    await f.runtime.recoverExecutions();
    const recovered = JSON.parse(await (await import("node:fs/promises")).readFile(file, "utf8"))[0];
    assert.equal(recovered.id, first.id); assert.equal(recovered.state, "recovered");
    assert.equal(recovered.source.invocationId, "synthetic-invocation");
    assert.equal(recovered.target.invocationId, "synthetic-invocation");
    assert.equal(f.runtime.executionRecoveryPending("new"), false); assert.deepEqual(f.stopped, ["new"]);
  } finally { await f.close(); }
});
