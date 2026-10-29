import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { CodexCoreControlClient } from "@opencraft/account-pool-host";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { startCodexCore } from "../../apps/codex-core/src/main.js";
import { startCodexAppServer } from "../../apps/codex-core/src/app-server.js";
import { startControlServer, readControlJson } from "../../apps/codex-core/src/control-server.js";
import { CodexGenerationRuntime } from "../../apps/codex-core/src/generation-runtime.js";
import { CodexGenerationRouter, startGenerationSocket } from "../../apps/codex-core/src/generation-router.js";
import type { GenerationSupervisor } from "../../apps/codex-core/src/generation-supervisor.js";
import { CodexEngineAdapter } from "../../apps/opencraft-daemon/src/codex-engine-adapter.js";

test("actual Host acknowledges generation fences, preserves queued admissions, and only rejects fenced generation inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-gen-host-")), token = "synthetic-generation-host-".repeat(3);
  const endpoint = join(root, "accounts/control.sock"), runtimeEndpoint = join(root, "routing/control.sock"), dataDirectory = join(root, "data");
  const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve)); const port = (reservation.address() as import("node:net").AddressInfo).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const base = { authToken: token, dataDirectory, runtimeDirectory: root, executable: process.execPath };
  const core = await startCodexCore({ ...base, endpoint, appServerEndpoint: runtimeEndpoint, proxyPort: port, nativeCodexHomeDirectory: join(root, "native"), fetch: async () => Response.json({ plan_type: "pro" }) });
  const owners = new Map<string, Awaited<ReturnType<typeof startCodexAppServer>>>(), stopped: string[] = [];
  let permitStop = false;
  const supervisor: GenerationSupervisor = {
    async start(g) {
      if (!owners.has(g.id)) owners.set(g.id, await startCodexAppServer({ ...base, endpoint: g.endpoint, coreEndpoint: endpoint, runtimeDataDirectory: g.runtimeDataDirectory,
        spawnAppServer: ({ args, cwd, env }) => spawn(process.execPath, [new URL("../fixtures/fake-codex-unix-appserver.mjs", import.meta.url).pathname, args[2]!.slice("unix://".length)], { cwd, env: { ...env, FAKE_CODEX_THREAD_PREFIX: g.id }, stdio: ["pipe", "pipe", "pipe"] }) }));
      return new CodexCoreControlClient(g.endpoint, token).appServerHealth();
    },
    async identify(g, h) { return { ownerPid: h.pid, nativePid: h.codexPid, ownerStart: "1", nativeStart: "1", cliSha256: g.executable, cliVersion: g.id, unit: g.id }; },
    async stop(g) { if (!permitStop) throw new Error("test stop barrier"); await owners.get(g.id)?.close(); owners.delete(g.id); stopped.push(g.id); },
    async discardUnready(g) { await owners.get(g.id)?.close(); owners.delete(g.id); }, async processesQuiet() { return true; },
  };
  const runtime = new CodexGenerationRuntime({ directory: join(root, "registry"), dataDirectory, proxyBaseUrl: `http://127.0.0.1:${port}`, supervisor, requireHostUsage: true, replaceRetiredHome: async () => ({}) });
  const router = new CodexGenerationRouter(runtime); runtime.serverRequestCount = id => router.serverRequestCount(id);
  const listener = await startGenerationSocket(join(root, "routing/native.sock"), router);
  const control = await startControlServer(runtimeEndpoint, token, async request => {
    if (request.url === "/health") { const current = runtime.registry.current(), h = await runtime.ensure(current.generation.id); return { status: 200, value: { ...h, nativeSocket: join(root, "routing/native.sock"), routingEpoch: runtime.registry.ownerEpoch, routingPid: process.pid } }; }
    const envelope = await readControlJson(request), p = envelope.params as any;
    return { status: 200, value: envelope.operation === "claim" ? runtime.claimHost(p.instanceId, p.routingEpoch) : runtime.publishHostUsage(p) };
  });
  let engine: CodexEngineAdapter | undefined;
  async function wait(check: () => boolean, label: string) { for (let n = 0; n < 400; n++) { if (check()) return; await delay(25); } throw new Error(label); }
  try {
    for (const id of ["old", "new"]) await runtime.prepare({ id, endpoint: join(root, id, "control.sock"), runtimeDataDirectory: join(root, id, "data"), executable: process.execPath, bundle: "/fixed/app.cjs", node: process.execPath, cwd: root });
    await runtime.activate("old", 0);
    engine = new CodexEngineAdapter({ ...base, coreEndpoint: endpoint, coreAuthToken: token, coreHostOverlays: true, logDiagnostic: () => {} });
    const frames: any[] = []; engine.subscribeMessage(frame => frames.push(JSON.parse(frame))); await engine.connect();
    let seq = 0;
    async function rpc(method: string, params: object = {}) { const id = ++seq; await engine!.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "client" })); await wait(() => frames.some(m => m.id === id && !m.method), method); const reply = frames.find(m => m.id === id && !m.method); if (reply.error) throw new Error(reply.error.message); return reply.result; }
    const init = await rpc("initialize"); assert.deepEqual(init.capabilities.extensions["opencraft.codex-generations"], { version: 1 });
    assert.equal(frames.some(m => "__opencraftGeneration" in m), false, "private routing metadata never escapes Host");
    // Establish the Host baseline before changing the epoch read by its initial goal scan.
    await wait(() => (runtime.registry.metadata("host-usage") as any)?.discoveryComplete === true, "Host publishes real discovery proof");
    const { thread } = await rpc("thread/start", {}); await runtime.activate("new", 1);
    // Hold a submission accepted before the fence in Host/native queues.
    await rpc("fixture/holdNextTurn");
    await rpc("thread/queue/add", { threadId: thread.id, clientUserMessageId: "queued", input: [{ type: "text", text: "run once" }] });
    await wait(() => frames.some(m => m.method === "turn/started" && m.params.threadId === thread.id), "queued work starts");
    await delay(5_100);
    assert.ok((runtime.registry.metadata("host-usage") as any).blockedThreadIds.includes(thread.id));
    assert.equal((await runtime.retire("old")).retired, false); assert.deepEqual(stopped, []);
    await rpc("fixture/releaseTurns", { threadId: thread.id }); await rpc("fixture/complete", { threadId: thread.id });
    // A durable stop failure leaves the Host generation fence on. Reads/cancel remain available.
    await wait(() => !(runtime.registry.metadata("host-usage") as any).blockedThreadIds.includes(thread.id), "Host reconciles completed queue");
    const retiring = runtime.retire("old"), rejected = assert.rejects(retiring, /test stop barrier/); await rejected;
    assert.equal(runtime.registry.get("old")!.state, "retiring");
    await assert.rejects(rpc("thread/goal/set", { threadId: thread.id, objective: "new goal" }), /temporarily unavailable/);
    const fresh = await rpc("thread/start", {}); assert.match(fresh.thread.id, /^new-/);
    permitStop = true; assert.equal((await runtime.retire("old")).retired, true);
    assert.equal((await rpc("thread/read", { threadId: fresh.thread.id })).thread.id, fresh.thread.id);
    assert.equal(engine.status.state, "open", "normal retirement keeps the shared Host connection alive");
  } finally { await engine?.close(); await control.close(); await listener.close(); await runtime.close(); for (const owner of owners.values()) await owner.close(); await core.close(); await rm(root, { recursive: true, force: true }); }
});
