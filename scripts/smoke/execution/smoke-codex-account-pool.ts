import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { WebSocketTransport, type AppServerWebSocket } from "@opencraft/appserver-transport-websocket";
import WebSocket from "ws";

import {
  AccountPoolStore,
  CodexAccountPoolProxy,
  createCodexAccountPoolLaunch,
  startCodexAccountPoolServer,
} from "../../../packages/account-pool-host/src/index.js";

async function listen(server: ReturnType<typeof createHttpServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind");
  return address.port;
}

async function reservePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot reserve AppServer port");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

const root = await mkdtemp(join(tmpdir(), "opencraft-codex-pool-smoke-"));
const profile = join(root, "codex-home");
await mkdir(profile, { mode: 0o700 });
const store = new AccountPoolStore({
  databasePath: join(root, "account-pool.sqlite"),
  secretsDirectory: join(root, "secrets"),
});
for (let index = 0; index < 3; index++) store.addAccount({
  id: `fixture-account-${index}`, provider: "codex", label: `Fixture ${index}`,
  upstreamAccountId: `fixture-chatgpt-account-${index}`, priority: index, enabled: true,
}, { accessToken: `fixture-account-access-${index}`, refreshToken: null, expiresAt: null });
const hostToken = store.issueHostToken("smoke-host");
let modelRequests = 0;
const upstreamAccounts = new Set<string>();
const upstreamSequence: string[] = [];
const upstreamAuthorizations = new Set<string>();
const upstreamPoolTokens = new Set<string>();
const model = createHttpServer((request, response) => {
  request.resume();
  if (request.url === "/backend-api/codex/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: "gpt-test", object: "model", owned_by: "fixture" }] }));
    return;
  }
  if (request.url !== "/backend-api/codex/responses") {
    response.writeHead(404);
    response.end();
    return;
  }
  modelRequests += 1;
  upstreamAccounts.add(String(request.headers["chatgpt-account-id"] ?? ""));
  upstreamSequence.push(String(request.headers["chatgpt-account-id"] ?? ""));
  upstreamAuthorizations.add(String(request.headers.authorization ?? ""));
  upstreamPoolTokens.add(String(request.headers["x-opencraft-account-pool-token"] ?? ""));
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "x-codex-primary-used-percent": "10",
  });
  const item = {
    id: "fixture-message",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Fixture response.", annotations: [] }],
  };
  for (const event of [
    { type: "response.created", response: { id: "fixture-response", object: "response", created_at: 1, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Fixture response." },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "fixture-response", object: "response", created_at: 1, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
});
const modelPort = await listen(model);
const poolServer = await startCodexAccountPoolServer({
  proxy: new CodexAccountPoolProxy({
    store,
    upstreamBaseUrl: `http://127.0.0.1:${modelPort}/backend-api/codex`,
  }),
});
const appServerPort = await reservePort();
const launch = createCodexAccountPoolLaunch({ baseUrl: poolServer.url, hostToken });
const executable = process.env.OPENCRAFT_CODEX_EXECUTABLE ?? "codex";
const codexVersion = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
const child = spawn(executable, [
  "app-server",
  "--listen", `ws://127.0.0.1:${appServerPort}`,
  ...launch.args,
  "-c", 'model="gpt-test"',
], {
  cwd: root,
  env: {
    ...process.env,
    ...launch.env,
    CODEX_HOME: profile,
    OPENAI_API_KEY: "fixture-appserver-key",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let startupError: Error | null = null;
let stderrTail = "";
child.on("error", error => { startupError = error; });
child.stdout.resume();
child.stderr.on("data", chunk => { stderrTail = `${stderrTail}${String(chunk)}`.slice(-4000); });
const client = new JsonRpcAppServerClient({
  hostId: "account-pool-smoke",
  requestTimeoutMs: 15_000,
  transport: new WebSocketTransport({
    url: `ws://127.0.0.1:${appServerPort}`,
    createSocket: url => new WebSocket(url) as unknown as AppServerWebSocket,
  }),
});

try {
  let connected = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (startupError) throw startupError;
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${appServerPort}`);
        socket.once("open", () => { socket.close(); resolve(); });
        socket.once("error", reject);
      });
      connected = true;
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  if (!connected) throw new Error(`Codex AppServer did not start: ${stderrTail}`);
  await client.connect({ clientInfo: { name: "opencraft-account-pool-smoke", version: "0.1.0" }, capabilities: { experimentalApi: true } });
  async function runTurn(threadId: string): Promise<void> {
    let stop = () => {};
    let timer: ReturnType<typeof setTimeout>;
    const completed = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Codex fixture turn timed out: ${stderrTail}`)), 20_000);
      stop = client.subscribeNotification(notification => {
        if (notification.method !== "turn/completed" || notification.params.threadId !== threadId) return;
        notification.params.turn.status === "completed" ? resolve() : reject(new Error(`Codex fixture turn failed: ${notification.params.turn.status}`));
      });
    });
    try {
      await client.request("turn/start", { threadId, input: [{ type: "text", text: "Reply with fixture response", text_elements: [] }] });
      await completed;
    } finally { clearTimeout(timer!); stop(); }
  }
  const threads: string[] = [];
  for (let index = 0; index < 4; index++) {
    const { thread } = await client.request("thread/start", { cwd: root, model: "gpt-test" });
    threads.push(thread.id);
    await runTurn(thread.id);
  }
  await runTurn(threads[0]!);
  assert.equal(modelRequests, 5);
  assert.deepEqual(upstreamSequence, [0, 1, 2, 0, 0].map(index => `fixture-chatgpt-account-${index}`));
  assert.equal(upstreamAccounts.size, 3);
  assert.deepEqual([...upstreamAuthorizations].sort(), [0, 1, 2].map(index => `Bearer fixture-account-access-${index}`));
  assert.deepEqual([...upstreamPoolTokens], [""]);
  console.log(JSON.stringify({
    result: "passed",
    codexVersion,
    transport: "real Codex AppServer WebSocket through OpenCraft Account Pool",
    localFixtureModelRequests: modelRequests,
    externalModelRequests: 0,
  }));
} finally {
  await client.close().catch(() => undefined);
  child.kill("SIGTERM");
  await poolServer.close().catch(() => undefined);
  await new Promise<void>(resolve => model.close(() => resolve()));
  store.close();
  await rm(root, { recursive: true, force: true });
}
