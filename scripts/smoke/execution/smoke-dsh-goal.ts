import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import { startLocalAgentHost } from "../../../apps/local-agent-host/src/main.js";
import { ModelConfigurationRepository, ModelCredentialRepository } from "../../../apps/local-agent-host/src/model-config/repository.js";

// Real locked DSH + Host + JSON-RPC + persistence. Only inference is local,
// synthetic and free; no user credentials, sessions or model service are used.
const root = await mkdtemp(join(tmpdir(), "opencraft-goal-"));
const requests: any[] = [], notifications: any[] = [];
const held: Array<() => void> = [];
let automatic = false, automaticRequests = 0;
const endpoint = createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); requests.push(body);
  if (!automatic) await new Promise<void>(resolve => held.push(resolve));
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const delta = (value: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({
    id: "synthetic", object: "chat.completion.chunk", created: 1, model: "fixture",
    choices: [{ index: 0, delta: value, finish_reason: finish }],
  })}\n\n`);
  const tool = (name: string, args: unknown) => {
    assert.ok(body.tools.some((tool: any) => tool.function.name === name), `Missing native ${name}`);
    delta({ role: "assistant", tool_calls: [{ index: 0, id: `call-${automaticRequests}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
    delta({}, "tool_calls");
  };
  if (automatic) automaticRequests++;
  if (automatic && automaticRequests === 2) tool("get_goal", {});
  else if (automatic && automaticRequests === 3) {
    const result = [...body.messages].reverse().find((m: any) => m.role === "tool");
    const goal = JSON.parse(result.content).goal;
    tool("update_goal", { goal_id: goal.id, revision: goal.revision, action: "complete" });
  } else { delta({ role: "assistant", content: "synthetic verified progress" }); delta({}, "stop"); }
  res.end("data: [DONE]\n\n");
});
let host: Awaited<ReturnType<typeof startLocalAgentHost>> | undefined;
let socket: WebSocket | undefined;
let sequence = 0;
const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const call = (method: string, params: unknown = {}): Promise<any> => new Promise((resolve, reject) => {
  const id = String(++sequence);
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 30000);
  pending.set(id, { resolve, reject, timer });
  socket!.send(JSON.stringify({ id, method, params }));
});
const directory = join(root, "models");
const packagedEntry = process.env.OPENCRAFT_DSH_FIXTURE_HOST_MODULE;
const launch = packagedEntry
  ? (await import(pathToFileURL(resolve(packagedEntry)).href)).startIndependentDshHost
  : startLocalAgentHost;
const connect = async () => {
  socket = new WebSocket(host!.websocketUrl);
  socket.on("message", raw => {
    const frame = JSON.parse(raw.toString());
    const handler = pending.get(String(frame.id));
    if (handler) { pending.delete(String(frame.id)); clearTimeout(handler.timer); frame.error ? handler.reject(new Error(frame.error.message)) : handler.resolve(frame.result); }
    else if (frame.method) notifications.push(frame);
  });
  await new Promise<void>(resolve => socket!.once("open", resolve));
  await call("initialize", { clientInfo: { name: "goal-fixture", version: "1" }, capabilities: {} });
};
const start = async () => {
  host = await launch({ dataDirectory: join(root, "runtime"), modelStorageDirectory: directory,
    descriptorPath: join(root, "host-connection.json"),
    ...(packagedEntry ? { dshCapabilityPlugin: join(dirname(resolve(packagedEntry)), "dsh-capability-plugin.mjs") } : {}),
    dshExecutable: resolve("runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js") });
  await connect();
};
try {
  await new Promise<void>(resolve => endpoint.listen(0, "127.0.0.1", resolve));
  await new ModelCredentialRepository(directory).set("FIXTURE_KEY", "synthetic-key");
  await new ModelConfigurationRepository(directory).initialize({ schemaVersion: 1, revision: 0,
    providers: [{ id: "fixture", name: "Fixture", protocol: "openai-completions",
      baseUrl: `http://127.0.0.1:${(endpoint.address() as any).port}/v1`, credentialRef: "FIXTURE_KEY", enabled: true,
      models: [{ id: "fixture", enabled: true, input: ["text"] }] }],
    defaultModel: { providerId: "fixture", modelId: "fixture" },
  });
  await start();
  const model = (await call("model/list")).data[0].model;
  const wait = async (predicate: () => boolean, label: string) => {
    const deadline = Date.now() + 30000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 20)); }
  };
  const release = () => { assert.ok(held.length, "a synthetic request is held"); held.shift()!(); };
  const create = async () => (await call("thread/start", { cwd: root, model })).thread.id;
  const goal = async (threadId: string) => (await call("thread/goal/get", { threadId })).goal;
  const set = (threadId: string, change: any) => call("thread/goal/set", { threadId, ...change });
  const completed = (threadId: string) => notifications.filter(frame => frame.method === "turn/completed" && frame.params.threadId === threadId);
  const threadId = await create();
  const init = await call("initialize", { clientInfo: { name: "goal-fixture", version: "1" }, capabilities: {} });
  assert.equal(init.capabilities.extensions["opencraft/thread-goal"].write, true);
  assert.equal(init.capabilities.extensions["opencraft/thread-goal"].usageAccounting, false);
  await assert.rejects(set(threadId, { objective: "invalid budget", status: "active", tokenBudget: 12 }));
  assert.equal(await goal(threadId), null);
  await set(threadId, { objective: "fixture native goal", status: "active", tokenBudget: null });
  await wait(() => held.length > 0, "first native goal round");
  assert.ok(notifications.some(frame => frame.method === "turn/started" && frame.params.threadId === threadId), "automatic goal turn admitted");
  assert.ok(notifications.some(frame => frame.method === "thread/goal/updated" && frame.params.threadId === threadId), "session-scoped goal changes delivered");
  await set(threadId, { status: "paused" });
  await set(threadId, { objective: "fixture edited native goal" });
  assert.equal((await goal(threadId)).status, "paused");
  assert.equal((await goal(threadId)).objective, "fixture edited native goal");
  release(); await wait(() => completed(threadId).length === 1, "paused round completion");
  await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(held.length, 0);
  await set(threadId, { status: "active" });
  await wait(() => held.length > 0, "resumed goal round");
  const disconnected = new Promise<void>(resolve => socket!.once("close", () => resolve()));
  socket!.terminate(); await disconnected; release();
  await wait(() => held.length > 0, "next same-session native round after socket loss");
  await connect(); await call("thread/resume", { threadId });
  await set(threadId, { status: "complete" }); release();
  await wait(() => completed(threadId).length === 2, "completion stops continuation");
  assert.equal((await goal(threadId)).status, "complete");
  assert.equal(completed(threadId).every(frame => frame.params.turn.status === "completed"), true);
  assert.equal((await call("thread/read", { threadId, includeTurns: true })).thread.turns.length, 3);
  await call("thread/goal/clear", { threadId }); assert.equal(await goal(threadId), null);
  // A real native goal tool completes the second automatic round and still
  // emits its final assistant answer. Only the model endpoint is synthetic.
  automatic = true;
  const autonomous = await create();
  await set(autonomous, { objective: "fixture autonomous completion", status: "active" });
  await wait(() => completed(autonomous).length === 2, "native get_goal/update_goal and final answer");
  assert.equal((await goal(autonomous)).status, "complete");
  assert.equal(automaticRequests, 4);
  const history = (await call("thread/read", { threadId: autonomous, includeTurns: true })).thread.turns;
  assert.ok(history.at(-1).items.some((item: any) => item.type === "agentMessage" && item.text === "synthetic verified progress"));
  // Cold restore retains durable goal state without silently rearming it.
  automatic = false;
  const cold = await create(); await set(cold, { objective: "fixture cold restore", status: "active" });
  await wait(() => held.length > 0, "cold goal starts");
  socket!.terminate(); await host!.close(); held.splice(0).forEach(resolve => resolve());
  const before = requests.length; await start();
  await call("thread/resume", { threadId: cold });
  const restored = await goal(cold);
  assert.equal(restored.objective, "fixture cold restore"); assert.equal(restored.execution.activation, "disarmed");
  await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(requests.length, before);
  await set(cold, { status: "active" }); await wait(() => held.length > 0, "explicit cold resume");
  await call("thread/goal/clear", { threadId: cold }); release();
  await wait(() => completed(cold).length > 0, "clear finishes active round");
  assert.equal(await goal(cold), null);
  console.log(JSON.stringify({ status: "passed", nativeRuntime: "0.1.1-rc.2", modelRequests: requests.length,
    verified: ["native Goal CRUD", "pause/resume", "same-session continuation admission", "continuation after socket loss and owner reconnect", "session-scoped notification", "native goal tools and final answer", "history parity", "cold restore disarmed", "explicit rearm", "unsupported token budget rejected"] }));

} finally {
  held.splice(0).forEach(resolve => resolve());
  socket?.terminate(); await host?.close();
  endpoint.closeAllConnections();
  await new Promise<void>(resolve => endpoint.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
