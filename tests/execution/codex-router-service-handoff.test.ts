import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { CodexGenerationRuntime } from "../../apps/codex-core/src/generation-runtime.js";
import { startCodexGenerationService } from "../../apps/codex-core/src/generation-service.js";
import { startControlServer } from "../../apps/codex-core/src/control-server.js";
import { GenerationPeer } from "../../apps/codex-core/src/generation-peer.js";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";

test("real router service preserves native subscriptions and registry across release, candidate failure and current-data recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-router-service-"));
  const data = join(root, "data"), directory = join(root, "sockets"), registry = join(root, "registry"), native = join(root, "native.sock");
  await mkdir(data, { mode: 0o700 }); await mkdir(directory, { mode: 0o700 });
  const token = "synthetic-router-private-control-token", endpoint = join(directory, "control.sock"), coreEndpoint = join(root, "core.sock");
  const calls: string[] = []; let pending = 0, resumes = 0;
  const http = createServer(), wss = new WebSocketServer({ server: http });
  wss.on("connection", socket => socket.on("message", raw => {
    const m = JSON.parse(String(raw)); calls.push(m.method);
    if (m.id === undefined) return;
    if (m.method === "thread/resume") resumes++;
    const result = m.method === "initialize" ? { userAgent: "retained-native" }
      : m.method === "thread/list" ? { data: [{ id: "historical", status: { type: "idle" } }], nextCursor: null }
      : m.method === "thread/loaded/list" ? { data: ["historical"] }
      : ["thread/read", "thread/resume"].includes(m.method) ? { thread: { id: "historical" } } : {};
    socket.send(JSON.stringify({ id: m.id, result }));
  }));
  await new Promise<void>(r => http.listen(native, r));
  const core = await startControlServer(coreEndpoint, token, async () => ({ status: 200, value: {
    protocolVersion: 1, dataDirectory: data, launch: { env: { OPENCRAFT_CODEX_POOL_AUTH_TOKEN: "synthetic" }, auth: { type: "chatgptAuthTokens", accessToken: "synthetic" }, args: ['chatgpt_base_url="http://127.0.0.1:1"'] } } }));
  const health = { protocolVersion: 1 as const, pid: process.pid, codexPid: process.pid, dataDirectory: data,
    proxyBaseUrl: "http://127.0.0.1:1", codexHome: join(data, "runtime"), nativeSocket: native, callbackProtocolVersion: 1 as const,
    get pendingCallbacks() { return pending; }, pendingOrchestrationMutations: 0 };
  await mkdir(health.codexHome, { mode: 0o700 });
  const identity = { ownerPid: process.pid, nativePid: process.pid, ownerStart: "1", nativeStart: "1", unit: "fixture", cliSha256: "fixed", cliVersion: "codex-cli 0.162.1" };
  const options = { endpoint, coreEndpoint, token, tokenFile: join(root, "unused-token"), dataDirectory: data, registryDirectory: registry,
    systemdScope: "system" as const, requireHostUsage: false, supervisor: {
      start: async () => health, inspect: async () => health, identify: async () => identity,
      stop: async () => { throw Error("Router cannot stop native"); }, discardUnready: async () => {}, processesQuiet: async () => true },
    bootstrap: { generation: { id: "original", endpoint: join(directory, "app", "control.sock"), runtimeDataDirectory: data,
      executable: process.execPath, bundle: process.argv[1]!, node: process.execPath, cwd: root } } };
  let service: Awaited<ReturnType<typeof startCodexGenerationService>> | undefined;
  let peer: GenerationPeer | undefined;
  const rpc = (path: string, value?: unknown) => new Promise<any>((resolve, reject) => {
    const req = request({ socketPath: endpoint, path, method: value ? "POST" : "GET", headers: { authorization: `Bearer ${token}` } }, response => {
      const chunks: Buffer[] = []; response.on("data", b => chunks.push(b)); response.on("end", () => resolve({ status: response.statusCode, ...JSON.parse(Buffer.concat(chunks).toString()) }));
    }); req.on("error", reject); req.end(value ? JSON.stringify(value) : undefined);
  });
  const input = async () => { const { handoff: h } = await rpc("/owner-handoff"); return { expectedOwner: h.owner, expectedEpoch: h.epoch, operationId: "handoff", fence: "fence" }; };
  const action = async (action: string, extra = {}) => rpc("/owner-handoff", { action, ...await input(), ...extra });
  try {
    service = await startCodexGenerationService(options);
    peer = (await GenerationPeer.open(service.nativeSocket, {}, { message() {}, disconnected() {} })).peer;
    assert.equal((await peer.call("thread/list", {}) as any).data[0].id, "historical");
    await action("fence");
    assert.equal((await rpc("/health")).status, 503);
    await assert.rejects(peer.call("thread/resume", { threadId: "historical" }), /fenced/);
    await assert.rejects(GenerationPeer.open(service.nativeSocket, {}, { message() {}, disconnected() {} }));
    assert.equal((await action("inspect")).proof.counts.subscriptions, 1);
    peer.close(); peer = undefined;
    await new Promise(r => setTimeout(r, 30));
    pending = 1; assert.equal((await action("inspect")).proof.counts.nativeAdmission, 1);
    assert.equal((await action("release", { proof: "fake" })).status, 503); pending = 0;
    const proof = (await action("inspect")).proof; assert.equal(proof.activeCount, 0);
    assert.equal((await action("release", { proof: proof.identity })).status, 200);
    await service.close(); service = await startCodexGenerationService(options);
    const cold = await action("cold-ready"); assert.equal(cold.status, 200);
    const oldInput = await input();
    const started = performance.now(); await service.close(); service = await startCodexGenerationService(options);
    assert.equal((await rpc("/owner-handoff", { action: "resume", ...oldInput, identity: cold.ready.identity })).status, 503);
    const recovered = await action("cold-ready"); assert.equal(recovered.status, 200);
    assert.equal((await action("resume", { identity: recovered.ready.identity })).status, 200);
    const recoveryMs = performance.now() - started;
    peer = (await GenerationPeer.open(service.nativeSocket, {}, { message() {}, disconnected() {} })).peer;
    assert.equal((await peer.call("thread/resume", { threadId: "historical" }) as any).thread.id, "historical");
    assert.equal(resumes, 1); assert.equal(calls.filter(m => m === "turn/start").length, 0);
    console.info(JSON.stringify({ routerServiceRecoveryMs: recoveryMs, nativePreserved: true, resumes }));
  } finally {
    peer?.close(); await service?.close(); await core.close(); for (const socket of wss.clients) socket.terminate(); wss.close(); await new Promise<void>(r => http.close(() => r())); await rm(root, { recursive: true, force: true });
  }
});

test("unsupported retired durable history blocks source release while abort remains possible", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-router-retired-"));
  const runtime = new CodexGenerationRuntime({ directory: root, dataDirectory: root, proxyBaseUrl: "http://127.0.0.1:1",
    requireHostUsage: false, replaceRetiredHome: async () => {}, supervisor: { start: async () => { throw Error("No start"); }, identify: async () => { throw Error("No identity"); }, stop: async () => {}, discardUnready: async () => {}, processesQuiet: async () => false } });
  try {
    for (const id of ["old","new"]) { runtime.registry.register({ id, endpoint: join(root,id,"control.sock"), runtimeDataDirectory: join(root,id,"data"), executable: process.execPath, bundle: process.argv[1]!, node: process.execPath, cwd: root }); runtime.registry.ready(id); }
    runtime.registry.activate("old",0); runtime.registry.discover("retired-history","old"); runtime.registry.activate("new",1);
    runtime.registry.fenceRetirement("old",1); runtime.registry.retire("old",1);
    const input=()=>({ expectedOwner:runtime.owner.owner, expectedEpoch:runtime.owner.snapshot().epoch, operationId:"retired",fence:"fence" });
    runtime.owner.fence(input()); const observation=await runtime.handoffObservation();
    assert.ok(observation.counts.lifecycle>0);
    const proof=runtime.owner.inspect(input(),observation); assert.notEqual(proof.activeCount,0);
    assert.throws(()=>runtime.owner.release({...input(),proof:proof.identity},observation,"config"),/drained/);
    runtime.owner.abort(input()); assert.ok(runtime.owner.isOpen());
  } finally { await runtime.close(); await rm(root,{recursive:true,force:true}); }
});
