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
const root = await mkdtemp(join(tmpdir(), "opencraft-instructions-"));
const requests: any[] = [], notifications: any[] = [];
const endpoint = createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const delta = (value: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({
    id: "synthetic", object: "chat.completion.chunk", created: 1, model: "fixture",
    choices: [{ index: 0, delta: value, finish_reason: finish }],
  })}\n\n`);
  delta({ role: "assistant", reasoning_content: "synthetic reasoning" });
  delta({ content: "synthetic reply" }); delta({}, "stop");
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
const start = async () => {
  host = await launch({ dataDirectory: join(root, "runtime"), modelStorageDirectory: directory,
    descriptorPath: join(root, "host-connection.json"),
    ...(packagedEntry ? { dshCapabilityPlugin: join(dirname(resolve(packagedEntry)), "dsh-capability-plugin.mjs") } : {}),
    dshExecutable: resolve("runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js") });
  socket = new WebSocket(host.websocketUrl);
  socket.on("message", raw => {
    const frame = JSON.parse(raw.toString());
    const handler = pending.get(String(frame.id));
    if (handler) { pending.delete(String(frame.id)); clearTimeout(handler.timer); frame.error ? handler.reject(new Error(frame.error.message)) : handler.resolve(frame.result); }
    else if (frame.method) notifications.push(frame);
  });
  await new Promise<void>(resolve => socket!.once("open", resolve));
  await call("initialize", { clientInfo: { name: "instructions-fixture", version: "1" }, capabilities: {} });
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
  const send = async (threadId: string, base: string, developer: string | null) => {
    const offset = notifications.length;
    const { turn } = await call("turn/start", { threadId, model, input: [{ type: "text", text: "synthetic task" }] });
    const deadline = Date.now() + 30000;
    const frames = () => notifications.slice(offset).filter(frame => frame.params?.threadId === threadId);
    while (!frames().some(frame => frame.method === "turn/completed" && frame.params.turn.id === turn.id)) {
      if (Date.now() > deadline) throw new Error("Synthetic turn did not complete");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(frames().find(frame => frame.method === "turn/completed")?.params.turn.status, "completed");
    const reasoningEnd = frames().findIndex(frame => frame.method === "item/completed" && frame.params.item.type === "reasoning");
    const textStart = frames().findIndex(frame => frame.method === "item/started" && frame.params.item.type === "agentMessage");
    assert.ok(reasoningEnd >= 0 && reasoningEnd < textStart, "native reasoning block completes before answer begins");
    const system = requests.filter(body => body.tools?.length && body.messages.some((m: any) => JSON.stringify(m.content).includes("synthetic task"))).at(-1)
      ?.messages.filter((m: any) => m.role === "system" || m.role === "developer").map((m: any) => JSON.stringify(m.content)).join("\n");
    assert.ok(system?.includes(base), `Missing synthetic base; roles=${requests.at(-1)?.messages.map((m: any) => m.role)} system=${system}`);
    if (developer) assert.ok(system?.includes(developer));
    else assert.ok(!system?.includes("fixture developer"));
    const history = (await call("thread/read", { threadId, includeTurns: true })).thread.turns;
    const latest = history.find((entry: any) => entry.id === turn.id);
    assert.equal(latest.items.filter((item: any) => item.type === "reasoning").length, 1);
    assert.equal(latest.items.find((item: any) => item.type === "agentMessage").text, "synthetic reply");
  };
  const threadId = (await call("thread/start", { cwd: root, model,
    baseInstructions: "fixture base A {{literal}}", developerInstructions: "fixture developer A" })).thread.id;
  await send(threadId, "fixture base A {{literal}}", "fixture developer A");
  await call("thread/resume", { threadId, baseInstructions: "fixture base B", developerInstructions: "fixture developer B" });
  await send(threadId, "fixture base B", "fixture developer B");
  const child = (await call("thread/fork", { threadId, developerInstructions: "fixture developer child" })).thread.id;
  await send(child, "fixture base B", "fixture developer child");
  socket!.terminate(); await host!.close(); await start();
  await call("thread/resume", { threadId });
  await send(threadId, "fixture base B", "fixture developer B");
  await host!.restartEngine();
  await send(threadId, "fixture base B", "fixture developer B");
  await call("thread/resume", { threadId, developerInstructions: "fixture developer generation" });
  await send(threadId, "fixture base B", "fixture developer generation");
  await call("thread/resume", { threadId, baseInstructions: null, developerInstructions: "" });
  await send(threadId, "fixture base B", null);
  console.log(JSON.stringify({ status: "passed", nativeRuntime: "0.1.1-rc.2", syntheticTurns: 7,
    verified: ["create", "loaded resume", "fork", "whole Host cold resume", "engine generation recovery", "generation update", "null retention", "empty developer clear", "block ordering", "history parity"] }));
} finally {
  socket?.terminate(); await host?.close();
  endpoint.closeAllConnections();
  await new Promise<void>(resolve => endpoint.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
