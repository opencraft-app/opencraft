import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexEngineAdapter } from "../../apps/opencraft-daemon/src/codex-engine-adapter";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { SHARED_INTERACTIONS_EXTENSION, SHARED_INTERACTIONS_CHANGED, SHARED_INTERACTIONS_RESPOND, SHARED_INTERACTIONS_READ } from "@opencraft/appserver-protocol";

const delay = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => T | undefined): Promise<T> {
  for (let n = 0; n < 500; n++) { const value = read(); if (value !== undefined) return value; await delay(); }
  throw Error("Timed out waiting for shared interaction");
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "oc-shared-interaction-")), frames: any[] = [];
  const adapter = new CodexEngineAdapter({ executable: process.execPath, runtimeDirectory: root, dataDirectory: join(root, "data"),
    nativeCodexHomeDirectory: join(root, "native"), upstreamBaseUrl: "http://127.0.0.1:9/backend-api/codex",
    fetch: async () => Response.json({ ok: true }), createMaintenanceClient: async () => { throw Error("unused"); },
    spawnAppServer: ({ cwd, env }) => spawn(process.execPath, [new URL("../fixtures/fake-codex-stdio-appserver.mjs", import.meta.url).pathname], { cwd, env, stdio: ["pipe", "pipe", "pipe"] }), logDiagnostic() {} });
  adapter.subscribeMessage(frame => frames.push(JSON.parse(frame)));
  t.after(async () => { await adapter.close(); await rm(root, { recursive: true, force: true }); });
  await adapter.connect(); let sequence = 0;
  const rpc = async (client: string, method: string, params: unknown = {}) => {
    const id = `rpc-${++sequence}`; await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: client }));
    return until(() => frames.find(f => f.id === id));
  };
  const init = (client: string, shared = true) => rpc(client, "initialize", { capabilities: { extensions: shared ? { [SHARED_INTERACTIONS_EXTENSION]: { version: 1 } } : {} } });
  const snapshot = (client: string) => frames.filter(f => f[LOGICAL_CLIENT_FIELD] === client && f.method === SHARED_INTERACTIONS_CHANGED).at(-1)?.params;
  const emit = (id = 901, method = "item/commandExecution/requestApproval") => (adapter as any).receiveServerRequest(id, { id, method, params: { threadId: "fixture-thread-1", turnId: "turn", itemId: `item-${id}`, command: "echo fixture", questions: [] } });
  return { root, adapter, frames, rpc, init, snapshot, emit };
}

test("all subscribed clients, late readers and legacy viewers see human waits without executable callback fanout", async t => {
  const f = await fixture(t); await f.init("a"); await f.init("b"); await f.init("unrelated");
  await f.rpc("a", "thread/start", { cwd: f.root, testNoServerRequest: true });
  await f.rpc("b", "thread/resume", { threadId: "fixture-thread-1" });
  for (const [i, method] of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput", "mcpServer/elicitation/request"].entries()) f.emit(901 + i, method);
  assert.equal(f.snapshot("a").requests.length, 5); assert.equal(f.snapshot("b").requests.length, 5);
  assert.equal(f.snapshot("unrelated"), undefined);
  assert.equal(f.frames.some(frame => frame.id === 901 && frame.method), false, "passive clients do not execute raw RPC handlers");
  await f.init("late"); await f.rpc("late", "thread/read", { threadId: "fixture-thread-1", includeTurns: false, watch: true });
  assert.equal(f.snapshot("late").requests.length, 5);
  await f.init("legacy", false); await f.rpc("legacy", "thread/resume", { threadId: "fixture-thread-1" });
  assert.equal(f.frames.filter(frame => frame[LOGICAL_CLIENT_FIELD] === "legacy" && frame.method?.endsWith("requestApproval")).length, 3);
  f.emit(999, "item/tool/call");
  assert.equal(f.frames.filter(frame => frame.id === 999 && frame.method === "item/tool/call").length, 1, "executable tool has exactly one owner");
  assert.equal((await f.rpc("unrelated", SHARED_INTERACTIONS_READ, { threadId: "fixture-thread-1" })).error.code, 403);
  await f.adapter.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "a" }));
  const request = f.snapshot("b").requests[0];
  const answers = await Promise.all([f.rpc("b", SHARED_INTERACTIONS_RESPOND, { threadId: "fixture-thread-1", interactionId: request.id, submissionId: "answer-b", result: { decision: "accept" } }),
    f.rpc("late", SHARED_INTERACTIONS_RESPOND, { threadId: "fixture-thread-1", interactionId: request.id, submissionId: "answer-late", result: { decision: "decline" } })]);
  assert.ok(answers.every(a => !a.error));
  await until(() => f.snapshot("b")?.requests.length === 4 ? true : undefined);
  assert.equal(f.snapshot("late").requests.length, 4);
  assert.equal(f.frames.filter(frame => frame.method === "serverRequest/resolved" && frame.params.requestId === 901 && frame[LOGICAL_CLIENT_FIELD] === "b").length, 1);
});

test("a pre-write response failure preserves a shared unconfirmed wait", async t => {
  const f = await fixture(t); await f.init("a"); await f.init("b");
  await f.rpc("a", "thread/start", { cwd: f.root, testNoServerRequest: true }); await f.rpc("b", "thread/resume", { threadId: "fixture-thread-1" });
  f.emit(); const request = f.snapshot("a").requests[0], native = f.adapter as any, original = native.writePhysical.bind(native);
  native.writePhysical = async (message: any, ...args: any[]) => { if (message.id === 901 && message.result) throw Error("fixture pre-write failure"); return original(message, ...args); };
  const response = await f.rpc("a", SHARED_INTERACTIONS_RESPOND, { threadId: "fixture-thread-1", interactionId: request.id, submissionId: "answer", result: { decision: "accept" } });
  assert.ok(response.error); assert.equal(f.snapshot("b").requests[0].state, "unconfirmed");
  native.writePhysical = original;
  await f.rpc("b", "thread/resume", { threadId: "fixture-thread-1" });
  assert.equal(f.snapshot("b").requests[0].state, "unconfirmed");
});
