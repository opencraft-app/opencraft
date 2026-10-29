import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexGenerationRuntime } from "../../apps/codex-core/src/generation-runtime.js";
import { payloadFileHash, type AppPayloadRequest } from "../../apps/codex-core/src/generation-app-payload.js";
import type { GenerationRecord } from "../../apps/codex-core/src/generation-registry.js";
import type { GenerationSupervisor } from "../../apps/codex-core/src/generation-supervisor.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "oc-app-only-"));
  const path = (name: string) => join(root, name);
  for (const name of ["old-cli", "new-cli", "old-app", "new-app", "node", "entrypoint", "native"]) await writeFile(path(name), name);
  const starts: GenerationRecord[] = [], validations: GenerationRecord[] = [], discarded: string[] = [];
  let failedStart = false, callbackVersion: 1 | undefined = 1, duringValidation = async () => {}, beforeInspect = async () => {}, beforeDiscard = async () => {};
  const health = (g: GenerationRecord) => ({ protocolVersion: 1 as const, pid: 10, codexPid: 20,
    dataDirectory: root, proxyBaseUrl: "http://127.0.0.1:1234", codexHome: join(g.runtimeDataDirectory, "runtime"), nativeSocket: path("native.sock"),
    callbackProtocolVersion: callbackVersion, pendingCallbacks: 0, pendingOrchestrationMutations: 0 });
  const supervisor: GenerationSupervisor = {
    async start(g) { starts.push(g); if (failedStart) throw new Error("synthetic APP startup failure"); return health(g); },
    async inspect(g) { await beforeInspect(); return health(g); },
    async identify(g) { return { ownerPid: 10, nativePid: 20, ownerStart: "1", nativeStart: "2", cliSha256: await payloadFileHash(g.nativeLauncher?.executable ?? g.executable), cliVersion: `codex-cli ${g.executable === path("old-cli") ? "0.162.0" : "0.162.1"}`, unit: g.id }; },
    async stop() {}, async discardUnready(g) { await beforeDiscard(); discarded.push(g.id); }, async processesQuiet() { return true; },
  };
  const options = { directory: path("registry"), dataDirectory: root, proxyBaseUrl: "http://127.0.0.1:1234", supervisor, requireHostUsage: false,
    replaceRetiredHome: async (_old: GenerationRecord, replacement: GenerationRecord, _ids: readonly string[], opts?: { appBundleOnly: boolean }) => {
      validations.push(replacement); assert.equal(opts?.appBundleOnly, true); await duringValidation(); return { originalHomeReplaced: false };
    } };
  let runtime = new CodexGenerationRuntime(options);
  for (const id of ["old", "new"]) await runtime.prepare({ id, endpoint: path(`${id}/control.sock`), runtimeDataDirectory: path(`${id}/data`),
    executable: path(`${id}-cli`), bundle: path(`${id}-app`), node: path("node"), cwd: root,
    nativeLauncher: { entrypoint: path("entrypoint"), executable: path("native") } });
  await runtime.activate("old", 0); runtime.registry.discover("old-thread", "old"); await runtime.activate("new", 1);
  const request = async (name = "new-app"): Promise<AppPayloadRequest> => ({ id: "old", bundle: path(name), bundleSha256: await payloadFileHash(path(name)),
    expectedIncarnation: runtime.registry.get("old")!.incarnation, expectedEpoch: runtime.registry.epoch(), expectedOwner: runtime.registry.ownerEpoch, expectedHost: runtime.preparationOwner() });
  const retire = (id = "old") => { const g = runtime.registry.get(id)!; runtime.registry.fenceRetirement(id, g.incarnation); runtime.registry.retire(id, g.incarnation); };
  return { path, request, retire, starts, validations, discarded, get runtime() { return runtime; },
    async spare() { return runtime.prepare({ id: "spare", endpoint: path("spare/control.sock"), runtimeDataDirectory: path("spare/data"), executable: path("old-cli"), bundle: path("old-app"), node: path("node"), cwd: root }); },
    beforeDiscard(fn: () => Promise<void>) { beforeDiscard = fn; },
    failStart(v: boolean) { failedStart = v; }, callbackVersion(v: 1 | undefined) { callbackVersion = v; },
    duringValidation(fn: () => Promise<void>) { duringValidation = fn; }, beforeInspect(fn: () => Promise<void>) { beforeInspect = fn; },
    async reopen() { await runtime.close(); runtime = new CodexGenerationRuntime(options); },
    async close() { await runtime.close(); await rm(root, { recursive: true, force: true }); } };
}

test("APP-only choice survives router replacement, changes only bundle and pins CLI 0.162.0 over newer default", async () => {
  const f = await fixture();
  try {
    const before = f.runtime.registry.get("old")!, cliHash = await payloadFileHash(before.executable);
    f.callbackVersion(undefined); // An unsupported source is upgraded as normal maintenance, never exact handoff.
    await f.runtime.selectAppPayload(await f.request()); f.retire(); f.callbackVersion(1); await f.reopen();
    await f.runtime.ensure("old");
    const after = f.runtime.registry.get("old")!;
    for (const key of ["executable", "node", "cwd", "runtimeDataDirectory", "endpoint", "executionUid", "executionGid", "nativeLauncher"] as const) assert.deepEqual(after[key], before[key]);
    assert.equal(after.bundle, f.path("new-app")); assert.equal(await payloadFileHash(after.executable), cliHash);
    assert.equal((f.runtime.registry.metadata("runtime:old") as any).cliVersion, "codex-cli 0.162.0");
    assert.equal(f.validations[0]!.executable, before.executable);
    f.runtime.registry.discover("still-old-thread", "old"); assert.equal(f.runtime.registry.route("old-thread")!.generationId, "old");
    // A later ordinary cold open must retain the durable APP-only choice as well.
    await f.runtime.selectAppPayload(await f.request());
    f.retire(); await f.runtime.ensure("old", true, true);
    assert.equal(f.runtime.registry.get("old")!.executable, before.executable);
  } finally { await f.close(); }
});

test("selection rejects stale owner/Host/epoch/incarnation, active default and any CLI field", async () => {
  const f = await fixture();
  try {
    const req = await f.request();
    for (const mutation of [{ expectedOwner: "old-owner" }, { expectedHost: "old-host" }, { expectedEpoch: 0 }, { expectedIncarnation: 0 }, { id: "new" }, { executable: f.path("new-cli") }]) {
      await assert.rejects(f.runtime.selectAppPayload({ ...req, ...mutation }));
    }
    assert.equal(f.runtime.registry.metadata("app-payload:old"), null);
  } finally { await f.close(); }
});

test("selection holds a lifecycle lease while observing source and rechecks epoch after awaits", async () => {
  const f = await fixture(); let release!: () => void, entered!: () => void;
  try {
    const reached = new Promise<void>(resolve => { entered = resolve; });
    f.beforeInspect(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
    const choosing = f.runtime.selectAppPayload(await f.request()); await reached;
    await assert.rejects(f.runtime.ensure("old")); assert.deepEqual((await f.runtime.retire("old")).reasons, ["lifecycle-operation"]);
    f.runtime.registry.activate("old", f.runtime.registry.epoch()); release();
    await assert.rejects(choosing, /identity changed/); assert.equal(f.runtime.registry.metadata("app-payload:old"), null);
  } finally { release?.(); await f.close(); }
});

test("changed CLI bytes or target bytes block before candidate launch, including validation-time mutation", async () => {
  for (const name of ["old-cli", "new-app"]) {
    const f = await fixture();
    try {
      await f.runtime.selectAppPayload(await f.request()); f.retire();
      const n = f.starts.length; await writeFile(f.path(name), "changed");
      await assert.rejects(f.runtime.ensure("old", false, true)); assert.equal(f.starts.length, n); assert.equal(f.runtime.registry.get("old")!.state, "retired");
    } finally { await f.close(); }
  }
  const f = await fixture();
  try {
    await f.runtime.selectAppPayload(await f.request()); f.retire();
    f.duringValidation(async () => { await writeFile(f.path("old-cli"), "changed during validation"); });
    await assert.rejects(f.runtime.ensure("old", false, true), /fixed runtime file changed/); assert.equal(f.runtime.registry.get("old")!.state, "retired");
  } finally { await f.close(); }
});

test("failed target is never admitted; explicit old APP recovery stops candidate and keeps current HOME and CLI", async () => {
  const f = await fixture();
  try {
    await f.runtime.selectAppPayload(await f.request()); f.retire(); f.failStart(true);
    await assert.rejects(f.runtime.ensure("old", false, true), /startup failure/);
    assert.equal(f.runtime.registry.get("old")!.state, "candidate"); assert.equal(f.runtime.registry.valid(f.runtime.registry.route("old-thread")!), false);
    await writeFile(f.path("old/data/runtime/after-failure.txt"), "current data must survive");
    await f.runtime.selectAppPayload(await f.request("old-app")); assert.deepEqual(f.discarded, ["old"]);
    f.failStart(false); f.callbackVersion(undefined); await f.runtime.ensure("old", false, true);
    assert.equal(f.runtime.registry.get("old")!.bundle, f.path("old-app")); assert.equal(f.runtime.registry.get("old")!.executable, f.path("old-cli"));
    assert.equal(await readFile(f.path("old/data/runtime/after-failure.txt"), "utf8"), "current data must survive");
  } finally { await f.close(); }
});

test("new APP missing callback observations cannot become ready", async () => {
  const f = await fixture();
  try {
    await f.runtime.selectAppPayload(await f.request()); f.retire(); f.callbackVersion(undefined);
    await assert.rejects(f.runtime.ensure("old", false, true), /idle callback protocol/);
    assert.equal(f.runtime.registry.get("old")!.state, "candidate");
  } finally { await f.close(); }
});

test("cold HOME validation records copy and validation time separately without replacing original data", async () => {
  const { coldHomeValidator } = await import("../../apps/codex-core/src/generation-cold-home.js");
  const { createServer } = await import("node:http"), { WebSocketServer } = await import("ws");
  const { mkdir } = await import("node:fs/promises"), { DatabaseSync } = await import("node:sqlite");
  const root = await mkdtemp(join(tmpdir(), "oc-app-copy-")), nativeSocket = join(root, "native.sock");
  const server = createServer(), wss = new WebSocketServer({ server }), calls: string[] = [];
  wss.on("connection", socket => socket.on("message", raw => {
    const m = JSON.parse(String(raw)); calls.push(m.method);
    if (m.id !== undefined) socket.send(JSON.stringify({ id: m.id, result: m.method === "thread/list" ? { data: [] } : m.method === "thread/read" ? { thread: { id: m.params.threadId } } : {} }));
  }));
  await new Promise<void>(resolve => server.listen(nativeSocket, resolve));
  const old = { id: "old", state: "retired", incarnation: 1, endpoint: join(root, "old.sock"), runtimeDataDirectory: join(root, "old"), executable: "/fixed/codex", bundle: "/fixed/app.cjs", node: process.execPath, cwd: root } as GenerationRecord;
  const home = join(old.runtimeDataDirectory, "runtime"); await mkdir(home, { recursive: true });
  const db = new DatabaseSync(join(home, "state.sqlite")); db.exec("CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES('original')"); db.close();
  const before = await payloadFileHash(join(home, "state.sqlite")); let discarded = 0;
  const supervisor = {
    async start(_g: GenerationRecord, opts: { homeCopy: string }) {
      assert.notEqual(opts.homeCopy, home); await writeFile(join(opts.homeCopy, "validation-only"), "isolated");
      return { nativeSocket, callbackProtocolVersion: 1, pendingCallbacks: 0, pendingOrchestrationMutations: 0 };
    },
    async identify() { return { cliSha256: "fixed", cliVersion: "codex-cli 0.162.0" }; },
    async stop() {}, async discardUnready() { discarded++; },
  } as unknown as GenerationSupervisor;
  try {
    const validator = coldHomeValidator({ directory: join(root, "checks"), socketParentDirectory: root, supervisor });
    const receipt = await validator(old, old, ["historic"], { appBundleOnly: true }) as any;
    assert.equal(receipt.originalHomeReplaced, false); assert.equal(await payloadFileHash(join(home, "state.sqlite")), before);
    await assert.rejects(readFile(join(home, "validation-only")), { code: "ENOENT" });
    assert.equal(receipt.backupDatabases, 1); assert.equal(receipt.migratedDatabases, 1); assert.equal(discarded, 1);
    assert.ok(Number.isSafeInteger(receipt.timings.copyMs)); assert.ok(Number.isSafeInteger(receipt.timings.validationMs));
    assert.ok(receipt.timings.totalMs >= receipt.timings.copyMs + receipt.timings.validationMs);
    assert.ok(calls.includes("thread/read")); assert.equal(calls.includes("thread/resume"), false); assert.equal(calls.includes("turn/start"), false);
  } finally { for (const ws of wss.clients) ws.terminate(); wss.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});


test("a failed APP candidate with admitted history cannot be discarded", async () => {
  const f = await fixture();
  try {
    await f.runtime.selectAppPayload(await f.request()); f.retire(); f.failStart(true);
    await assert.rejects(f.runtime.ensure("old", false, true));
    await assert.rejects(f.runtime.discard("old"), /cannot be discarded/); assert.deepEqual(f.discarded, []);
    assert.equal(f.runtime.registry.get("old")!.state, "candidate"); assert.equal(f.runtime.registry.route("old-thread")!.generationId, "old");
  } finally { await f.close(); }
});

test("discard and explicit APP recovery exclude each other throughout asynchronous candidate stop", async () => {
  for (const discardFirst of [true, false]) {
    const f = await fixture(); let release!: () => void, entered!: () => void;
    try {
      const spare = await f.spare();
      const req = { ...await f.request(), id: "spare", expectedIncarnation: spare.incarnation };
      await f.runtime.selectAppPayload(req); f.retire("spare"); f.failStart(true);
      await assert.rejects(f.runtime.ensure("spare", false, true));
      const reached = new Promise<void>(resolve => { entered = resolve; });
      f.beforeDiscard(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
      const restore = { ...req, bundle: f.path("old-app"), bundleSha256: await payloadFileHash(f.path("old-app")) };
      const first = discardFirst ? f.runtime.discard("spare") : f.runtime.selectAppPayload(restore);
      await reached;
      await assert.rejects(discardFirst ? f.runtime.selectAppPayload(restore) : f.runtime.discard("spare"));
      await assert.rejects(f.runtime.ensure("spare", false, true));
      release(); await first;
      if (discardFirst) assert.equal(f.runtime.registry.get("spare")!.state, "discarded");
      else { f.failStart(false); await f.runtime.ensure("spare", false, true); assert.equal(f.runtime.registry.get("spare")!.state, "ready"); assert.equal(f.runtime.registry.get("spare")!.executable, f.path("old-cli")); }
      assert.equal(f.runtime.registry.valid(f.runtime.registry.route("old-thread")!), true, "the admitted original generation remains usable");
    } finally { release?.(); await f.close(); }
  }
});
