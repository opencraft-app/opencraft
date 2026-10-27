import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile, chown, chmod, copyFile, cp, stat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { zstdDecompressSync, gunzipSync } from "node:zlib";
import WebSocket from "ws";
import { AccountPoolStore, CodexCoreControlClient } from "@opencraft/account-pool-host";
import { SystemdGenerationSupervisor } from "../../../apps/codex-core/src/generation-supervisor.js";
import { generationCopyOwner, generationDirectory } from "../../../apps/codex-core/src/generation-files.js";
import { CodexGenerationRegistry } from "../../../apps/codex-core/src/generation-registry.js";
import { CodexNativeStorage } from "../../../apps/opencraft-daemon/src/codex-native-storage.js";
import { readUsageIncrement } from "../../../apps/opencraft-daemon/src/token-usage-derived-source.js";
import { TranscriptReadCache } from "@opencraft/native-history-node";

// Run with a clean environment. Only synthetic accounts and loopback model traffic.
const oldCli = process.env.OPENCRAFT_CODEX_OLD_EXECUTABLE, newCli = process.env.OPENCRAFT_CODEX_NEW_EXECUTABLE;
if (!oldCli || !newCli || process.env.OPENCRAFT_GENERATION_DRILL_ISOLATED !== "1") throw new Error("Explicit isolated environment and two fixed CLIs required");
const versions = [oldCli, newCli].map(path => execFileSync(path, ["--version"], { encoding: "utf8" }).trim());
assert.notEqual(versions[0], versions[1], "exercise two actual CLI versions");
const evidence = await mkdtemp(join(process.env.OPENCRAFT_CORE_DRILL_ROOT ?? tmpdir(), "generation-drill-"));
const runtimeParent = process.env.OPENCRAFT_GENERATION_RUNTIME_ROOT ?? "/run/opencraft-generation-drills";
await mkdir(runtimeParent, { recursive: true, mode: 0o755 });
const root = await mkdtemp(join(runtimeParent, "g-"));
await mkdir(join(root, "home"), { mode: 0o700 });
const executionUid = Number(process.env.OPENCRAFT_DRILL_EXECUTION_UID ?? process.getuid!()), executionGid = Number(process.env.OPENCRAFT_DRILL_EXECUTION_GID ?? process.getgid!());
const adopting = process.env.OPENCRAFT_DRILL_ADOPT_EXTERNAL === "1";
if (executionUid !== process.getuid!()) await generationCopyOwner(root, executionUid, executionGid);
const executionNode = executionUid === process.getuid!() ? process.execPath : join(root, "execution-node");
if (executionNode !== process.execPath) { await copyFile(process.execPath, executionNode); await chmod(executionNode, 0o755); }
const token = "synthetic-generation-control-".repeat(3), tokenFile = join(root, "token");
await writeFile(tokenFile, token, { mode: 0o600 }); await chown(tokenFile, executionUid, executionGid);
const counts = new Map<string, number>(), requests: { scenario: string; count: number; at: number }[] = [];
const markers = { shell: join(root, "shell"), barrier: join(root, "switched") };
let ticks = 0;
function event(response: ServerResponse, value: any) { response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`); }
function finish(response: ServerResponse, id: string, item: any) {
  event(response, { type: "response.output_item.done", output_index: 0, item });
  event(response, { type: "response.completed", response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); response.end();
}
const model = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    if (request.url === "/usage") { response.setHeader("content-type", "application/json"); response.end('{"plan_type":"pro"}'); return; }
    if (request.url?.endsWith("/models")) { response.end('{"data":[]}'); return; }
    if (request.url?.includes("/mcp")) {
      if (request.method === "GET") { response.writeHead(405); response.end(); return; }
      const input = JSON.parse(Buffer.concat(chunks).toString());
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result: input.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "synthetic", version: "1" } } : { tools: [] } })); return;
    }
    if (request.url !== "/responses") { response.writeHead(404); response.end(); return; }
    const raw = Buffer.concat(chunks), body = JSON.parse((request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : request.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString());
    const input = JSON.stringify(body.input), scenario = ["OLD-STREAM", "OLD-SHELL", "NEW-THREAD", "OLD-AGAIN", "COLD-HOME", "AFTER-ROLLBACK"].sort((a, b) => input.lastIndexOf(b) - input.lastIndexOf(a)).find(key => input.includes(key)) ?? "OTHER";
    const count = (counts.get(scenario) ?? 0) + 1; counts.set(scenario, count); requests.push({ scenario, count, at: Date.now() });
    response.writeHead(200, { "content-type": "text/event-stream", "x-codex-primary-used-percent": "10" });
    const id = `${scenario}-${count}`;
    event(response, { type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } });
    const outputs = (body.input ?? []).filter((item: any) => item.type === "function_call_output");
    if (scenario === "OLD-SHELL" && !outputs.length) {
      assert.ok(body.tools.some((tool: any) => tool.name === "exec_command"));
      const item = { type: "function_call", id: "shell", call_id: "shell-once", name: "exec_command", arguments: JSON.stringify({ cmd: `echo start >> '${markers.shell}'; sleep 36; while [ ! -f '${markers.barrier}' ]; do sleep 0.1; done; echo done >> '${markers.shell}'`, yield_time_ms: 1000, max_output_tokens: 500 }) };
      event(response, { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } }); finish(response, id, item); return;
    }
    if (scenario === "OLD-SHELL" && !await readFile(markers.shell, "utf8").then(text => text.includes("done"), () => false)) {
      const session = /(?:session ID|session_id)[^\d]*(\d+)/i.exec(String(outputs.at(-1)?.output ?? ""))?.[1]; assert.ok(session);
      finish(response, id, { type: "function_call", id: `wait-${count}`, call_id: `wait-${count}`, name: "write_stdin", arguments: JSON.stringify({ session_id: Number(session), chars: "", yield_time_ms: 1000, max_output_tokens: 500 }) }); return;
    }
    const item = { type: "message", id: `message-${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "GENERATION_OK", annotations: [] }] };
    event(response, { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
    for (let i = 0; i < (scenario === "OLD-STREAM" ? 35 : 1) && !response.destroyed; i++) { await delay(1000); ticks++; event(response, { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "tick " }); }
    if (!response.destroyed) finish(response, id, item);
  } catch (reason) { console.error("synthetic model failure", reason); response.end(); }
});
async function listen(server: ReturnType<typeof createServer>) { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); return (server.address() as import("node:net").AddressInfo).port; }
const modelPort = await listen(model), reservation = createServer(), proxyPort = await listen(reservation); await new Promise<void>(resolve => reservation.close(() => resolve()));
const dataDirectory = join(root, "data"), endpoint = join(root, "account/control.sock"), routerEndpoint = join(root, "routing/control.sock");
const store = new AccountPoolStore({ databasePath: join(dataDirectory, "account-pool.sqlite"), secretsDirectory: join(dataDirectory, "secrets") });
store.addAccount({ id: "synthetic", provider: "codex", label: "Synthetic", upstreamAccountId: "synthetic", enabled: true, priority: 0 }, { accessToken: "synthetic-no-external-access", refreshToken: null, expiresAt: null }); store.close(); await generationCopyOwner(dataDirectory, executionUid, executionGid);
const cwd = process.env.OPENCRAFT_DRILL_SOURCE_ROOT ?? resolve(import.meta.dirname, "../../.."), control = new CodexCoreControlClient(endpoint, token);
let executionOldCli = oldCli, executionNewCli = newCli, executionBundle = join(cwd, "apps/codex-core/dist/app-server.cjs");
{
  await cp(dirname(dirname(oldCli)), join(root, "cli-old"), { recursive: true });
  await cp(dirname(dirname(newCli)), join(root, "cli-new"), { recursive: true });
  executionOldCli = join(root, "cli-old/bin/codex"); executionNewCli = join(root, "cli-new/bin/codex");
  executionBundle = join(root, "app-server.cjs"); await copyFile(join(cwd, "apps/codex-core/dist/app-server.cjs"), executionBundle);
}
const config = join(root, "core.json"); await writeFile(config, JSON.stringify({ endpoint, appServerEndpoint: routerEndpoint, proxyPort, authToken: token, executable: oldCli, dataDirectory, runtimeDirectory: root, nativeCodexHomeDirectory: join(root, "native"), upstreamBaseUrl: `http://127.0.0.1:${modelPort}` }), { mode: 0o600 });
let core: ChildProcess | undefined, service: Awaited<ReturnType<typeof startRoutingOwner>> | undefined;
let socket: WebSocket | undefined;
async function wait(check: () => unknown | Promise<unknown>, label: string, timeout = 90_000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { try { if (await check()) return; } catch {} await delay(50); } throw new Error(`Timed out: ${label}`); }
const definition = (id: string, executable: string) => ({ id, endpoint: join(root, "routing", id, "control.sock"), runtimeDataDirectory: adopting && id === "old" ? dataDirectory : join(root, id, "data"), executable, bundle: executionBundle, node: executionNode, cwd: root, executionUid, executionGid });
const bootstrap: { generation: import("../../../apps/codex-core/src/generation-registry.js").GenerationDefinition; legacy?: boolean } = { generation: definition("old", executionOldCli), ...(adopting ? { legacy: true } : {}) };
const options = { endpoint: routerEndpoint, coreEndpoint: endpoint, tokenFile, token, dataDirectory, registryDirectory: process.env.OPENCRAFT_DRILL_REGISTRY_DIRECTORY ?? join(evidence, "registry"), systemdScope: "system" as const, requireHostUsage: false, bootstrap };
const routingUnit = `opencraft-generation-router-drill-${createHash("sha256").update(options.registryDirectory).digest("hex").slice(0, 12)}.service`;
const routingUnderSystemd = process.env.OPENCRAFT_DRILL_ROUTING_UNIT === "1";
async function startRoutingOwner() {
  const bootstrapFile = join(root, "bootstrap.json"); await writeFile(bootstrapFile, JSON.stringify(bootstrap), { mode: 0o600 });
  const args = [join(cwd, "apps/codex-core/dist/generations.cjs"), "--endpoint", routerEndpoint, "--core-endpoint", endpoint,
    "--token-file", tokenFile, "--data-directory", dataDirectory, "--registry-directory", options.registryDirectory,
    "--systemd-scope", "system", "--native-only", "--bootstrap-file", bootstrapFile];
  if (routingUnderSystemd) {
    const loaded = execFileSync("systemctl", ["show", routingUnit, "-p", "LoadState", "--value"], { encoding: "utf8" }).trim();
    if (loaded === "not-found") execFileSync("systemd-run", ["--quiet", "--collect", "--service-type=exec", `--unit=${routingUnit}`,
      "--property=Restart=on-failure", "--property=RestartSec=1", "--property=KillMode=control-group", "--property=TimeoutStopSec=infinity",
      `--working-directory=${cwd}`, `--setenv=HOME=${join(root, "home")}`, `--setenv=TMPDIR=${root}`, "--", process.execPath, ...args]);
    else execFileSync("systemctl", ["start", routingUnit]);
    await wait(() => new CodexCoreControlClient(routerEndpoint, token).appServerHealth(), "routing systemd owner starts/recover bootstrap");
    const pid = Number(execFileSync("systemctl", ["show", routingUnit, "-p", "MainPID", "--value"], { encoding: "utf8" }).trim());
    assert.ok(pid > 0);
    assert.equal(execFileSync("systemctl", ["show", routingUnit, "-p", "RuntimeDirectory", "--value"], { encoding: "utf8" }).trim(), "", "routing unit must not own sibling socket-directory cleanup");
    return { pid, nativeSocket: join(root, "routing/native.sock"), async close(signal: NodeJS.Signals = "SIGTERM") {
      if (signal === "SIGKILL") {
        execFileSync("systemctl", ["kill", "--kill-whom=main", "--signal=SIGKILL", routingUnit]);
        await wait(() => readFile(`/proc/${pid}/stat`).then(() => false, () => true), "routing unit crashed");
      } else execFileSync("systemctl", ["stop", routingUnit]);
    } };
  }
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, HOME: join(root, "home"), TMPDIR: root }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = ""; child.stdout!.on("data", data => { output += data; }); child.stderr!.on("data", data => { errors += data; });
  child.once("exit", () => { void writeFile(join(root, `router-${child.pid}.log`), errors); });
  await wait(() => output.includes("codex-routing-owner-ready") || child.exitCode !== null, "routing owner starts/recover bootstrap");
  if (!output.includes("codex-routing-owner-ready")) throw new Error(`Routing owner startup failed: ${errors.trim()}`);
  return { pid: child.pid!, nativeSocket: join(root, "routing/native.sock"), async close(signal: NodeJS.Signals = "SIGTERM") { if (child.exitCode !== null || child.signalCode !== null) return; const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(signal); await exited; } };
}
async function admin(operation?: string, params?: object) {
  const { request } = await import("node:http");
  return new Promise<any>((resolve, reject) => { const req = request({ socketPath: routerEndpoint, path: "/generations", method: operation ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }, res => { const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("end", () => { const value = JSON.parse(Buffer.concat(chunks).toString()); res.statusCode === 200 ? resolve(value) : reject(new Error(JSON.stringify(value))); }); }); req.on("error", reject); req.end(operation ? JSON.stringify({ operation, params }) : undefined); });
}
const report: any = { root, evidence, versions, executionUid, executionGid, adopting, routingUnderSystemd, scenarios: [] };
try {
  // Reproduce a first bootstrap crash immediately after durable registration.
  core = spawn(process.execPath, (process.env.OPENCRAFT_DRILL_CORE_ENTRY ? [process.env.OPENCRAFT_DRILL_CORE_ENTRY, "core", config] : ["--import", "tsx", "tests/fixtures/split-codex-owner.ts", "core", config]), { cwd, env: { PATH: process.env.PATH, HOME: join(root, "home"), TMPDIR: root, LANG: "C.UTF-8", RUST_LOG: "error" }, stdio: ["ignore", "pipe", "pipe"] });
  const errors: string[] = []; core.stdout!.resume(); core.stderr!.on("data", c => errors.push(String(c)));
  await wait(() => control.appServerLaunch(), "account plane");
  await chown(dirname(endpoint), executionUid, executionGid); await chown(endpoint, executionUid, executionGid);
  if (adopting) {
    const g = bootstrap.generation;
    for (const path of [g.runtimeDataDirectory, join(g.runtimeDataDirectory, "runtime"), dirname(g.endpoint)]) generationDirectory(path, executionUid, executionGid);
    const staging = new SystemdGenerationSupervisor({ registryDirectory: options.registryDirectory, coreEndpoint: endpoint, dataDirectory, tokenFile, token, scope: "system" });
    const candidate = { ...g, state: "candidate" as const, incarnation: 0 };
    const h = await staging.start(candidate), identity = await staging.identify(candidate, h);
    bootstrap.generation = { ...g, externalUnit: identity.unit }; report.externalBefore = identity;
  }
  const interruptedBootstrap = new CodexGenerationRegistry(options.registryDirectory); interruptedBootstrap.register(bootstrap.generation); interruptedBootstrap.close();
  service = await startRoutingOwner();
  socket = new WebSocket(`ws+unix://${service.nativeSocket}:/`); await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); });
  let seq = 0; const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>(), notifications: any[] = [];
  const receive = (raw: WebSocket.RawData) => { const m = JSON.parse(String(raw)); if (m.id !== undefined && !m.method) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(new Error(m.error.message)) : p?.resolve(m.result); } else notifications.push(m); }; socket.on("message", receive);
  const rpc = (method: string, params: object = {}) => { const id = ++seq; return new Promise<any>((resolve, reject) => { pending.set(id, { resolve, reject }); socket!.send(JSON.stringify({ id, method, params })); }); };
  await rpc("initialize", { clientInfo: { name: "generation-native-drill", version: "1" }, capabilities: { experimentalApi: true } });
  async function turn(scenario: string, existing?: string) { const threadId = existing ?? (await rpc("thread/start", { cwd: root, model: "gpt-test", approvalPolicy: "never", sandbox: "danger-full-access" })).thread.id; const started = await rpc("turn/start", { threadId, input: [{ type: "text", text: scenario }] }); return { threadId, turnId: started.turn.id }; }
  async function completed(ids: { threadId: string; turnId: string }) { await wait(() => notifications.some(m => m.method === "turn/completed" && m.params.turn.id === ids.turnId), `turn ${ids.turnId}`); const read = await rpc("thread/read", { threadId: ids.threadId, includeTurns: true }); assert.equal(read.thread.turns.find((t: any) => t.id === ids.turnId).status, "completed"); }
  const before = await admin(), oldBefore = before.generations.find((g: any) => g.id === "old").runtime;
  if (adopting) assert.deepEqual(oldBefore, report.externalBefore, "adoption preserves existing non-root APP/native identity");
  const ephemeral = (await rpc("thread/start", { cwd: root, model: "gpt-test", approvalPolicy: "never", sandbox: "danger-full-access", ephemeral: true })).thread.id;
  const oldIdle = (await rpc("thread/start", { cwd: root, model: "gpt-test", approvalPolicy: "never", sandbox: "danger-full-access" })).thread.id;
  const stream = await turn("OLD-STREAM"), shell = await turn("OLD-SHELL"); await wait(() => ticks >= 2 && readFile(markers.shell, "utf8").then(t => t.includes("start"), () => false), "live stream and shell");
  await admin("prepare", { definition: definition("new", executionNewCli) });
  const unused = definition("unused", executionNewCli);
  await admin("prepare", { definition: unused });
  await wait(async () => {
    const revokeProof = await admin("preparation", { id: "unused" });
    await admin("revoke", { id: "unused", expectedEpoch: 1, preparation: revokeProof.preparation });
    return true;
  }, "unadmitted candidate startup children become quiet before revocation");
  assert.equal((await admin()).generations.find((g: any) => g.id === "unused").state, "discarded");
  report.scenarios.push({ name: "P2c ready unadmitted candidate revoked with original default and active work intact" });
  const activateAt = Date.now(); await admin("activate", { id: "new", expectedEpoch: 1, preparation: (await admin("preparation", { id: "new" })).preparation }); await writeFile(markers.barrier, "switched");
  const fresh = await turn("NEW-THREAD"); await completed(fresh);
  const routes = (await admin()).fences.routes;
  const homeDirectory = await control.generationDirectory(fresh.threadId);
  assert.equal(homeDirectory!.route!.generationId, "new");
  assert.deepEqual(new Set(homeDirectory!.homes.map(home => home.codexHome)), new Set([join(definition("old", executionOldCli).runtimeDataDirectory, "runtime"), join(definition("new", executionNewCli).runtimeDataDirectory, "runtime")]));
  assert.equal(routes.find((r: any) => r.threadId === fresh.threadId).generationId, "new");
  assert.ok([stream, shell].every(ids => routes.find((r: any) => r.threadId === ids.threadId).generationId === "old"));
  const storage = new CodexNativeStorage(control, () => join(dataDirectory, "runtime"));
  const freshPath = (await rpc("thread/read", { threadId: fresh.threadId })).thread.path;
  const freshSource = await storage.resolve(fresh.threadId, freshPath);
  // Keep a native turn on the new generation while its default is retracted;
  // an idle, fully drained generation may legitimately retire in the meantime.
  const retainedNew = await turn("OLD-STREAM", fresh.threadId);
  // Default rollback preserves all new-generation writes and leaves old running tasks intact.
  await admin("activate", { id: "old", expectedEpoch: 2, preparation: (await admin("preparation", { id: "old" })).preparation });
  const rollback = await turn("AFTER-ROLLBACK"); await completed(rollback);
  assert.equal((await admin()).fences.routes.find((r: any) => r.threadId === rollback.threadId).generationId, "old");
  assert.equal((await rpc("thread/read", { threadId: fresh.threadId })).thread.id, fresh.threadId);
  await admin("activate", { id: "new", expectedEpoch: 3, preparation: (await admin("preparation", { id: "new" })).preparation });
  await freshSource.validate();
  report.scenarios.push({ name: "atomic default rollback preserves current writes in both HOMEs", rollback, fresh });
  const again = await turn("OLD-AGAIN", oldIdle); await completed(again);
  const directory = await rpc("thread/list", { limit: 100 }); assert.ok([stream, shell, fresh].every(ids => directory.data.some((t: any) => t.id === ids.threadId)));
  await completed(stream); await completed(shell); await completed(retainedNew); assert.equal(await readFile(markers.shell, "utf8"), "start\ndone\n");
  assert.equal((await stat(markers.shell)).uid, executionUid, "shell retains the fixed execution UID");
  const after = await admin(); assert.deepEqual(after.generations.find((g: any) => g.id === "old").runtime, oldBefore);
  report.scenarios.push({ name: "two real CLI versions, stream and shell cross activation", stream, shell, fresh, activateAt, durationSeconds: 36, shellStarts: 1, shellCompletions: 1, oldIdentityUnchanged: true, sharedAccountCore: true });
  const cache = new TranscriptReadCache(join(root, "reader-cache"), {
    resolveSource: (threadId, path) => storage.resolve(threadId, path),
    readThread: async threadId => (await rpc("thread/read", { threadId })).thread,
    // The fixture uses the native canonical projection, never a rollout parser
    // to reconstruct message/tool semantics. Both real CLI versions are read.
    listTurns: async (threadId, cursor, limit) => {
      const turns = (await rpc("thread/read", { threadId, includeTurns: true })).thread.turns.slice().reverse();
      const offset = Number(cursor ?? 0);
      return { data: turns.slice(offset, offset + limit), nextCursor: offset + limit < turns.length ? String(offset + limit) : null };
    },
  });
  try {
    const homes = new Set<string>();
    for (const ids of [shell, fresh]) {
      const path = (await rpc("thread/read", { threadId: ids.threadId })).thread.path;
      const source = await storage.resolve(ids.threadId, path); homes.add(source.nativeHome);
      const usage = await readUsageIncrement({ path, nativeHome: "/unregistered-home", source, threadId: ids.threadId, cursor: 0, identity: null });
      assert.ok(usage.cursor > 0 && usage.events.some(row => row.event.kind === "count" || row.event.kind === "response"));
      const history = await cache.read(ids.threadId), warm = await cache.read(ids.threadId);
      assert.ok(history.initialTurnsPage.data.some(turn => turn.id === ids.turnId));
      assert.deepEqual(warm.initialTurnsPage, history.initialTurnsPage);
    }
    assert.equal(homes.size, 2);
    report.scenarios.push({ name: "both real CLI HOMEs supply scoped usage and canonical cached history after default CAS", separateHomes: 2, warmHistoryValidated: true });
  } finally { await cache.close(); }
  if (process.env.OPENCRAFT_DRILL_GENERATION_ONLY !== "1") {
  // Same old Thread remains on its original HOME after the default switch.
  const oldState = (await admin()).generations.find((g: any) => g.id === "old"); assert.equal(oldState.runtime.cliVersion, versions[0]);
  // Let the monitor retire the genuinely idle old generation, then reopen its HOME with current CLI.
  await wait(async () => (await admin()).generations.find((g: any) => g.id === "old").state === "retired", "old generation retires naturally");
  await rpc("thread/resume", { threadId: shell.threadId });
  const cold = await turn("COLD-HOME", shell.threadId); await completed(cold);
  const coldState = (await admin()).generations.find((g: any) => g.id === "old"); assert.equal(coldState.runtime.cliVersion, versions[1]); assert.equal(coldState.runtimeDataDirectory, oldState.runtimeDataDirectory);
  report.scenarios.push({ name: "old HOME retired and validated under original absolute path before cold upgrade", cold, homeUnchanged: true, ephemeralExcludedFromColdHistory: ephemeral, priorCli: oldState.runtime.cliVersion, currentCli: coldState.runtime.cliVersion });
  // Persisted default survives routing-owner replacement; workers remain independently alive.
  const identities = (await admin()).generations.map((g: any) => [g.id, g.runtime]); socket.terminate(); socket = undefined;
  const routingPidBefore = service.pid; await service.close("SIGKILL"); service = await startRoutingOwner(); assert.notEqual(service.pid, routingPidBefore);
  const restarted = await admin(); assert.equal(restarted.generations.find((g: any) => g.state === "active").id, "new");
  assert.deepEqual(restarted.generations.map((g: any) => [g.id, g.runtime]), identities);
  socket = new WebSocket(`ws+unix://${service.nativeSocket}:/`); await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); }); socket.on("message", receive);
  await rpc("initialize", { clientInfo: { name: "generation-native-drill-reconnect", version: "1" }, capabilities: { experimentalApi: true } });
  await rpc("thread/resume", { threadId: fresh.threadId });
  const reconnect = await turn("NEW-THREAD", fresh.threadId); await completed(reconnect);
  report.scenarios.push({ name: "routing owner crash preserves default and worker identities without mutation replay", identities, reconnect, beforePid: routingPidBefore, afterPid: service.pid });
  // A crashing generation must not tear down the other generation's live stream.
  await rpc("thread/resume", { threadId: shell.threadId });
  const live = await turn("OLD-STREAM", shell.threadId); const priorTicks = ticks; await wait(() => ticks > priorTicks + 1, "stream before other generation failure");
  const activeBefore = (await admin()).generations.find((g: any) => g.id === "new").runtime;
  execFileSync("systemctl", ["kill", "--kill-whom=main", "--signal=SIGKILL", activeBefore.unit]);
  await wait(async () => { const h = await control.health(); return h.appServerPid !== activeBefore.ownerPid; }, "default owner auto recovery");
  const recovered = await turn("NEW-THREAD"); await completed(recovered); await completed(live);
  assert.equal(socket.readyState, WebSocket.OPEN);
  assert.ok(notifications.some(m => m.method === "opencraft/codex/generation/lost" && m.params.generationId === "new"));
  report.scenarios.push({ name: "default generation crash recovers independently while other generation stream completes", live, recovered, before: activeBefore, after: (await admin()).generations.find((g: any) => g.id === "new").runtime });
  }
  report.scope = process.env.OPENCRAFT_DRILL_GENERATION_ONLY === "1" ? "generation-only" : "full-lifecycle";
  report.requests = requests; report.status = "passed";
} catch (reason) { report.status = "failed"; report.error = reason instanceof Error ? reason.stack : String(reason); throw reason; }
finally {
  socket?.terminate(); await service?.close();
  if (routingUnderSystemd) {
    try {
      if (execFileSync("systemctl", ["show", routingUnit, "-p", "LoadState", "--value"], { encoding: "utf8" }).trim() !== "not-found") execFileSync("systemctl", ["stop", routingUnit]);
    } catch (reason) { report.routingCleanupError = String(reason); }
  }
  try { const { CodexGenerationRegistry } = await import("../../../apps/codex-core/src/generation-registry.js"); const registry = new CodexGenerationRegistry(options.registryDirectory); const { SystemdGenerationSupervisor } = await import("../../../apps/codex-core/src/generation-supervisor.js"); const supervisor = new SystemdGenerationSupervisor({ registryDirectory: process.env.OPENCRAFT_DRILL_REGISTRY_DIRECTORY ?? options.registryDirectory, coreEndpoint: endpoint, dataDirectory, tokenFile, token, scope: "system" }); for (const g of registry.list()) { const identity = registry.metadata(`runtime:${g.id}`); if (identity && !["retired", "discarded"].includes(g.state)) await supervisor.stop(g, identity as any); else if (g.state === "candidate") await supervisor.discardUnready(g); } registry.close(); } catch (reason) { report.cleanupError = String(reason); }
  // Fixture-only fallback also cleans an owned unit that failed before registry registration.
  try {
    const prefix = `opencraft-codex-${createHash("sha256").update(options.registryDirectory).digest("hex").slice(0, 12)}-`;
    const rows = execFileSync("systemctl", ["list-units", `${prefix}*`, "--all", "--plain", "--no-legend", "--no-pager"], { encoding: "utf8" });
    const units = rows.split("\n").map(row => row.trim().split(/\s+/u)[0]!).filter(name => name.startsWith(prefix) && /^[a-z0-9.-]+\.service$/u.test(name));
    if (units.length) execFileSync("systemctl", ["stop", "--", ...units]); report.fixtureCleanupUnits = units;
  } catch (reason) { report.fixtureCleanupError = String(reason); }
  if (core && core.exitCode === null) { const exited = new Promise(resolve => core!.once("exit", resolve)); core.kill("SIGTERM"); await exited; }
  model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2)); await writeFile(join(evidence, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ root: evidence, runtimeRoot: root, status: report.status, scenarios: report.scenarios.length, error: report.error }));
}
