import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { startLocalAgentHost } from "../apps/local-agent-host/src/main.js";
import { decodeModel } from "../apps/local-agent-host/src/dsh-appserver-adapter.js";

const directory = await mkdtemp(join(tmpdir(), "oc-model-capabilities-"));
const captured: any[] = [], frames: any[] = [];
const endpoint = createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString()); captured.push(body);
  res.setHeader("content-type", "text/event-stream");
  res.end(`data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", created: 1, model: body.model,
    choices: [{ index: 0, delta: { role: "assistant", content: "Verified" }, finish_reason: null }] })}\n\n`
    + `data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", created: 1, model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
});
let host: Awaited<ReturnType<typeof startLocalAgentHost>> | undefined, socket: WebSocket | undefined, nextId = 1;
async function request(method: string, params: any = {}) {
  const id = nextId++, ws = socket!;
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { ws.off("message", receive); reject(new Error("Timed out: " + method)); }, 20000);
    const receive = (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString()); if (frame.id !== id) return;
      clearTimeout(timer); ws.off("message", receive);
      frame.error ? reject(new Error(frame.error.message)) : resolve(frame.result);
    };
    ws.on("message", receive); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}
async function connect() {
  socket = new WebSocket(host!.websocketUrl); socket.on("message", data => frames.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); });
  await request("initialize");
}
async function defaults(value: { provider: string; model: string } | null) {
  const settings = await request("runtime/settings/describe");
  const ns = settings.namespaces.find((entry: any) => entry.ns === "agent-default-model");
  await request("runtime/settings/mutate", { ns: ns.ns, expectedRevision: ns.revision, ops: [
    ...["provider", "model"].map(key => value ? { op: "set", path: [key], value: value[key as keyof typeof value] } : { op: "unset", path: [key] }),
    { op: "unset", path: ["reasoningEffort"] },
  ] });
}
try {
  await new Promise<void>(resolve => endpoint.listen(0, "127.0.0.1", resolve));
  const port = (endpoint.address() as { port: number }).port;
  const options = { dshExecutable: resolve("runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"), dataDirectory: directory, modelStorageDirectory: join(directory, "models") };
  host = await startLocalAgentHost(options); await connect();
  const directoryView = await request("runtime/providers/list");
  const saved = await request("runtime/providers/apply", { target: { kind: "create", id: "capability-local" }, expectedRevision: directoryView.creation.revision,
    displayName: "Capability fixture", baseURL: `http://127.0.0.1:${port}/v1`, api: "openai-completions",
    models: [{ id: "text-fixture", input: ["text"], contextWindow: 8192, maxTokens: 1024 },
      { id: "vision-fixture", input: ["text", "image"], contextWindow: 8192, maxTokens: 1024 }],
    credential: { kind: "replace", value: "synthetic-local-capability-key" } });
  await request("runtime/providers/setEnabled", { provider: "capability-local", enabled: true, expectedRevision: saved.revision });
  const models = (await request("model/list")).data;
  const text = models.find((entry: any) => decodeModel(entry.model)?.model === "text-fixture");
  const vision = models.find((entry: any) => decodeModel(entry.model)?.model === "vision-fixture");
  assert.ok(text && vision); assert.deepEqual(text.inputModalities, ["text"]); assert.deepEqual(vision.inputModalities, ["text", "image"]);
  assert.equal(models.some((entry: any) => entry.isDefault), false);
  await assert.rejects(request("thread/start", { cwd: directory }), /请先选择模型/);
  const parent = (await request("thread/start", { cwd: directory, model: text.model })).thread.id;
  const image = await readFile(resolve("apps/workbench-expo/ios/OpenCraft/Images.xcassets/AppIcon.appiconset/App-Icon-1024x1024@1x.png"));
  const input = [{ type: "image", url: "data:image/png;base64," + image.toString("base64") }];
  await assert.rejects(request("turn/start", { threadId: parent, input }), /does not support image|不支持 image 输入/);
  assert.equal(captured.length, 0);
  const child = (await request("thread/start", { cwd: directory, model: vision.model })).thread.id;
  await request("turn/start", { threadId: child, clientUserMessageId: "vision-test", input });
  const deadline = Date.now() + 20000;
  while (!frames.some(frame => frame.method === "turn/completed" && frame.params.threadId === child)) {
    if (Date.now() > deadline) throw new Error("Vision turn did not settle");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(captured.some(body => body.model === "vision-fixture" && JSON.stringify(body.messages).includes("image_url")));
  await defaults({ provider: "capability-local", model: "vision-fixture" });
  assert.equal((await request("model/list")).data.find((entry: any) => entry.isDefault).model, vision.model);
  assert.equal((await request("thread/start", { cwd: directory })).model, vision.model);
  assert.equal((await request("thread/resume", { threadId: parent })).model, text.model);
  await defaults(null);
  const cleared = (await request("model/list")).data;
  assert.equal(cleared.filter((entry: any) => decodeModel(entry.model)?.provider === "capability-local").length, 2);
  assert.equal(cleared.some((entry: any) => entry.isDefault), false);
  assert.equal((await request("thread/start", { cwd: directory, model: text.model })).model, text.model);
  socket.close(); socket = undefined; await host.close();
  host = await startLocalAgentHost(options); await connect();
  const restored = (await request("model/list")).data;
  assert.equal(restored.filter((entry: any) => decodeModel(entry.model)?.provider === "capability-local").length, 2);
  assert.equal(restored.some((entry: any) => entry.isDefault), false);
  await assert.rejects(request("thread/start", { cwd: directory }), /请先选择模型/);
  assert.equal((await request("thread/resume", { threadId: parent })).model, text.model);
  console.log("PASS: real DSH input capabilities, text-image rejection, native vision request, explicit/cleared default and restart; synthetic loopback inference only");
} finally {
  socket?.close(); await host?.close(); await new Promise<void>(resolve => endpoint.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
