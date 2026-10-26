import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import lockfile from "proper-lockfile";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentOrchestrationPort, ExecutionEngineClient } from "@opencraft/appserver-client";
import { THREAD_ORCHESTRATION_TOOLS } from "@opencraft/appserver-protocol/collaboration";
import { PiEngine, piModel } from "../../plugins/pi-engine/src/index.js";
import { startEngineHost } from "../../apps/local-agent-host/src/engine-host.js";
import WebSocket from "ws";

const owner: ExecutionEngineClient = { notify() {}, async request() { throw new Error("No browser tool expected"); } };
const toolResult = { success: true, contentItems: [{ type: "inputText", text: "delivered" }] };
function models(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0] = []) {
  const faux = fauxProvider({ tokensPerSecond: 10000 }); faux.setResponses(responses);
  const runtime = createModels(); runtime.setProvider(faux.provider);
  return Object.assign(runtime, { getAvailableSnapshot: () => faux.models }) as unknown as ModelRuntime;
}
async function fixture(t: test.TestContext, responses: Parameters<typeof models>[0] = []) {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-pi-orchestration-"));
  const engine = new PiEngine({ directory, cwd: directory, models: models(responses) });
  engine.setOrchestration({ tools: THREAD_ORCHESTRATION_TOOLS, async call() { return toolResult; } });
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, engine };
}
async function prepare(engine: PiEngine, directory: string, operationId = "create-one") {
  return engine.request("opencraft/orchestration/prepare", { operationId, threadId: "codex-source", arguments: { title: "Pi child" },
    sourceSettings: { cwd: directory, approvalPolicy: "never", sandbox: "danger-full-access" } }, owner);
}

test("Pi Host advertises callback replay only after its orchestration port is connected", async t => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-pi-capability-"));
  const engine = new PiEngine({ directory, cwd: directory, models: models() });
  const host = await startEngineHost({ providers: [engine], defaultEngine: "pi" });
  const socket = new WebSocket(host.websocketUrl);
  t.after(async () => { socket.terminate(); await host.close(); await rm(directory, { recursive: true, force: true }); });
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const initialize = (id: number) => new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Pi capability handshake timed out")), 5000);
    const receive = (data: WebSocket.RawData) => { const reply = JSON.parse(String(data)); if (reply.id !== id) return;
      clearTimeout(timeout); socket.off("message", receive); reply.error ? reject(new Error(reply.error.message)) : resolve(reply.result); };
    socket.on("message", receive); socket.send(JSON.stringify({ jsonrpc: "2.0", id, method: "initialize", params: {} }));
  });
  const disconnected = await initialize(1);
  assert.equal(disconnected.capabilities.extensions["opencraft/thread-orchestration"], undefined);
  assert.equal(disconnected.capabilities.extensions["opencraft/execution-engines"].providers[0].extensions["opencraft/thread-orchestration"], undefined);
  engine.setOrchestration({ tools: THREAD_ORCHESTRATION_TOOLS, async call() { return toolResult; } });
  const connected = await initialize(2);
  assert.equal(connected.capabilities.extensions["opencraft/thread-orchestration"].callbackReplay, true);
  assert.equal(connected.capabilities.extensions["opencraft/execution-engines"].providers[0].extensions["opencraft/thread-orchestration"].callbackReplay, true);
});

test("Pi child allocation reconciles one durable identity across concurrent calls and Host replacement", async t => {
  const { engine, directory } = await fixture(t), settings = await prepare(engine, directory);
  const create = () => engine.request("opencraft/orchestration/create", { operationId: "create-one", settings }, owner);
  const [first, second] = await Promise.all([create(), create()]);
  assert.deepEqual(first, second); assert.equal(first.driverKind, "pi"); assert.equal(first.durability, "immediate");
  const index = JSON.parse(await readFile(join(directory, `${first.threadId}.json`), "utf8"));
  assert.equal(index.orchestrationOperation.id, "create-one"); assert.equal(index.name, "Pi child");
  await engine.close();
  const successor = new PiEngine({ directory, cwd: directory, models: models() });
  successor.setOrchestration({ tools: THREAD_ORCHESTRATION_TOOLS, async call() { return toolResult; } });
  t.after(() => successor.close());
  const reconciled = await successor.request("opencraft/orchestration/create", { operationId: "create-one", settings }, owner);
  assert.equal(reconciled.threadId, first.threadId);
  assert.equal((await readdir(directory)).filter(file => /^pi_.*\.json$/u.test(file)).length, 1);
  await assert.rejects(successor.request("opencraft/orchestration/create", { operationId: "new-operation", settings }, owner), /Host changed/);
  await assert.rejects(successor.request("opencraft/orchestration/create", { operationId: "create-one", settings: { ...settings, cwd: tmpdir() } }, owner), /different settings/);
  assert.deepEqual(await successor.request("opencraft/orchestration/ack", { operationId: "create-one" }, owner), { acknowledged: true });
  const acknowledged = JSON.parse(await readFile(join(directory, `${first.threadId}.json`), "utf8"));
  assert.equal(acknowledged.orchestrationOperation, undefined);
});

test("Pi prepare reads source settings without native execution and rejects permission escalation", async t => {
  const { engine, directory } = await fixture(t);
  const child = await engine.request("thread/start", { cwd: directory, model: piModel("faux", "faux-1") }, owner);
  await engine.close();
  const reopened = new PiEngine({ directory, cwd: directory, models: models() });
  reopened.setOrchestration({ tools: THREAD_ORCHESTRATION_TOOLS, async call() { return toolResult; } });
  t.after(() => reopened.close());
  const path = join(directory, `${child.thread.id}.sqlite`), original = await readFile(path);
  const release = await lockfile.lock(path, { realpath: false, retries: 0 });
  let settings;
  try { settings = await reopened.request("opencraft/orchestration/prepare", { operationId: "read-only", threadId: child.thread.id, arguments: {} }, owner); }
  finally { await release(); }
  assert.equal(settings.cwd, directory); assert.equal(settings.model, piModel("faux", "faux-1"));
  assert.deepEqual(await readFile(path), original);
  await assert.rejects(reopened.request("opencraft/orchestration/prepare", { operationId: "escape", threadId: child.thread.id, arguments: { cwd: ".." } }, owner), /exceeds/);
  await assert.rejects(reopened.request("opencraft/orchestration/prepare", { operationId: "restricted", threadId: "codex-source", arguments: {},
    sourceSettings: { cwd: directory, sandbox: "read-only", approvalPolicy: "never" } }, owner), /preserve the source permission/);
});

test("Pi server-owned orchestration survives browser disconnect with the original native Turn", async t => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-pi-orchestration-disconnect-"));
  let release!: () => void, invoked!: () => void;
  const inTool = new Promise<void>(resolve => { invoked = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  const invocations: Array<Parameters<AgentOrchestrationPort["call"]>> = [];
  const engine = new PiEngine({ directory, cwd: directory, models: models([
    fauxAssistantMessage([fauxToolCall("opencraft_orchestration_thread_tell", { threadId: "other-engine", message: "hello" }, { id: "tell-one" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("completed on the original Turn"),
  ]) });
  engine.setOrchestration({ tools: THREAD_ORCHESTRATION_TOOLS, async call(...args) {
    invocations.push(args); invoked(); await blocked;
    assert.equal(args[5].aborted, false); return toolResult;
  } });
  t.after(async () => { release(); await engine.close(); await rm(directory, { recursive: true, force: true }); });
  const created = await engine.request("thread/start", { cwd: directory, model: piModel("faux", "faux-1") }, owner);
  const settled = new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Pi native Turn did not finish")), 10000);
    const stop = engine.subscribe((method, params) => { if (method === "turn/completed") { clearTimeout(timeout); stop(); resolve(params.turn); } });
  });
  const started = await engine.request("turn/start", { threadId: created.thread.id, clientUserMessageId: "human-input", input: [{ type: "text", text: "tell another engine" }] }, owner);
  await inTool; engine.disconnect(owner); release();
  const turn = await settled;
  assert.equal(turn.id, started.turn.id); assert.equal(turn.status, "completed"); assert.equal(invocations.length, 1);
  assert.equal(invocations[0][0], created.thread.id); assert.equal(invocations[0][1], started.turn.id);
  assert.equal(invocations[0][2], "tell-one"); assert.equal(invocations[0][3], "thread_tell"); assert.equal(invocations[0][6], "human-input");
  const snapshot = await engine.request("opencraft/orchestration/status", { operationId: "status", threadId: created.thread.id }, owner);
  assert.equal(snapshot.state, "completed"); assert.equal(snapshot.rootTurnId, started.turn.id);
});
