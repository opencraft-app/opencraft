import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { CodexGenerationRegistry } from "../../apps/codex-core/src/generation-registry.js";
import { routerDigest } from "../../apps/codex-core/src/router-maintenance.js";
import { CodexGenerationRuntime } from "../../apps/codex-core/src/generation-runtime.js";
import { startCodexGenerationService, inspectRouterMaintenanceService } from "../../apps/codex-core/src/generation-service.js";
import { startControlServer } from "../../apps/codex-core/src/control-server.js";
import { GenerationPeer } from "../../apps/codex-core/src/generation-peer.js";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";

for (const carriedHistory of [false, true]) test("real router service preserves native subscriptions and registry across release, candidate failure and current-data recovery (history=" + carriedHistory + ")", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-router-service-"));
  const data = join(root, "data"), directory = join(root, "sockets"), registry = join(root, "registry"), native = join(root, "native.sock");
  await mkdir(data, { mode: 0o700 }); await mkdir(directory, { mode: 0o700 });
  const token = "synthetic-router-private-control-token", endpoint = join(directory, "control.sock"), coreEndpoint = join(root, "core.sock");
  const calls: string[] = []; let pending = 0, resumes = 0, rejectHistory = false, coreProxy = 0;
  const unavailable = new Set<string>();
  const http = createServer(), wss = new WebSocketServer({ server: http });
  wss.on("connection", socket => socket.on("message", raw => {
    const m = JSON.parse(String(raw)); calls.push(m.method);
    if (m.id === undefined) return;
    if (m.method === "thread/read" && (rejectHistory || unavailable.has(m.params.threadId))) { socket.send(JSON.stringify({ id: m.id, error: { code: -32600, message: "Historical binding is unavailable" } })); return; }
    if (m.method === "thread/resume") resumes++;
    const result = m.method === "initialize" ? { userAgent: "retained-native" }
      : m.method === "thread/list" ? { data: [{ id: "historical", status: { type: "idle" } }], nextCursor: null }
      : m.method === "thread/loaded/list" ? { data: ["historical"] }
      : ["thread/read", "thread/resume"].includes(m.method) ? { thread: { id: "historical", status: { type: "idle" } } } : {};
    socket.send(JSON.stringify({ id: m.id, result }));
  }));
  await new Promise<void>(r => http.listen(native, r));
  const core = await startControlServer(coreEndpoint, token, async request => request.url === "/owner-handoff" ? ({ status: 200, value: { pid: process.pid, handoff: { protocolVersion: 1, topology: "split", phase: "open", persistence: "ready", owner: "core-fixture", epoch: 0, uncertain: [] }, proof: { counts: { oauth: 0, proxy: coreProxy, refresh: 0, requests: 0, resetCredits: 0, subscriptions: 0 } } } }) : ({ status: 200, value: {
    protocolVersion: 1, dataDirectory: data, launch: { env: { OPENCRAFT_CODEX_POOL_AUTH_TOKEN: "synthetic" }, auth: { type: "chatgptAuthTokens", accessToken: "synthetic" }, args: ['chatgpt_base_url="http://127.0.0.1:1"'] } } }));
  const health = { protocolVersion: 1 as const, pid: process.pid, codexPid: process.pid, dataDirectory: data,
    proxyBaseUrl: "http://127.0.0.1:1", codexHome: join(data, "runtime"), nativeSocket: native, callbackProtocolVersion: 1 as const,
    get pendingCallbacks() { return pending; }, pendingOrchestrationMutations: 0 };
  await mkdir(health.codexHome, { mode: 0o700 });
  const identity = { ownerPid: process.pid, nativePid: process.pid, ownerStart: "1", nativeStart: "1", unit: "fixture", cliSha256: "fixed", cliVersion: "codex-cli 0.162.1" };
  const artifacts = { cli: join(root, "fixture-cli"), node: join(root, "fixture-node"), app: join(root, "fixture-app.cjs"), launcher: join(root, "fixture-launcher.cjs"), native: join(root, "fixture-native") };
  // The injected supervisor owns the Native boundary; tiny fixed artifacts keep
  // this protocol fixture from repeatedly hashing the test runner's Node binary.
  for (const [kind, path] of Object.entries(artifacts)) await writeFile(path, `synthetic ${kind} artifact\n`, { mode: 0o600 });
  const options = { endpoint, coreEndpoint, token, tokenFile: join(root, "unused-token"), dataDirectory: data, registryDirectory: registry,
    systemdScope: "system" as const, requireHostUsage: false, supervisor: {
      start: async () => health, inspect: async () => health, identify: async () => identity,
      stop: async () => { throw Error("Router cannot stop native"); }, discardUnready: async () => {}, processesQuiet: async () => true },
    bootstrap: { generation: { id: "original", endpoint: join(directory, "app", "control.sock"), runtimeDataDirectory: data,
      executable: artifacts.cli, bundle: artifacts.app, node: artifacts.node, nativeLauncher: { entrypoint: artifacts.launcher, executable: artifacts.native }, cwd: root } } };
  let service: Awaited<ReturnType<typeof startCodexGenerationService>> | undefined;
  let peer: GenerationPeer | undefined;
  const rpc = (path: string, value?: unknown) => new Promise<any>((resolve, reject) => {
    const req = request({ socketPath: endpoint, path, method: value ? "POST" : "GET", headers: { authorization: `Bearer ${token}` } }, response => {
      const chunks: Buffer[] = []; response.on("data", b => chunks.push(b)); response.on("end", () => resolve({ status: response.statusCode, ...JSON.parse(Buffer.concat(chunks).toString()) }));
    }); req.on("error", reject); req.end(value ? JSON.stringify(value) : undefined);
  });
  const input = async () => { const { handoff: h } = await rpc("/owner-handoff"); return { expectedOwner: h.owner, expectedEpoch: h.epoch, operationId: "handoff", fence: "fence", historicalUnknownSha256: h.historicalUnknownSha256 }; };
  const action = async (action: string, extra = {}) => rpc("/owner-handoff", { action, ...await input(), ...extra });
  try {
    service = await startCodexGenerationService(options);
    const state = await rpc("/generations");
    const retention = { id: "original", retained: true, expectedOwner: state.routingEpoch, expectedHost: state.preparationOwner,
      expectedEpoch: state.admissionEpoch, expectedIncarnation: state.generations[0].incarnation };
    assert.equal((await rpc("/generations", { operation: "retention", params: retention })).status, 200);
    assert.equal((await rpc("/generations")).generations[0].retention.retained, true);
    peer = (await GenerationPeer.open(service.nativeSocket, {}, { message() {}, disconnected() {} })).peer;
    assert.equal((await peer.call("thread/list", {}) as any).data[0].id, "historical");
    await action("fence");
    assert.equal((await rpc("/generations", { operation: "retention", params: { ...retention, retained: false } })).status, 503);
    assert.equal((await rpc("/health")).status, 503);
    await assert.rejects(peer.call("thread/resume", { threadId: "historical" }), /fenced/);
    await assert.rejects(GenerationPeer.open(service.nativeSocket, {}, { message() {}, disconnected() {} }));
    assert.equal((await action("inspect")).proof.counts.subscriptions, 1);
    peer.close(); peer = undefined;
    await new Promise(r => setTimeout(r, 30));
    pending = 1; assert.equal((await action("inspect")).proof.counts.nativeAdmission, 1);
    assert.equal((await action("release", { proof: "fake" })).status, 503); pending = 0;
    const initiallyReadable = (await action("inspect")).proof; assert.equal(initiallyReadable.activeCount, 0);
    rejectHistory = true;
    assert.equal((await action("release", { proof: initiallyReadable.identity })).status, 503, "release rechecks Native history after inspection");
    const rejected = (await action("inspect")).proof; assert.equal(rejected.coverage, "unknown"); assert.equal(rejected.activeCount, null);
    assert.equal((await rpc("/owner-handoff")).handoff.phase, "fenced");
    assert.equal((await action("abort")).status, 200, "unreadable history leaves the original source recoverable");
    rejectHistory = false; await action("fence");
    const proof = (await action("inspect")).proof; assert.equal(proof.activeCount, 0);
    assert.equal((await action("release", { proof: proof.identity })).status, 200);
    await service.close();
    if (carriedHistory) {
      // Persist the already-imported responsibility fixture while the source is
      // released. The service must exercise its real historical cold reader.
      const registryOwner = new CodexGenerationRegistry(registry);
      const entries = ["empty-one", "empty-two"].map(threadId => ({ generationId: "original", incarnation: 1, threadId,
        reads: [false, true].map(includeTurns => ({ includeTurns, code: -32600, errorSha256: routerDigest({ code: -32600, message: "Historical binding is unavailable" }) })),
        creation: { phase: "created", inputId: null, turnId: null, executionLeases: 0, submissions: 0, queueInputs: 0, turnAuthorities: 0, inputAuthorities: 0, inputOrigins: 0, actorRequests: 0, nativeRows: 0 } }));
      for (const entry of entries) { registryOwner.discover(entry.threadId, "original"); unavailable.add(entry.threadId); }
      const archive = { version: 1, receipt: { source: { owner: "prior-router" }, sourceHandoff: { version: 1, uncertain: true, pending: ["legacy-unknown"] },
        native: { hostColdUnavailable: { version: 1, kind: "host-cold-unavailable", source: { owner: "prior-router", bootId: "prior-boot" }, checkedAt: new Date(Date.now() - 16 * 60_000).toISOString(), evidenceSha256: "e".repeat(64), entries } } } };
      const id = routerDigest(archive);
      registryOwner.setMetadata(`router-history:${id}`, archive);
      const state = registryOwner.metadata("router-handoff") as Record<string, unknown>;
      registryOwner.setMetadata("router-handoff", { ...state, history: [id], pending: ["legacy-unknown"], uncertain: true, currentUncertain: false, sealed: routerDigest(registryOwner.coldSnapshot()) });
      registryOwner.close();
      const inspection = await inspectRouterMaintenanceService(options, true);
      assert.equal(inspection.sourceHandoff && (inspection.sourceHandoff as any).phase, "released");
      assert.equal(inspection.native.generations[0]!.history.coldUnavailable!.length, 2, "released collector inherits the archive after the physical seal was cleared");
    }
    service = await startCodexGenerationService(options);
    for (const kind of ["launcher", "native"] as const) {
      await writeFile(artifacts[kind], "changed fixed launcher artifact\n");
      assert.equal((await action("cold-ready")).status, 503);
      await writeFile(artifacts[kind], `synthetic ${kind} artifact\n`);
    }
    const cold = await action("cold-ready"); assert.equal(cold.status, 200);
    if (carriedHistory) {
      const inspection = await inspectRouterMaintenanceService(options, true);
      assert.equal((inspection.sourceHandoff as any).phase, "cold-ready");
      assert.equal(inspection.native.generations[0]!.history.coldUnavailable!.length, 2);
    }
    const oldInput = await input();
    const started = performance.now(); await service.close(); service = await startCodexGenerationService(options);
    assert.equal((await rpc("/owner-handoff", { action: "resume", ...oldInput, identity: cold.ready.identity })).status, 503);
    const recovered = await action("cold-ready"); assert.equal(recovered.status, 200);
    assert.equal((await action("resume", { identity: recovered.ready.identity })).status, 200);
    assert.equal((await rpc("/generations")).generations[0].retention.retained, true);
    assert.equal((await rpc("/generations", { operation: "retention", params: { ...retention, retained: false } })).status, 503, "replacement writer rejects a stale retention selection");
    const recoveryMs = performance.now() - started;
    peer = (await GenerationPeer.open(service.nativeSocket, {}, { message() {}, disconnected() {} })).peer;
    assert.equal((await peer.call("thread/resume", { threadId: "historical" }) as any).thread.id, "historical");
    assert.equal(resumes, 1); assert.equal(calls.filter(m => m === "turn/start").length, 0);
    if (carriedHistory) {
      await action("fence"); coreProxy = 1;
      const busy = (await action("inspect")).proof;
      assert.equal(busy.counts.subscriptions, 1);
      assert.equal(busy.coverage, "unknown", "an active Core proxy blocks drain while the original consumer remains subscribed");
      assert.equal(busy.activeCount, null);
      coreProxy = 0;
      const quiet = (await action("inspect")).proof;
      assert.equal(quiet.coverage, "complete"); assert.equal(quiet.activeCount, 1);
      assert.equal((await action("abort")).status, 200);
      assert.deepEqual((await rpc("/owner-handoff")).handoff.pending, ["legacy-unknown"]);
    }
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

test("unconfirmed router callbacks prevent background native retirement", async () => {
  const root=await mkdtemp(join(tmpdir(),"oc-router-unknown-retire-")); let stops=0;
  const runtime=new CodexGenerationRuntime({directory:root,dataDirectory:root,proxyBaseUrl:"http://127.0.0.1:1",requireHostUsage:false,replaceRetiredHome:async()=>{},supervisor:{
    start:async()=>{throw Error("Native observation must not start while outcome is unknown");},identify:async()=>{throw Error("No identity");},stop:async()=>{stops++;},discardUnready:async()=>{},processesQuiet:async()=>true}});
  try{
    for(const id of ["old","new"]){runtime.registry.register({id,endpoint:join(root,id,"control.sock"),runtimeDataDirectory:join(root,id,"data"),executable:process.execPath,bundle:process.argv[1]!,node:process.execPath,cwd:root});runtime.registry.ready(id);}
    runtime.registry.activate("old",0);runtime.registry.activate("new",1);runtime.owner.uncertain();
    const result=await runtime.retire("old");assert.equal(result.retired,false);assert.ok(result.reasons.includes("router-outcome-unknown"));
    assert.equal(stops,0);assert.equal(runtime.registry.get("old")!.state,"draining");
  }finally{await runtime.close();await rm(root,{recursive:true,force:true});}
});
