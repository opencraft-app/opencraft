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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "oc-gen-life-"));
  const running = new Map<string, { close(): Promise<void>; serial: number }>(), serials = new Map<string, number>();
  const stopped: string[] = [], cold: string[] = [];
  const native = new Map<string, { status: "idle" | "active"; goal: boolean }>([["old", { status: "idle", goal: false }], ["new", { status: "idle", goal: false }]]);
  let quiet = true, failStop = false;
  const supervisor: GenerationSupervisor = {
    async start(g) {
      if (!running.has(g.id)) {
        const server = createServer(), ws = new WebSocketServer({ server }), sockets = new Set<WebSocket>();
        ws.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("message", data => {
          const m = JSON.parse(String(data)); if (m.id === undefined) return;
          const state = native.get(g.id)!; let result: unknown = {};
          if (m.method === "thread/loaded/list") result = { data: [`${g.id}-thread`] };
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
        proxyBaseUrl: "http://127.0.0.1:1234", codexHome: join(g.runtimeDataDirectory, "runtime"), nativeSocket: join(root, g.id + ".sock") };
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
  return { runtime, stopped, cold, native, publish, waitFence, running, setQuiet(value: boolean) { quiet = value; }, failNextStop() { failStop = true; },
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
