import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { SessionCapabilities } from "../../packages/session-capabilities/src/index.js";
import { SessionCapabilityMcp } from "../../packages/session-capabilities/src/mcp.js";
import { createCodexAccountPoolLaunch } from "../../packages/account-pool-host/src/codex-launch.js";

// Uses only native metadata/MCP RPCs and a local synthetic capability. No model request.
test("native empty threads install execution-bound MCP before their first input without a rollout resume", {
  skip: !process.env.OPENCRAFT_CODEX_EXECUTABLE, timeout: 30_000,
}, async t => {
  const home = await mkdtemp(join(tmpdir(), "session-mcp-native-"));
  const capabilities = new SessionCapabilities(); let calls = 0;
  capabilities.register({ id: "fixture", tools: session => session.execution?.inputId === "first" ? [{
    name: "probe", description: "Synthetic local probe", inputSchema: { type: "object", properties: {} },
  }] : [], async call(session) { assert.equal(session.execution?.executionId, "execution-first"); calls++; return { ok: true }; } });
  const mcp = new SessionCapabilityMcp(capabilities, randomBytes(32)); await mcp.listen();
  const reservation = mcp.prepareExecution();
  const child = spawn(process.env.OPENCRAFT_CODEX_EXECUTABLE!, ["app-server", "--listen", "stdio://"], {
    env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "ignore"],
  });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  t.after(async () => { child.kill(); await exited; await mcp.close(); await rm(home, { recursive: true, force: true, maxRetries: 3 }); });
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>(); let sequence = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    let message: any; try { message = JSON.parse(line); } catch { return; }
    const entry = pending.get(message.id); if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(`Native ${message.error.code}: ${message.error.message}`));
    else entry.resolve(message.result);
  });
  child.on("exit", () => { for (const entry of pending.values()) entry.reject(new Error("Native probe exited")); pending.clear(); });
  const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  await request("initialize", { clientInfo: { name: "mcp-native-fixture", version: "1" }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  const created = await request("thread/start", { cwd: home, sandbox: "read-only", approvalPolicy: "never", config: {
    "mcp_servers.opencraft_session": reservation.configuration,
  } });
  reservation.bind({ serverId: "fixture", threadId: created.thread.id, execution: { inputId: "first", executionId: "execution-first" } });
  const result = await request("mcpServer/tool/call", { threadId: created.thread.id, server: "opencraft_session", tool: "probe", arguments: {} });
  assert.equal(result.isError, false); assert.equal(calls, 1);
  await assert.rejects(request("thread/resume", { threadId: created.thread.id, excludeTurns: true }), /no rollout found/);
});

// Exercise native's actual retirement timer with a synthetic loopback provider.
// No user history is copied and no remote model is contacted.
test("native failed Thread reconfigures tools promptly and accepts the next execution after one retirement", {
  skip: !process.env.OPENCRAFT_CODEX_EXECUTABLE, timeout: 25_000,
}, async t => {
  const { createServer } = await import("node:http");
  const home = await mkdtemp(join(tmpdir(), "session-mcp-recovery-native-"));
  let requests = 0, releaseNext!: () => void;
  const nextResponse = new Promise<void>(resolve => { releaseNext = resolve; });
  const provider = createServer((request, response) => {
    const modelRequest = request.url?.split("?")[0]?.endsWith("/responses");
    if (modelRequest) requests++;
    const fail = () => { response.writeHead(503, { "content-type": "application/json" }); response.end('{"error":{"message":"synthetic unavailable"}}'); };
    if (modelRequest && requests === 2) void nextResponse.then(fail); else fail();
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address(); assert(address && typeof address !== "string");
  await writeFile(join(home, "config.toml"), `model_provider = "fixture"
[model_providers.fixture]
name = "Synthetic loopback"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
`);
  const capabilities = new SessionCapabilities(); let calls = 0;
  capabilities.register({ id: "fixture", tools: session => session.execution?.inputId === "next" ? [{
    name: "probe", description: "Synthetic local probe", inputSchema: { type: "object", properties: {} },
  }] : [], async call(session) { assert.equal(session.execution?.executionId, "execution-next"); calls++; return { ok: true }; } });
  const mcp = new SessionCapabilityMcp(capabilities, randomBytes(32)); await mcp.listen();
  const launch = createCodexAccountPoolLaunch({ baseUrl: `http://127.0.0.1:${address.port}`, hostToken: "synthetic-host-token" });
  const child = spawn(process.env.OPENCRAFT_CODEX_EXECUTABLE!, ["app-server", "--listen", "stdio://", ...launch.args], {
    env: { ...process.env, ...launch.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "ignore"],
  });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  t.after(async () => { releaseNext(); child.kill(); await exited; provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); await mcp.close(); await rm(home, { recursive: true, force: true, maxRetries: 3 }); });
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>(); let sequence = 0;
  let completions = 0;
  let complete!: () => void; const completed = new Promise<void>(resolve => { complete = resolve; });
  createInterface({ input: child.stdout }).on("line", line => {
    let message: any; try { message = JSON.parse(line); } catch { return; }
    if (message.method === "turn/completed") { completions++; complete(); }
    const entry = pending.get(message.id); if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(`Native ${message.error.code}: ${message.error.message}`)); else entry.resolve(message.result);
  });
  child.on("exit", () => { for (const entry of pending.values()) entry.reject(new Error("Native probe exited")); pending.clear(); });
  const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  await request("initialize", { clientInfo: { name: "mcp-recovery-fixture", version: "1" }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  const created = await request("thread/start", { cwd: home, model: "fixture", modelProvider: "fixture", sandbox: "read-only", approvalPolicy: "never", config: {
    "model_providers.fixture": { name: "Synthetic loopback", base_url: `http://127.0.0.1:${address.port}/v1`, wire_api: "responses", requires_openai_auth: false, request_max_retries: 0, stream_max_retries: 0 },
  } });
  await request("turn/start", { threadId: created.thread.id, input: [{ type: "text", text: "Synthetic failure fixture", text_elements: [] }] });
  await completed;
  const before = await request("thread/read", { threadId: created.thread.id, includeTurns: false });
  assert(["idle", "systemError"].includes(before.thread.status.type));
  const preparationStarted = performance.now();
  await request("thread/unsubscribe", { threadId: created.thread.id });
  let status = "idle";
  while (status !== "notLoaded" && performance.now() - preparationStarted < 5_000) {
    await new Promise(resolve => setTimeout(resolve, 50));
    const snapshot = await request("thread/read", { threadId: created.thread.id, includeTurns: false });
    status = snapshot.thread.status.type;
  }
  assert.equal(status, "notLoaded", "tool rotation must not inherit native's idle retention delay");
  await request("thread/resume", { threadId: created.thread.id, excludeTurns: true, config: {
    "mcp_servers.opencraft_session": mcp.config({ serverId: "fixture", threadId: created.thread.id,
      execution: { inputId: "next", executionId: "execution-next" } }),
  } });
  assert(performance.now() - preparationStarted < 5_000);
  const result = await request("mcpServer/tool/call", { threadId: created.thread.id, server: "opencraft_session", tool: "probe", arguments: {} });
  assert.equal(result.isError, false); assert.equal(calls, 1);
  const next = await request("turn/start", { threadId: created.thread.id, clientUserMessageId: "next", input: [{ type: "text", text: "Synthetic next execution", text_elements: [] }] });
  assert(next.turn.id);
  const startedDeadline = Date.now() + 5_000;
  while (requests < 2 && Date.now() < startedDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(requests, 2, "next execution reached its loopback provider");
  const beforeRelease = await request("thread/read", { threadId: created.thread.id, includeTurns: false });
  assert.equal(beforeRelease.thread.status.type, "active");
  await request("thread/unsubscribe", { threadId: created.thread.id });
  await new Promise(resolve => setTimeout(resolve, 300));
  const active = await request("thread/read", { threadId: created.thread.id, includeTurns: false });
  assert.equal(active.thread.status.type, "active", "zero retention must not unload an executing Thread");
  await request("thread/resume", { threadId: created.thread.id, excludeTurns: true });
  releaseNext();
  const deadline = Date.now() + 10_000;
  while (completions < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(completions, 2); assert.equal(requests, 2, "one local model request per execution, no replay");
});
