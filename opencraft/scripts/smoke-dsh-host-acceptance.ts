import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { startLocalAgentHost } from "../apps/local-agent-host/src/main.js";
import { ModelConfigurationRepository, ModelCredentialRepository } from "../apps/local-agent-host/src/model-config/repository.js";

const root = await mkdtemp(join(tmpdir(), "opencraft-host-acceptance-"));
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const counts = new Map<string, number>();
let imageReceived = false;
let capabilityImageReceived = false;
let releaseQueuedModel: (() => void) | undefined;
const endpoint = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const text = JSON.stringify(body.messages);
  const scenario = ["QUEUE_NEXT", "QUEUE_FIRST", "CONTINUE", "IMAGE", "CAPABILITY", "CRASH", "RESTART", "INTERRUPT", "TOOLS"].find(tag => text.includes("SCENARIO_" + tag)) ?? "OTHER";
  const base = { id: "synthetic", created: 1, model: "fixture" };
  if (!body.stream) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "fixture" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    return;
  }
  res.setHeader("content-type", "text/event-stream");
  const delta = (value: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`);
  if (!Array.isArray(body.tools) || body.tools.length === 0) {
    delta({ role: "assistant", content: "fixture title" }); delta({}, "stop");
    res.end("data: [DONE]\n\n"); return;
  }
  counts.set(scenario, (counts.get(scenario) ?? 0) + 1);
  if (scenario === "IMAGE") imageReceived = text.includes("data:image/png;base64,");
  if (scenario === "CAPABILITY" && counts.get(scenario)! > 1) capabilityImageReceived ||= text.includes("data:image/");
  if (scenario === "RESTART" || scenario === "CRASH") { res.flushHeaders(); return; }
  if (scenario === "INTERRUPT") { delta({ role: "assistant", content: "partial output" }); return; }
  if (scenario === "QUEUE_FIRST") {
    delta({ role: "assistant", content: "queue-first-output" });
    releaseQueuedModel = () => { delta({}, "stop"); res.end("data: [DONE]\n\n"); };
    return;
  }
  if (scenario === "CAPABILITY" && counts.get(scenario) === 1) {
    assert.ok(body.tools.some((tool: any) => tool.function?.name === "fixture_host_tool"));
    delta({ role: "assistant", tool_calls: [{ index: 0, id: "host-call", type: "function", function: { name: "fixture_host_tool", arguments: "{}" } }] });
    delta({}, "tool_calls");
  } else if (scenario === "TOOLS" && counts.get(scenario)! <= 2) {
    delta({ role: "assistant", tool_calls: [{ index: 0, id: "call-" + counts.get(scenario), type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf fixture-tool-" + counts.get(scenario) }) } }] });
    delta({}, "tool_calls");
  } else {
    delta({ role: "assistant", content: "fixture-complete" });
    delta({}, "stop");
  }
  res.end("data: [DONE]\n\n");
});
let host: Awaited<ReturnType<typeof startLocalAgentHost>> | undefined;
let socket: WebSocket | undefined;
const notifications: any[] = [];
const pending = new Map<string, (frame: any) => void>();
let sequence = 0;
let hostCapabilityCalls = 0;
const wait = async (condition: () => boolean, label: string, timeout = 30000) => {
  const end = Date.now() + timeout;
  while (!condition() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(condition(), label);
};
const call = (method: string, params: unknown = {}): Promise<any> => new Promise((resolvePromise, reject) => {
  const id = "check-" + ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + " timed out")); }, 35000);
  pending.set(id, frame => { clearTimeout(timer); frame.error ? reject(new Error(frame.error.message)) : resolvePromise(frame.result); });
  socket!.send(JSON.stringify({ id, method, params }));
});
try {
  await new Promise<void>(resolvePromise => endpoint.listen(0, "127.0.0.1", resolvePromise));
  const port = (endpoint.address() as { port: number }).port;
  const directory = join(root, "models");
  await new ModelCredentialRepository(directory).set("FIXTURE_KEY", "synthetic-key");
  await new ModelConfigurationRepository(directory).initialize({
    schemaVersion: 1, revision: 0,
    providers: [{ id: "fixture-provider", name: "Fixture", protocol: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1`, credentialRef: "FIXTURE_KEY", enabled: true,
      models: [{ id: "fixture", enabled: true, input: ["text", "image"] }] }],
    defaultModel: { providerId: "fixture-provider", modelId: "fixture" },
  });
  host = await startLocalAgentHost({ dataDirectory: join(root, "runtime"), modelStorageDirectory: directory, dshExecutable: resolve("runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js") });
  const connectClient = async () => {
  socket = new WebSocket(host!.websocketUrl);
  socket.on("message", raw => {
    const frame = JSON.parse(raw.toString());
    if (frame.method === "item/tool/call") {
      assert.equal(frame.params.tool, "fixture_host_tool");
      hostCapabilityCalls++;
      socket!.send(JSON.stringify({ id: frame.id, result: { success: true, contentItems: [
        { type: "inputText", text: "host-tool-result" }, { type: "inputImage", imageUrl: "data:image/png;base64," + png },
      ] } }));
      return;
    }
    if (pending.has(frame.id)) { pending.get(frame.id)!(frame); pending.delete(frame.id); }
    else if (frame.method) notifications.push(frame);
  });
  await new Promise<void>(resolvePromise => socket!.once("open", resolvePromise));
  await call("initialize", { clientInfo: { name: "synthetic-acceptance", version: "1" }, capabilities: {} });
  };
  await connectClient();
  const model = (await call("model/list")).data[0].model;
  const startThread = async () => (await call("thread/start", { cwd: root, model })).thread.id as string;
  const send = async (threadId: string, scenario: string, extra: unknown[] = []) => {
    const result = await call("turn/start", { threadId, model, input: [{ type: "text", text: "SCENARIO_" + scenario }, ...extra] });
    return result.turn.id as string;
  };
  const terminal = (threadId: string, turnId: string) => notifications.find(frame => frame.method === "turn/completed" && frame.params.threadId === threadId && frame.params.turn.id === turnId)?.params.turn;

  const capable = (await call("thread/start", { cwd: root, model, dynamicTools: [
    { type: "function", name: "fixture_host_tool", description: "Fixture host tool", inputSchema: { type: "object", properties: {} } },
  ] })).thread.id;
  const skillPage = await call("skills/list", { cwds: [root] });
  assert.ok(skillPage.data[0].skills.some((skill: any) => skill.name === "opencraft-host-tools" && skill.scope === "system" && skill.path.endsWith("SKILL.md")));
  const capabilityTurn = await send(capable, "CAPABILITY");
  await wait(() => !!terminal(capable, capabilityTurn), "actual DSH -> host broker -> client tool response");
  assert.equal(terminal(capable, capabilityTurn).status, "completed");
  assert.equal(hostCapabilityCalls, 1);
  assert.ok(capabilityImageReceived, "host image result reaches the next actual model request");
  const richHistory = (await call("thread/read", { threadId: capable, includeTurns: true })).thread.turns;
  assert.ok(richHistory.some((turn: any) => turn.items.some((item: any) => item.type === "dynamicToolCall" && item.contentItems?.some((part: any) => part.type === "inputImage"))), "host image result survives AppServer history projection");

  const tools = await startThread(), toolTurn = await send(tools, "TOOLS");
  await wait(() => !!terminal(tools, toolTurn), "multi-step tools complete");
  assert.equal(terminal(tools, toolTurn).status, "completed");
  assert.equal(notifications.filter(frame => frame.method === "item/completed" && frame.params.threadId === tools && frame.params.item.type === "commandExecution").length, 2);
  const toolHistory = (await call("thread/read", { threadId: tools, includeTurns: true })).thread.turns[0];
  assert.equal(toolHistory.items.filter((item: any) => item.type === "commandExecution").length, 2);

  const queuedThread = await startThread();
  await send(queuedThread, "QUEUE_FIRST");
  await wait(() => !!releaseQueuedModel, "first queued scenario is in flight");
  const queued = await call("thread/queue/add", { threadId: queuedThread, clientUserMessageId: "queue-user-2",
    input: [{ type: "text", text: "SCENARIO_QUEUE_NEXT" }] });
  assert.equal(queued.queuedSubmission.clientUserMessageId, "queue-user-2");
  releaseQueuedModel!();
  await wait(() => counts.has("QUEUE_NEXT"), "native queue automatically consumes the reserved input");
  await wait(() => notifications.some(frame => frame.method === "item/completed" && frame.params.threadId === queuedThread && frame.params.item.clientId === "queue-user-2"), "queued input keeps original client identity");

  const interrupted = await startThread(), interruptedTurn = await send(interrupted, "INTERRUPT");
  await wait(() => notifications.some(frame => frame.method === "item/agentMessage/delta" && frame.params.threadId === interrupted), "partial output arrives");
  await call("turn/interrupt", { threadId: interrupted, turnId: interruptedTurn });
  assert.equal(terminal(interrupted, interruptedTurn).status, "interrupted");
  const continuedTurn = await send(interrupted, "CONTINUE");
  await wait(() => !!terminal(interrupted, continuedTurn), "continue after interruption");
  assert.equal(terminal(interrupted, continuedTurn).status, "completed");

  const restarted = await startThread(), restartedTurn = await send(restarted, "RESTART");
  await wait(() => counts.has("RESTART"), "in-flight request before restart");
  await host.restartEngine();
  assert.equal(terminal(restarted, restartedTurn).status, "failed");
  assert.equal(counts.get("RESTART"), 1, "restart must not replay inference");
  const recoveredTurn = await send(restarted, "CONTINUE");
  await wait(() => !!terminal(restarted, recoveredTurn), "continued work after process restart");
  assert.equal(terminal(restarted, recoveredTurn).status, "completed");
  const restored = (await call("thread/read", { threadId: tools, includeTurns: true })).thread.turns[0];
  assert.deepEqual(restored.items.map((item: any) => item.id), toolHistory.items.map((item: any) => item.id), "history identity survives process restart");

  const crashed = await startThread(), crashedTurn = await send(crashed, "CRASH");
  await wait(() => counts.has("CRASH"), "in-flight request before unexpected process exit");
  const ownedPid = host.engineProcessId;
  assert.ok(ownedPid && ownedPid > 0 && ownedPid !== process.pid);
  process.kill(ownedPid, "SIGKILL"); // Exact isolated child owned by this fixture.
  await wait(() => host!.engineState === "ready" && host!.engineProcessId !== ownedPid, "automatic bounded recovery after crash", 35000);
  assert.equal(terminal(crashed, crashedTurn).status, "failed");
  assert.equal(counts.get("CRASH"), 1, "crash recovery must not replay inference");
  const afterCrash = await send(crashed, "CONTINUE");
  await wait(() => !!terminal(crashed, afterCrash), "new work after automatic crash recovery");
  assert.equal(terminal(crashed, afterCrash).status, "completed");
  counts.set("CAPABILITY", 0);
  const restoredCapabilityTurn = await send(capable, "CAPABILITY");
  await wait(() => !!terminal(capable, restoredCapabilityTurn), "registered host capability survives engine restart");
  assert.equal(terminal(capable, restoredCapabilityTurn).status, "completed");
  assert.equal(hostCapabilityCalls, 2);

  const imageThread = await startThread(), imageTurn = await send(imageThread, "IMAGE", [{ type: "image", url: "data:image/png;base64," + png }]);
  await wait(() => !!terminal(imageThread, imageTurn), "image request completes");
  assert.equal(terminal(imageThread, imageTurn).status, "completed");
  assert.ok(imageReceived);
  const reconnectThread = await startThread(), reconnectTurn = await send(reconnectThread, "INTERRUPT");
  await wait(() => notifications.some(frame => frame.method === "item/agentMessage/delta" && frame.params.threadId === reconnectThread), "partial output before client disconnect");
  const previousSocket = socket!;
  const disconnected = new Promise<void>(resolvePromise => previousSocket.once("close", () => resolvePromise()));
  previousSocket.terminate(); await disconnected;
  await connectClient();
  await call("thread/resume", { threadId: reconnectThread });
  await call("turn/interrupt", { threadId: reconnectThread, turnId: reconnectTurn });
  await wait(() => !!terminal(reconnectThread, reconnectTurn), "reconnected owner interrupts active execution");
  assert.equal(terminal(reconnectThread, reconnectTurn).status, "interrupted");
  releaseQueuedModel = undefined;
  const durableQueueThread = await startThread();
  await send(durableQueueThread, "QUEUE_FIRST");
  await wait(() => !!releaseQueuedModel, "held response before full-host restart");
  const durableQueued = await call("thread/queue/add", { threadId: durableQueueThread, clientUserMessageId: "durable-queue-user",
    input: [{ type: "text", text: "SCENARIO_QUEUE_NEXT" }] });
  socket!.terminate();
  await host.close();
  host = await startLocalAgentHost({ dataDirectory: join(root, "runtime"), modelStorageDirectory: directory, dshExecutable: resolve("runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js") });
  await connectClient();
  await call("thread/resume", { threadId: durableQueueThread });
  const restoredQueue = await call("thread/queue/list", { threadId: durableQueueThread });
  assert.ok(restoredQueue.data.some((item: any) => item.clientUserMessageId === "durable-queue-user"), "pending queued input survives whole Host restart");
  const restoredItem = restoredQueue.data.find((item: any) => item.clientUserMessageId === "durable-queue-user");
  assert.equal(restoredItem.id, durableQueued.queuedSubmission.id, "logical queue identity survives Host restart");
  assert.equal(restoredItem.pausedReason, "restored-after-host-restart");
  const restartedQueuedTurn = (await call("thread/queue/start", { threadId: durableQueueThread, queuedSubmissionId: restoredItem.id })).turn.id;
  await wait(() => !!terminal(durableQueueThread, restartedQueuedTurn), "explicit start of restored queued input");
  assert.equal(terminal(durableQueueThread, restartedQueuedTurn).status, "completed");
  assert.equal((await call("thread/queue/list", { threadId: durableQueueThread })).data.some((item: any) => item.clientUserMessageId === "durable-queue-user"), false);
  const diagnostics = await call("runtime/diagnostics/read");
  assert.ok(diagnostics.presentation.emittedFrames > 0, "actual host reports pacing activity");
  assert.ok(diagnostics.executions.some((entry: any) => entry.events > 0 && entry.endedAt !== null), "actual host reports completed execution telemetry");
  assert.equal(notifications.some(frame => frame.method === "thread/started" && /\.g\d+$/.test(frame.params.thread?.id ?? "")), false, "unpublished native generations never become UI threads");
  console.log("PASS: two sequential real tool calls, interrupt/continue, explicit restart and automatic crash recovery during inference without replay, persisted history identities, image input. Synthetic local model only.");
} finally {
  socket?.terminate();
  await host?.close();
  endpoint.closeAllConnections();
  await new Promise<void>(resolvePromise => endpoint.close(() => resolvePromise()));
  await rm(root, { recursive: true, force: true });
}
