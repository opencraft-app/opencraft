import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { SessionCapabilities } from "../../packages/session-capabilities/src/index.js";
import { SessionCapabilityMcp } from "../../packages/session-capabilities/src/mcp.js";

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
