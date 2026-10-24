import assert from "node:assert/strict";
import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { zstdDecompressSync, gunzipSync } from "node:zlib";
import WebSocket from "ws";
import { AccountPoolStore, CodexCoreControlClient } from "@opencraft/account-pool-host";
import { nativeReady } from "../../../apps/codex-core/src/native-process.js";

// Explicit opt-in real CLI, synthetic accounts, private HOME and local model only.
const executable = process.env.OPENCRAFT_CODEX_EXECUTABLE;
if (!executable) throw new Error("Set OPENCRAFT_CODEX_EXECUTABLE to the fixed CLI under test");
const root = await mkdtemp(join(process.env.OPENCRAFT_CORE_DRILL_ROOT ?? tmpdir(), "split-drill-"));
await mkdir(join(root, "home"), { mode: 0o700 });
const cliVersion = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
const token = "synthetic-split-control-".repeat(3);
const records: any[] = [], children = new Set<ChildProcess>();
const units = new Map<ChildProcess, string>();
const systemd = process.env.OPENCRAFT_CORE_DRILL_SYSTEMD === "1";
let unitSequence = 0;
const counts = new Map<string, number>();
let ticks = 0;
const marker = join(root, "shell-counts");
const parallelMarker = join(root, "parallel-shell-counts");
function event(response: ServerResponse, value: any) {
  response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
}
function finish(response: ServerResponse, id: string, item: any) {
  event(response, { type: "response.output_item.done", output_index: 0, item });
  event(response, { type: "response.completed", response: { id, object: "response", status: "completed", output: [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); response.end();
}
const model = createServer(async (request, response) => {
  try {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  if (request.url === "/usage") { response.writeHead(200, { "content-type": "application/json" }); response.end('{"plan_type":"pro"}'); return; }
  if (request.url?.endsWith("/models")) { response.end('{"data":[]}'); return; }
  if (request.url !== "/responses") { response.writeHead(404); response.end(); return; }
  const raw = Buffer.concat(chunks);
  const decoded = request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw)
    : request.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw;
  const body = JSON.parse(decoded.toString());
  const inputText = JSON.stringify(body.input);
  const scenario = ["STREAM-GRACEFUL", "CONCURRENT-SHELL", "SHELL", "STREAM-CRASH", "RUNTIME-CRASH", "ROLLBACK"].find(key => inputText.includes(key)) ?? "OTHER";
  const count = (counts.get(scenario) ?? 0) + 1; counts.set(scenario, count);
  records.push({ event: "request", scenario, count, at: Date.now(), tools: body.tools?.map((tool: any) => tool.name ?? tool.type) });
  response.writeHead(200, { "content-type": "text/event-stream", "x-codex-primary-used-percent": "10" });
  const id = `response-${scenario}-${count}`;
  event(response, { type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } });
  const toolOutputs = (body.input ?? []).filter((item: any) => item.type === "function_call_output");
  const isShell = scenario === "SHELL" || scenario === "CONCURRENT-SHELL";
  const shellMarker = scenario === "CONCURRENT-SHELL" ? parallelMarker : marker;
  if (isShell && toolOutputs.length === 0) {
    assert.ok(body.tools.some((tool: any) => tool.name === "exec_command"), "real native exec_command must be available");
    const item = { type: "function_call", id: "shell-call-item", call_id: "shell-once", name: "exec_command",
      arguments: JSON.stringify({ cmd: `echo start >> '${shellMarker}'; sleep ${scenario === "CONCURRENT-SHELL" ? 8 : 36}; echo done >> '${shellMarker}'`, yield_time_ms: 30000, max_output_tokens: 1000 }) };
    event(response, { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } });
    finish(response, id, item); return;
  }
  if (isShell && !await readFile(shellMarker, "utf8").then(text => text.includes("done"), () => false)) {
    const output = String(toolOutputs.at(-1)?.output ?? "");
    const session = /(?:session ID|session_id)[^\d]*(\d+)/i.exec(output)?.[1];
    assert.ok(session, "running native shell must expose its session");
    finish(response, id, { type: "function_call", id: `wait-${count}`, call_id: `wait-${count}`, name: "write_stdin",
      arguments: JSON.stringify({ session_id: Number(session), chars: "", yield_time_ms: 1000, max_output_tokens: 1000 }) }); return;
  }
  const item: any = { type: "message", id: `message-${id}`, role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "", annotations: [] }] };
  event(response, { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
  const duration = scenario === "STREAM-GRACEFUL" ? 35 : scenario === "STREAM-CRASH" && count === 1 ? 35 : scenario === "RUNTIME-CRASH" ? 35 : 1;
  let text = "";
  for (let n = 0; n < duration && !response.destroyed; n++) {
    await delay(1000); ticks++;
    text += "tick ";
    event(response, { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "tick " });
  }
  if (!response.destroyed) { item.content[0].text = text; finish(response, id, item); }
  } catch (error) {
    records.push({ event: "fixture-error", error: error instanceof Error ? error.message : String(error) });
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});
async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as import("node:net").AddressInfo).port;
}
const modelPort = await listen(model);
const reservation = createServer(), proxyPort = await listen(reservation);
await new Promise<void>(resolve => reservation.close(() => resolve()));
const dataDirectory = join(root, "data");
const store = new AccountPoolStore({ databasePath: join(dataDirectory, "account-pool.sqlite"), secretsDirectory: join(dataDirectory, "secrets") });
store.addAccount({ id: "synthetic", provider: "codex", label: "Synthetic", upstreamAccountId: "synthetic", enabled: true, priority: 0 },
  { accessToken: "synthetic-no-upstream-access", refreshToken: null, expiresAt: null }); store.close();
const endpoint = join(root, "accounts/control.sock"), appServerEndpoint = join(root, "execution/control.sock");
const common = { authToken: token, executable, dataDirectory, runtimeDirectory: root };
const coreOptions = { ...common, endpoint, appServerEndpoint, proxyPort, nativeCodexHomeDirectory: join(root, "native"), upstreamBaseUrl: `http://127.0.0.1:${modelPort}` };
const runtimeOptions = { ...common, endpoint: appServerEndpoint, coreEndpoint: endpoint, waitForCore: true };
const control = new CodexCoreControlClient(endpoint, token);
const runtimeControl = new CodexCoreControlClient(appServerEndpoint, token);
async function wait(check: () => Promise<unknown> | unknown, label: string, timeout = 20000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { if (await check()) return; } catch {} await delay(50); }
  throw new Error(`Timed out: ${label}`);
}
async function owner(kind: "core" | "runtime", options: object) {
  const config = join(root, `${kind}.json`); await writeFile(config, JSON.stringify(options), { mode: 0o600 });
  const env = { PATH: process.env.PATH, HOME: join(root, "home"), TMPDIR: root, LANG: "C.UTF-8", XDG_CONFIG_HOME: join(root, "home/config"),
    XDG_DATA_HOME: join(root, "home/data"), RUST_LOG: "error" };
  const cwd = resolve(import.meta.dirname, "../../..");
  const args = ["--import", "tsx", "tests/fixtures/split-codex-owner.ts", kind, config];
  const unit = `oc-core-split-drill-${process.pid}-${++unitSequence}-${kind}.service`;
  const child = systemd ? spawn("systemd-run", ["--quiet", "--wait", "--pipe", "--collect", `--unit=${unit}`,
    "--property=KillMode=control-group", "--property=TimeoutStopSec=infinity", `--working-directory=${cwd}`,
    ...(kind === "runtime" ? ["--property=Restart=on-failure", "--property=RestartSec=1"] : []),
    "/usr/bin/env", "-i", ...Object.entries(env).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`),
    process.execPath, ...args], { stdio: ["ignore", "pipe", "pipe"] })
    : spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  if (systemd) units.set(child, unit);
  children.add(child); child.once("exit", () => children.delete(child));
  let output = "", errors = ""; child.stdout!.on("data", chunk => { output += chunk; }); child.stderr!.on("data", chunk => { errors += chunk; });
  child.once("exit", () => { void writeFile(join(root, `${kind}-${child.pid}.log`), errors); });
  await wait(() => { if (child.exitCode !== null) throw new Error(errors); return output.includes("ready\n"); }, `${kind} startup`);
  return child;
}
async function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise<void>(resolve => child.once("exit", () => resolve()));
  const unit = units.get(child);
  if (unit) await new Promise<void>((resolve, reject) => execFile("systemctl",
    signal === "SIGKILL" ? ["kill", "--kill-whom=main", "--signal=SIGKILL", unit] : ["stop", unit], error => error ? reject(error) : resolve()));
  else child.kill(signal);
  await exit;
}
async function connectNative(socketPath?: string) {
  const nativeSocket = socketPath ?? (await control.health()).nativeSocket;
  const socket = new WebSocket(`ws+unix://${nativeSocket}:/`);
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  let seq = 0; const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const notifications: any[] = [];
  socket.on("message", raw => {
    const frame = JSON.parse(String(raw));
    if (frame.id && !frame.method) { const item = pending.get(frame.id); pending.delete(frame.id); frame.error ? item?.reject(new Error(frame.error.message)) : item?.resolve(frame.result); }
    else notifications.push(frame);
  });
  socket.on("close", () => { for (const item of pending.values()) item.reject(new Error("native closed")); pending.clear(); });
  async function rpc(method: string, params: object = {}) {
    const id = ++seq;
    return new Promise<any>((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  }
  await rpc("initialize", { clientInfo: { name: "isolated-split-drill", version: "1" }, capabilities: { experimentalApi: true } });
  socket.send(JSON.stringify({ method: "initialized" }));
  return { socket, rpc, notifications };
}
let core: ChildProcess | undefined, runtime: ChildProcess | undefined, native: Awaited<ReturnType<typeof connectNative>> | undefined;
const result: any = { root, cliVersion, systemd, scenarios: [] };
try {
  const runtimeStarting = owner("runtime", runtimeOptions);
  const bootstrapStart = Date.now(); await delay(12000);
  core = await owner("core", coreOptions); runtime = await runtimeStarting;
  result.scenarios.push({ name: "runtime bootstrap waits for delayed Core", delayedMs: 12000, readyMs: Date.now() - bootstrapStart,
    ...(systemd ? { systemdRestarts: Number(execFileSync("systemctl", ["show", "-p", "NRestarts", "--value", units.get(runtime)!], { encoding: "utf8" }).trim()) } : {}) });
  await wait(() => control.health(), "split health"); native = await connectNative();
  const original = await control.health(); result.original = { corePid: original.pid, runtimeOwnerPid: (await runtimeControl.health()).pid, nativePid: original.codexPid,
    ...(systemd ? { coreCgroup: execFileSync("systemctl", ["show", "-p", "ControlGroup", "--value", units.get(core)!], { encoding: "utf8" }).trim(),
      appServerCgroup: execFileSync("systemctl", ["show", "-p", "ControlGroup", "--value", units.get(runtime)!], { encoding: "utf8" }).trim() } : {}) };
  async function turn(scenario: string) {
    const { thread } = await native!.rpc("thread/start", { cwd: root, model: "gpt-test", approvalPolicy: "never", sandbox: "danger-full-access" });
    const { turn } = await native!.rpc("turn/start", { threadId: thread.id, input: [{ type: "text", text: scenario }] });
    return { threadId: thread.id, turnId: turn.id };
  }
  async function completed(ids: { threadId: string; turnId: string }) {
    await wait(() => native!.notifications.some(frame => frame.method === "turn/completed" && frame.params.turn.id === ids.turnId), "original turn completion", 100000);
    const history = await native!.rpc("thread/read", { threadId: ids.threadId, includeTurns: true });
    const turn = history.thread.turns.find((turn: any) => turn.id === ids.turnId); assert.equal(turn.status, "completed"); return turn;
  }
  const stream = await turn("STREAM-GRACEFUL"); await wait(() => ticks >= 3, "stream output");
  const parallel = await turn("CONCURRENT-SHELL");
  await wait(() => readFile(parallelMarker, "utf8").then(text => text.includes("start"), () => false), "concurrent shell start");
  const drainStart = Date.now(), draining = stop(core);
  await completed(parallel);
  assert.equal(core.exitCode, null, "other Turns must complete follow-up inference while the long stream is draining");
  assert.equal(await readFile(parallelMarker, "utf8"), "start\ndone\n");
  result.scenarios.push({ name: "concurrent shell and long stream during Core drain", ...parallel, completedBeforeDrain: true,
    modelRequests: counts.get("CONCURRENT-SHELL"), shellStarts: 1, shellCompletions: 1 });
  await draining; const drainMs = Date.now() - drainStart;
  core = await owner("core", coreOptions); await completed(stream);
  assert.equal((await control.health()).codexPid, original.codexPid);
  assert.equal((await runtimeControl.health()).pid, result.original.runtimeOwnerPid);
  assert.equal(counts.get("STREAM-GRACEFUL"), 1); assert.ok(drainMs >= 30000);
  result.scenarios.push({ name: "stream across graceful Core restart", ...stream, durationSeconds: 35, drainMs, modelRequests: 1, appServerPidUnchanged: true });
  const shell = await turn("SHELL"); await wait(() => readFile(marker, "utf8").then(text => text.includes("start"), () => false), "native shell start");
  const restartStart = Date.now(); await stop(core); await delay(1500); core = await owner("core", coreOptions);
  const restartMs = Date.now() - restartStart;
  await completed(shell); await wait(() => readFile(marker, "utf8").then(text => text.includes("done")), "native shell completion");
  assert.equal(await readFile(marker, "utf8"), "start\ndone\n"); assert.equal((await control.health()).codexPid, original.codexPid);
  assert.equal((await runtimeControl.health()).pid, result.original.runtimeOwnerPid);
  result.scenarios.push({ name: "36s shell across Core restart", ...shell, restartMs, shellStarts: 1, shellCompletions: 1, modelRequests: counts.get("SHELL"), appServerPidUnchanged: true });
  const priorTicks = ticks, crash = await turn("STREAM-CRASH"); await wait(() => ticks >= priorTicks + 3, "stream before crash");
  const crashStart = Date.now();
  await stop(core, "SIGKILL"); await delay(1500); core = await owner("core", coreOptions);
  const crashRecoveryMs = Date.now() - crashStart;
  await completed(crash);
  assert.equal((await control.health()).codexPid, original.codexPid); assert.ok(counts.get("STREAM-CRASH")! >= 2);
  assert.equal((await runtimeControl.health()).pid, result.original.runtimeOwnerPid);
  result.scenarios.push({ name: "Core crash / native Responses retry", ...crash, recoveryMs: crashRecoveryMs, modelRequests: counts.get("STREAM-CRASH"), appServerPidUnchanged: true });
  // Probe native behavior without the production single-runtime guard. Opening
  // the same HOME is an experiment, never a supported deployment mode.
  const { launch } = await control.appServerLaunch();
  async function probePeer(name: string, home: string) {
    await mkdir(home, { recursive: true, mode: 0o700 });
    const path = join(root, `${name}.sock`);
    const child = spawn(executable!, ["app-server", "--listen", `unix://${path}`, ...launch.args], {
      cwd: root, env: { PATH: process.env.PATH, HOME: join(root, "home"), TMPDIR: root, CODEX_HOME: home, ...launch.env, RUST_LOG: "error" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child); child.once("exit", () => children.delete(child)); child.stderr.resume(); child.stdout.resume();
    const auth = await nativeReady(path, child, launch.auth), peer = await connectNative(path);
    return { child, peer, async close() { peer.socket.terminate(); auth.terminate(); await stop(child); } };
  }
  const shared = await probePeer("shared-home-probe", join(dataDirectory, "runtime"));
  try {
    let rejected = false;
    try { await shared.peer.rpc("thread/resume", { threadId: stream.threadId }); }
    catch (error) { assert.match(String(error), /already has an active writer/); rejected = true; }
    assert.equal(rejected, true, "fixed CLI must reject sharing an already-loaded thread writer");
    result.scenarios.push({ name: "same HOME native probe", resumeRejected: true, reason: "already has an active writer" });
  } finally { await shared.close(); }
  const independent = await probePeer("separate-home-probe", join(root, "generation-2"));
  try {
    const { thread } = await independent.peer.rpc("thread/start", { cwd: root, model: "gpt-test", approvalPolicy: "never", sandbox: "danger-full-access" });
    const { turn: newTurn } = await independent.peer.rpc("turn/start", { threadId: thread.id, input: [{ type: "text", text: "POOL-SHARE" }] });
    await wait(() => independent.peer.notifications.some(frame => frame.method === "turn/completed" && frame.params.turn.id === newTurn.id), "second HOME uses same account Core");
    const history = await independent.peer.rpc("thread/read", { threadId: thread.id, includeTurns: true });
    assert.equal(history.thread.turns[0].status, "completed");
    result.scenarios.push({ name: "separate HOME / shared account proxy", threadId: thread.id, turnId: newTurn.id, completed: true, secondAccountWriter: false });
  } finally { await independent.close(); }
  const broken = await turn("RUNTIME-CRASH"); await wait(() => counts.get("RUNTIME-CRASH"), "runtime active turn");
  const accountPid = (await control.health()).pid;
  process.kill(original.codexPid, "SIGKILL");
  if (systemd) {
    await wait(async () => (await control.health()).codexPid !== original.codexPid, "automatic runtime unit recovery");
    assert.ok(Number(execFileSync("systemctl", ["show", "-p", "NRestarts", "--value", units.get(runtime)!], { encoding: "utf8" }).trim()) >= 1);
  } else {
    await wait(() => runtime!.exitCode !== null, "owner detects native crash");
    await assert.rejects(control.health());
    runtime = await owner("runtime", runtimeOptions); await wait(() => control.health(), "runtime health recovery");
  }
  assert.ok(core.exitCode === null);
  assert.equal((await control.health()).pid, accountPid);
  native.socket.close(); native = await connectNative();
  const resumed = await native.rpc("thread/resume", { threadId: broken.threadId });
  result.scenarios.push({ name: "AppServer crash / independent owner restart", ...broken, corePidUnchanged: accountPid,
    automaticUnitRecovery: systemd,
    originalTurnStatusAfterResume: resumed.thread.turns.find((item: any) => item.id === broken.turnId)?.status,
    modelRequests: counts.get("RUNTIME-CRASH"), automaticTurnReplay: false });
  assert.equal(counts.get("RUNTIME-CRASH"), 1);
  native.socket.close(); await stop(runtime); await stop(core);
  const { appServerEndpoint: _external, ...combined } = coreOptions;
  core = await owner("core", combined); native = await connectNative();
  const prior = await native.rpc("thread/resume", { threadId: stream.threadId });
  assert.equal(prior.thread.turns.find((item: any) => item.id === stream.turnId).status, "completed");
  const rollback = await turn("ROLLBACK"); await completed(rollback);
  result.scenarios.push({ name: "rollback to combined Core", ...rollback, currentDataRetained: true });
  result.result = "passed";
} catch (error) { result.result = "failed"; result.error = error instanceof Error ? error.message : String(error); throw error; }
finally {
  native?.socket.terminate();
  for (const child of children) await stop(child);
  model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
  result.requests = records; result.counts = Object.fromEntries(counts);
  await writeFile(join(root, "report.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ result: result.result, report: join(root, "report.json") }));
}
