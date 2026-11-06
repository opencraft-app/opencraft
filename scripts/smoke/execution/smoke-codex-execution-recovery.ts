import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {createServer} from "node:http";
import {mkdir, mkdtemp, readFile, writeFile, rm} from "node:fs/promises";
import {join, resolve} from "node:path";
import {gunzipSync, zstdDecompressSync} from "node:zlib";
import {build} from "esbuild";
import WebSocket from "ws";
import {CodexCoreControlClient, CodexExecutionUnavailableError} from "@opencraft/account-pool-host";
import {CodexGenerationRuntime} from "../../../apps/codex-core/src/generation-runtime.js";
import {SystemdGenerationSupervisor} from "../../../apps/codex-core/src/generation-supervisor.js";
import {nativeOwnerRequest} from "../../../apps/codex-core/src/native-process.js";

// Unique, bounded systemd units; private HOME and loopback synthetic model only.
if (process.getuid?.() !== 0 || process.env.OPENCRAFT_EXECUTION_RECOVERY_SMOKE !== "1" || !process.env.OPENCRAFT_CODEX_EXECUTABLE) throw new Error("Explicit Linux root smoke and fixed native CLI are required");
const execute = promisify(execFile), executable = resolve(process.env.OPENCRAFT_CODEX_EXECUTABLE);
const root = await mkdtemp("/run/oc-exec-recovery-"), token = "synthetic-execution-recovery-control-".repeat(2);
const endpoint = join(root, "accounts.sock"), data = join(root, "data"), runtimeData = join(root, "instance");
const marker = join(root, "commands"), configuration = join(root, "sandbox.json"), tokenFile = join(root, "control-token");
let runtime: CodexGenerationRuntime | undefined, socket: WebSocket | undefined;
const priorConfiguration = process.env.OPENCRAFT_SANDBOX_CONFIG;
const syntheticAccess = `${Buffer.from(JSON.stringify({alg: "none"})).toString("base64url")}.${Buffer.from(JSON.stringify({exp: 4102444800,
  email: "fixture@example.invalid", "https://api.openai.com/auth": {chatgpt_account_id: "fixture", chatgpt_plan_type: "pro", user_id: "fixture"}})).toString("base64url")}.synthetic`;
const requests: string[] = [];
let holdNextModel = false, runSequence = 0;
const model = createServer(async (request, response) => {
  requests.push(`${request.method} ${request.url}`);
  try {
    if (request.url?.includes("/models")) {response.end(JSON.stringify({models: []})); return;}
    if (request.url?.includes("/mcp")) {
      if (request.method === "GET") {response.writeHead(405); response.end(); return;}
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString()); response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({jsonrpc: "2.0", id: input.id, result: input.method === "initialize" ? {protocolVersion: "2025-03-26", capabilities: {tools: {}}, serverInfo: {name: "fixture", version: "1"}} : {tools: []}})); return;
    }
    if (request.url !== "/responses") {response.writeHead(404); response.end(); return;}
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks), encoding = request.headers["content-encoding"];
    const body = JSON.parse((encoding === "zstd" ? zstdDecompressSync(raw) : encoding === "gzip" ? gunzipSync(raw) : raw).toString());
    if (holdNextModel) {holdNextModel = false; response.writeHead(200, {"content-type": "text/event-stream"}); response.write('event: response.created\ndata: {"type":"response.created","response":{"id":"held","object":"response","status":"in_progress","output":[]}}\n\n'); return;}
    const callId = JSON.stringify(body.input).includes("PROBE-2") ? "execute-two" : "execute-one";
    const tool = !(body.input ?? []).some((item: any) => item.type === "function_call_output" && item.call_id === callId), id = `response-${Date.now()}`;
    const item = tool ? {type: "function_call", id: "shell", call_id: callId, name: "exec_command", arguments: JSON.stringify({cmd: `echo executed >> '${marker}'`, yield_time_ms: 1000, max_output_tokens: 100})}
      : {type: "message", id, role: "assistant", status: "completed", content: [{type: "output_text", text: "done", annotations: []}]};
    response.writeHead(200, {"content-type": "text/event-stream"});
    for (const event of [{type: "response.created", response: {id, object: "response", status: "in_progress", output: []}},
      {type: "response.output_item.added", output_index: 0, item: {...item, ...(tool ? {arguments: ""} : {content: [], status: "in_progress"})}},
      {type: "response.output_item.done", output_index: 0, item}, {type: "response.completed", response: {id, object: "response", status: "completed", output: [item], usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2}}}]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  } catch {response.statusCode = 500; response.end();}
});
const accounts = createServer((_request, response) => response.end(JSON.stringify({dataDirectory: data, launch: {
  args: ["-c", `chatgpt_base_url="http://127.0.0.1:${(model.address() as any).port}"`, "-c", 'model="gpt-5.4"', "-c", 'features.apps=false', "-c", 'features.plugins=false',
    "-c", 'mcp_servers.openaiDeveloperDocs.enabled=false', "-c", 'mcp_servers.openaiDeveloperDocs.url="http://127.0.0.1:1/disabled"',
    "-c", 'mcp_servers.codex_apps.enabled=false', "-c", 'mcp_servers.codex_apps.url="http://127.0.0.1:1/disabled"',
    "-c", 'model_provider="fixture"', "-c", 'model_providers.fixture.name="Fixture"',
    "-c", `model_providers.fixture.base_url="http://127.0.0.1:${(model.address() as any).port}"`,
    "-c", 'model_providers.fixture.wire_api="responses"', "-c", 'model_providers.fixture.requires_openai_auth=false', "-c", 'model_providers.fixture.supports_websockets=false'],
  env: {OPENCRAFT_CODEX_POOL_AUTH_TOKEN: "synthetic"}, auth: {type: "chatgptAuthTokens", accessToken: syntheticAccess, chatgptAccountId: "fixture"},
}})));
const wait = async <T>(read: () => Promise<T>, label: string): Promise<T> => {
  const deadline = Date.now() + 20_000;
  for (;;) {try {const result = await read(); if (result) return result;} catch { /* bounded observation */ }
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 50));}
};
const connect = async () => {
  const health = await new CodexCoreControlClient(join(root, "sockets/control.sock"), token).appServerHealth("native");
  const ws = new WebSocket(`ws+unix://${health.nativeSocket}:/`); await new Promise<void>((yes, no) => {ws.once("open", yes); ws.once("error", no);});
  await nativeOwnerRequest(ws, "initialize", {clientInfo: {name: "execution-recovery-smoke", version: "1"}, capabilities: {experimentalApi: true}});
  ws.send(JSON.stringify({method: "initialized"}));
  return ws;
};
const run = async (threadId: string) => {
  const ws = socket!, observed: any[] = [];
  const observe = (raw: WebSocket.RawData) => {const message = JSON.parse(String(raw)); if (message.method) observed.push({method: message.method, threadId: message.params?.threadId, status: message.params?.turn?.status, error: message.params?.error});};
  ws.on("message", observe);
  let receive: (raw: WebSocket.RawData) => void;
  let rejectCompletion: (error: Error) => void;
  const completed = new Promise<any>((resolve, reject) => {
    rejectCompletion = reject;
    receive = (raw: WebSocket.RawData) => {const message = JSON.parse(String(raw)); if (message.method === "turn/completed" && message.params.threadId === threadId) {ws.off("message", receive); resolve(message.params.turn);}};
    ws.on("message", receive);
  });
  await nativeOwnerRequest(ws, "turn/start", {threadId, input: [{type: "text", text: `Run PROBE-${++runSequence} once`, text_elements: []}]});
  const timer = setTimeout(() => rejectCompletion(new Error("Ordinary Turn tool did not complete: " + requests.join(", ") + " events=" + JSON.stringify(observed))), 45_000);
  try {assert.equal((await completed).status, "completed");} finally {clearTimeout(timer); ws.off("message", receive!); ws.off("message", observe);}
};
let unit: string | undefined;
try {
  await mkdir(data, {mode: 0o700}); await mkdir(join(runtimeData, "runtime"), {recursive: true, mode: 0o700});
  await writeFile(tokenFile, token, {mode: 0o600});
  await writeFile(configuration, JSON.stringify({schemaVersion: 1, backend: {id: "linux-systemd", options: {scope: "system", uid: "current", gid: "current", inheritHostIdentity: true, ownerUnit: "current"}},
    pool: {idPrefix: "recovery-smoke"}, environment: {mode: "selected", names: ["PATH", "HOME", "LANG", "TMPDIR"]}}), {mode: 0o600});
  await build({entryPoints: ["apps/codex-core/src/app-server-bin.ts"], outfile: join(root, "app-server.cjs"), bundle: true, platform: "node", format: "cjs", external: ["node-pty"], logLevel: "warning"});
  await build({entryPoints: ["scripts/server-deployment/sandbox-command.mjs"], outfile: join(root, "sandbox-command.mjs"), bundle: true, platform: "node", format: "esm", external: ["node-pty"], logLevel: "warning"});
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve)); await new Promise<void>(resolve => accounts.listen(endpoint, resolve));
  process.env.OPENCRAFT_SANDBOX_CONFIG = configuration;
  const supervisor = new SystemdGenerationSupervisor({registryDirectory: join(root, "registry"), coreEndpoint: endpoint, dataDirectory: data, tokenFile, token, scope: "system"});
  runtime = new CodexGenerationRuntime({directory: join(root, "registry"), dataDirectory: data, proxyBaseUrl: `http://127.0.0.1:${(model.address() as any).port}`, supervisor,
    requireHostUsage: false, replaceRetiredHome: async () => {throw new Error("Fault recovery must not replace HOME");}});
  const g = await runtime.prepare({id: "one", endpoint: join(root, "sockets/control.sock"), runtimeDataDirectory: runtimeData, executable, bundle: join(root, "app-server.cjs"), node: process.execPath, cwd: root});
  await runtime.activate("one", 0);
  const before: any = runtime.registry.metadata("runtime:one"); unit = before.unit;
  socket = await connect();
  const {thread} = await nativeOwnerRequest(socket, "thread/start", {cwd: root, approvalPolicy: "never", sandbox: "danger-full-access"}) as any;
  await run(thread.id); assert.equal((await readFile(marker, "utf8")).trim(), "executed");
  const rows = (await readFile(join(runtimeData, "runtime/exec-server-lifecycle.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const executorUnit = rows.findLast(row => row.event === "unit-start")?.unit; assert.ok(executorUnit?.startsWith("opencraft-sandbox-"));
  holdNextModel = true;
  await nativeOwnerRequest(socket, "turn/start", {threadId: thread.id, input: [{type: "text", text: "Hold unfinished work", text_elements: []}]});
  await execute("systemctl", ["kill", "--kill-whom=main", "--signal=SIGKILL", "--", executorUnit]);
  const control = new CodexCoreControlClient(g.endpoint, token);
  const statuses = new Set<string>();
  try {
    await wait(async () => {
      try {await control.appServerHealth(); statuses.add("healthy"); return false;}
      catch (error) {statuses.add(error instanceof CodexExecutionUnavailableError ? error.executionStatus : String(error));
        return error instanceof CodexExecutionUnavailableError && error.executionStatus === "disconnected";}
    }, "executor failure detected");
  } catch (error) {
    const native = await nativeOwnerRequest(socket, "environment/status", {environmentId: "opencraft"}, 2_000).catch(() => "probe-timeout");
    console.error(JSON.stringify({statuses: [...statuses], native, lifecycle: await readFile(join(runtimeData, "runtime/exec-server-lifecycle.jsonl"), "utf8")}));
    throw error;
  }
  assert.equal((await control.appServerHealth("native")).codexPid, before.nativePid);
  assert.equal((await nativeOwnerRequest(socket, "thread/read", {threadId: thread.id, includeTurns: false}) as any).thread.id, thread.id);
  // Keep an unfinished Turn; recovery has no idle prerequisite.
  await runtime.recoverExecutions(); socket.terminate(); socket = await connect();
  assert.equal(runtime.fences().executionRecoveries?.[0]?.state, "recovered");
  const after: any = runtime.registry.metadata("runtime:one"); assert.notEqual(after.ownerPid, before.ownerPid);
  await nativeOwnerRequest(socket, "thread/resume", {threadId: thread.id}); await run(thread.id);
  assert.deepEqual((await readFile(marker, "utf8")).trim().split("\n"), ["executed", "executed"]);
  console.log(JSON.stringify({passed: true, cli: (await execute(executable, ["--version"])).stdout.trim(), sharedExecutorKilled: true,
    nativeRemainedReadable: true, unfinishedTurnInterruptedWithoutIdle: true, ownerReplaced: true, ordinaryTurnToolSucceededAfterRecovery: true, commandCount: 2, homePreserved: true}));
} finally {
  socket?.terminate();
  if (runtime) {
    const identity: any = runtime.registry.metadata("runtime:one"); unit ??= identity?.unit;
    await runtime.close();
  }
  if (unit) await execute("systemctl", ["stop", "--", unit], {timeout: 10_000}).catch(() => {});
  // A candidate can fail before its identity was recorded. Its unit derives from this private registry only.
  const {createHash} = await import("node:crypto");
  const candidateUnit = `opencraft-codex-${createHash("sha256").update(join(root, "registry")).digest("hex").slice(0, 12)}-one.service`;
  await execute("systemctl", ["stop", "--", candidateUnit], {timeout: 10_000}).catch(() => {});
  if (priorConfiguration === undefined) delete process.env.OPENCRAFT_SANDBOX_CONFIG; else process.env.OPENCRAFT_SANDBOX_CONFIG = priorConfiguration;
  accounts.closeAllConnections(); await new Promise<void>(resolve => accounts.close(() => resolve())); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
  await rm(root, {recursive: true, force: true});
}
