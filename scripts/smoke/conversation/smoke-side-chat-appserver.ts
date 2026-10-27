import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import WebSocket from "ws";
import { Context } from "@deepseek-ai/cordis";
import { WebSocketTransport, type AppServerWebSocket } from "@opencraft/appserver-transport-websocket";
import { createAppServerWorkbenchRuntime, SideChatService } from "@opencraft/workbench-runtime";
import { createConversationKey } from "@opencraft/chat-core";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";

// Fresh profile: no user credentials, conversations or configuration are copied.
const profile = await mkdtemp(join(tmpdir(), "opencraft-sidechat-appserver-"));
let modelRequests = 0;
const model = createHttpServer((request, response) => {
  request.resume(); modelRequests++;
  response.writeHead(200, { "content-type": "text/event-stream" });
  const item = { id: "fixture-message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fixture response.", annotations: [] }] };
  for (const event of [
    { type: "response.created", response: { id: "fixture-response", object: "response", created_at: 1, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Fixture response." },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "fixture-response", object: "response", created_at: 1, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
});
await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
const modelAddress = model.address(); if (!modelAddress || typeof modelAddress === "string") throw new Error("No model port");
const reservation = createServer();
await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
const address = reservation.address();
if (!address || typeof address === "string") throw new Error("Cannot reserve test port");
const port = address.port;
await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
const child = spawn(process.env.OPENCRAFT_CODEX_EXECUTABLE ?? "codex", ["app-server", "--listen", `ws://127.0.0.1:${port}`, "-c", 'model_provider="fixture"', "-c", 'model="gpt-5.4"', "-c", 'model_providers.fixture.name="Local fixture"', "-c", `model_providers.fixture.base_url="http://127.0.0.1:${modelAddress.port}/v1"`, "-c", 'model_providers.fixture.wire_api="responses"', "-c", 'model_providers.fixture.requires_openai_auth=false'], { env: { ...process.env, CODEX_HOME: profile }, cwd: profile, stdio: ["ignore", "pipe", "pipe"] });
let startupError: Error | null = null;
child.on("error", error => { startupError = error; });
// Consume output without exporting unrelated server diagnostics.
child.stdout.resume(); child.stderr.resume();
const runtime = createAppServerWorkbenchRuntime({ hostId: "sidechat-test", autoReconnect: false, requestTimeoutMs: 15000,
  installClientHandlers: client => client.subscribeRequestLifecycle(event => { if (event.type === "failed") console.log("Failed operation:", event.method, event.error.message); }),
  transport: new WebSocketTransport({ url: `ws://127.0.0.1:${port}`, createSocket: url => new WebSocket(url) as unknown as AppServerWebSocket }) });
const ctx = new Context(); const fiber = ctx.plugin(SideChatService, { resolveHost: async () => runtime }); await fiber;
const seed = new JsonRpcAppServerClient({ hostId: "seed", transport: new WebSocketTransport({ url: `ws://127.0.0.1:${port}`, createSocket: url => new WebSocket(url) as unknown as AppServerWebSocket }) });
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (startupError) throw startupError;
    try {
      await new Promise<void>((resolve, reject) => { const socket = new WebSocket(`ws://127.0.0.1:${port}`); socket.on("open", () => { socket.close(); resolve(); }); socket.on("error", reject); });
      break;
    } catch (error) { if (attempt === 59) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  await runtime.connect();
  await seed.connect({ clientInfo: { name: "opencraft-workspace-test", version: "0.1.0" }, capabilities: { experimentalApi: true } });
  const { thread: parent } = await seed.request("thread/start", { cwd: profile });
  const finished = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error("Fixture turn did not complete")); }, 20000);
    const stop = seed.subscribeNotification(event => { if (event.method === "turn/completed" && event.params.threadId === parent.id) { clearTimeout(timer); stop(); console.log("Fixture turn:", event.params.turn.status, "local model requests:", modelRequests); event.params.turn.status === "completed" ? resolve() : reject(new Error("Fixture turn failed")); } });
  });
  await seed.request("turn/start", { threadId: parent.id, input: [{ type: "text", text: "Reply with fixture response", text_elements: [] }] });
  await finished;
  const session = await ctx.sideChats.open("test-child", createConversationKey("sidechat-test", parent.id), profile);
  assert.notEqual(session.key.threadId, parent.id);
  assert.equal(session.key.hostId, "sidechat-test");
  await new Promise<void>((resolve, reject) => {
    let stop = () => {};
    const timer = setTimeout(() => { stop(); reject(new Error("Child did not become authoritative")); }, 15000);
    const check = () => { const state = session.lease.getSnapshot(); if (state.authoritative || state.phase === "error") { clearTimeout(timer); stop(); state.authoritative ? resolve() : reject(state.error); } };
    stop = session.lease.subscribe(check); check();
  });
  session.composer.dispatch({ type: "set-document", document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "A question in the child" }] }] } });
  const childFinished = new Promise<void>((resolve, reject) => {
    let stop = () => {};
    const timer = setTimeout(() => { stop(); reject(new Error("Child turn did not complete")); }, 15000);
    const check = () => { const state = session.lease.getSnapshot(); if (state.activeTurn === null && state.timeline.frames.some(frame => frame.type === "assistant" && frame.status === "complete")) { clearTimeout(timer); stop(); resolve(); } };
    stop = session.lease.subscribe(check);
  });
  await ctx.sideChats.submit(session.id, session.composer.createSubmitIntent(), null);
  await childFinished;
  await ctx.sideChats.close(session.id);
  assert.equal(ctx.sideChats.get(session.id), null);
  // Fork adoption, not rollout Resume, is the child's authoritative baseline.
  console.log(JSON.stringify({ result: "passed", transport: "real Codex AppServer WebSocket", operations: ["thread/start", "parent turn (local fixture model)", "thread/fork ephemeral", "adopt fork baseline", "child turn (local fixture model)", "thread/unsubscribe"], externalModelRequests: 0, localFixtureModelRequests: modelRequests, isolatedProfile: profile }));
} finally {
  try { await fiber.dispose(); await runtime.dispose(); await seed.close(); }
  finally { child.kill("SIGTERM"); model.close(); }
}
