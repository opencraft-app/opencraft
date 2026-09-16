import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { startLocalAgentHost } from "../apps/local-agent-host/src/main.js";
import { decodeModel } from "../apps/local-agent-host/src/dsh-appserver-adapter.js";
import { SIDE_CHAT_BOUNDARY, SIDE_CHAT_INSTRUCTIONS } from "../packages/workbench-runtime/src/side-chat/service.js";

const directory = await mkdtemp(join(tmpdir(), "oc-thread-smoke-"));
const captured: any[] = [];
const model = createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString()); captured.push(body);
  res.setHeader("content-type", "text/event-stream");
  res.end(`data: ${JSON.stringify({ id: "local-reply", object: "chat.completion.chunk", created: 1, model: "local-model", choices: [{ index: 0, delta: { role: "assistant", content: "Local verified response" }, finish_reason: null }] })}\n\n`
    + `data: ${JSON.stringify({ id: "local-reply", object: "chat.completion.chunk", created: 1, model: "local-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`);
});
await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
const address = model.address() as { port: number };
let host: Awaited<ReturnType<typeof startLocalAgentHost>> | undefined, socket: WebSocket | undefined;
const frames: any[] = [];
let nextId = 1;
async function request(method: string, params: any = {}, clientId = "a") {
  const id = nextId++, ws = socket!;
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { ws.off("message", receive); reject(new Error("Timed out: " + method)); }, 20000);
    const receive = (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString());
      if (frame.id !== id || frame.__opencraftClient !== clientId) return;
      clearTimeout(timer); ws.off("message", receive);
      frame.error ? reject(new Error(method + ": " + frame.error.message)) : resolve(frame.result);
    };
    ws.on("message", receive);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params, __opencraftClient: clientId }));
  });
}
async function connect() {
  socket = new WebSocket(host!.websocketUrl);
  socket.on("message", data => frames.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); });
  await request("initialize"); await request("initialize", {}, "b");
}
async function turn(threadId: string, text: string) {
  await request("turn/start", { threadId, clientUserMessageId: "message-" + nextId, input: [{ type: "text", text }] });
  const deadline = Date.now() + 20000;
  while (!frames.some(frame => frame.method === "turn/completed" && frame.params.threadId === threadId)) {
    if (Date.now() > deadline) throw new Error("Turn did not complete");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function files(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name); if (entry.isDirectory()) result.push(...await files(path)); else if (entry.isFile()) result.push(path);
  }
  return result;
}
try {
  const options = { dshExecutable: resolve("runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"), dataDirectory: directory, modelStorageDirectory: join(directory, "models") };
  host = await startLocalAgentHost(options); await connect();
  const providers = await request("runtime/providers/list");
  const saved = await request("runtime/providers/apply", { target: { kind: "create", id: "lifecycle-local" }, expectedRevision: providers.creation.revision,
    displayName: "Local lifecycle test", baseURL: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions",
    models: [{ id: "local-model", contextWindow: 8192, maxTokens: 1024 }], credential: { kind: "replace", value: "synthetic-local-test" } });
  await request("runtime/providers/setEnabled", { provider: "lifecycle-local", enabled: true, expectedRevision: saved.revision });
  const models = await request("model/list"); const modelId = models.data.find((model: any) => decodeModel(model.model)?.model === "local-model")?.model;
  assert.ok(modelId, "Configured local model must appear in the canonical catalog");
  const parent = (await request("thread/start", { cwd: directory, model: modelId })).thread.id;
  await turn(parent, "parent-context-marker");
  await request("thread/name/set", { threadId: parent, name: "Persistent user title" });
  const child = (await request("thread/fork", { threadId: parent, ephemeral: true, excludeTurns: true, developerInstructions: SIDE_CHAT_INSTRUCTIONS })).thread;
  assert.equal(child.ephemeral, true); assert.equal(child.forkedFromId, parent); assert.equal(child.parentThreadId, null);
  await request("thread/inject_items", { threadId: child.id, items: [{ type: "message", role: "user", content: [{ type: "input_text", text: SIDE_CHAT_BOUNDARY }] }] });
  await turn(child.id, "temporary-only-marker");
  const messages = captured.find(body => JSON.stringify(body.messages).includes("temporary-only-marker"))?.messages;
  assert.ok(messages); assert.match(JSON.stringify(messages), /parent-context-marker/); assert.match(JSON.stringify(messages), /Side conversation boundary/);
  assert.equal((await request("thread/list")).data.some((thread: any) => thread.id === child.id), false);
  await request("thread/resume", { threadId: parent }, "b");
  await request("thread/unsubscribe", { threadId: parent });
  assert.equal((await request("thread/read", { threadId: parent }, "b")).thread.name, "Persistent user title");
  await request("thread/unsubscribe", { threadId: child.id });
  for (const path of await files(directory)) {
    assert.equal((await readFile(path)).includes(Buffer.from("temporary-only-marker")), false, "Temporary history reached " + path);
  }
  await request("thread/archive", { threadId: parent });
  assert.equal((await request("thread/list")).data.some((thread: any) => thread.id === parent), false);
  assert.equal((await request("thread/list", { archived: true })).data[0].name, "Persistent user title");
  socket.close(); socket = undefined; await host.close();
  host = await startLocalAgentHost(options); await connect();
  assert.equal((await request("thread/list", { archived: true })).data[0].name, "Persistent user title");
  await request("thread/unarchive", { threadId: parent });
  assert.equal((await request("thread/read", { threadId: parent, includeTurns: true })).thread.turns.length > 0, true);
  console.log("PASS: real DSH canonical fork/boundary, volatile history, logical subscriptions, durable title/archive and restart recovery; synthetic local model only");
} finally {
  socket?.close(); await host?.close(); await new Promise<void>(resolve => model.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
