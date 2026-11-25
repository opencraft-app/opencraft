// The WorkspaceHost object's container endpoint adapters
// (apps/headless-server/src/cloudflare/workspace-link.ts) against the real Node
// servers the container owners use: `node:http` and `ws` on a Unix socket, reached
// through a dial that carries bytes the way an endpoint relay does.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import type { SandboxEndpointConnection } from "@opencraft/sandbox";
import { startControlServer } from "../../apps/codex-core/src/control-server.ts";
import { startOrchestrationCallbackRelay } from "../../apps/codex-core/src/orchestration-callback-lane.ts";
import { attachWorkspaceCodex } from "../../apps/headless-server/src/cloudflare/workspace-codex.ts";
import {
  endpointHttpRequest,
  endpointJsonRpcRequest,
  openEndpointWebSocket,
  type EndpointDial,
} from "../../apps/headless-server/src/cloudflare/workspace-link.ts";

/** One endpoint connection per dial: a Unix socket connection to `path`. */
const unixDial =
  (path: string): EndpointDial =>
  async (onData) => {
    const socket = connect(path);
    await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject));
    socket.on("data", (data) => onData(new Uint8Array(data)));
    socket.on("error", () => {});
    const closed = new Promise<"ended" | "failed">((resolve) => socket.once("close", () => resolve("ended")));
    const connection: SandboxEndpointConnection = {
      closed,
      write: (data) =>
        new Promise((resolve, reject) => socket.write(data, (error) => (error ? reject(error) : resolve()))),
      end: async () => void socket.end(),
      close: async () => void socket.destroy(),
    };
    return connection;
  };

test("HTTP over an endpoint: content-length and chunked bodies, status and headers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "oc-link-"));
  const path = join(directory, "http.sock");
  const server = createHttpServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (request.url === "/length") {
        response.writeHead(201, { "content-type": "application/json", "x-host": String(request.headers.host) });
        response.end(JSON.stringify({ method: request.method, body, auth: request.headers.authorization }));
      } else if (request.url === "/chunked") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.write("one,");
        setTimeout(() => response.end("two"), 20);
      } else response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  t.after(async () => {
    server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const dial = unixDial(path);
  const posted = await endpointHttpRequest(dial, "/length", {
    method: "POST",
    headers: { authorization: "Bearer token" },
    body: JSON.stringify({ a: 1 }),
  });
  assert.equal(posted.status, 201);
  assert.equal(posted.ok, true);
  assert.equal(posted.headers.get("x-host"), "workspace");
  assert.deepEqual(posted.json(), { method: "POST", body: '{"a":1}', auth: "Bearer token" });
  const chunked = await endpointHttpRequest(dial, "/chunked");
  assert.equal(chunked.text(), "one,two");
  const missing = await endpointHttpRequest(dial, "/missing");
  assert.equal(missing.status, 404);
  assert.equal(missing.ok, false);
  await assert.rejects(endpointHttpRequest(dial, "relative"), /Invalid endpoint request/u);
  await assert.rejects(endpointHttpRequest(dial, "/x", { headers: { "bad header": "x" } }), /header/u);
});

test("WebSocket over an endpoint: handshake, a message beyond 64 KiB, ping, JSON-RPC read", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "oc-link-"));
  const path = join(directory, "ws.sock");
  const http = createHttpServer();
  const sockets = new WebSocketServer({ server: http, path: "/rpc" });
  const requests: unknown[] = [];
  sockets.on("connection", (socket, request) => {
    requests.push(request.url);
    socket.ping();
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.method === "echo") {
        // Beyond 64 KiB: a frame with a 64-bit length.
        socket.send(JSON.stringify({ echo: "x".repeat(70_000) }));
        return;
      }
      if (message.method === "initialize") {
        socket.send(JSON.stringify({ method: "server/notice", params: {} }));
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === "thread/turns/list")
        socket.send(JSON.stringify({ id: message.id, result: { data: [{ id: "turn-1", status: "completed" }] } }));
    });
  });
  await new Promise<void>((resolve) => http.listen(path, resolve));
  t.after(async () => {
    sockets.close();
    http.close();
    await rm(directory, { recursive: true, force: true });
  });
  const dial = unixDial(path);
  const messages: string[] = [];
  const socket = await openEndpointWebSocket(dial, "/rpc?token=t", { onMessage: (text) => messages.push(text) });
  await socket.send(JSON.stringify({ method: "echo" }));
  while (!messages.length) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(JSON.parse(messages[0]!).echo.length, 70_000);
  await socket.close();
  await socket.closed;
  const result = await endpointJsonRpcRequest(dial, "/rpc?token=t", "thread/turns/list", { threadId: "t" });
  assert.deepEqual(result, { data: [{ id: "turn-1", status: "completed" }] });
  assert.deepEqual(requests, ["/rpc?token=t", "/rpc?token=t"]);
  // A refused upgrade fails the open, and a too-large message closes the socket.
  await assert.rejects(openEndpointWebSocket(dial, "/other", { onMessage: () => {} }), /refused|closed/u);
  const small: string[] = [];
  const limited = await openEndpointWebSocket(dial, "/rpc", {
    onMessage: (text) => small.push(text),
    maxPayload: 1024,
  });
  await limited.send(JSON.stringify({ method: "echo" }));
  await limited.closed;
  assert.deepEqual(small, []);
});

test("workspace Codex uses fenced owner endpoints and preserves approval and cancellation across reconnect", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "oc-codex-link-"));
  const path = join(directory, "native.sock");
  const callbackPath = join(directory, "callback.sock");
  const controlPath = join(directory, "control.sock");
  const http = createHttpServer();
  const upstream = new WebSocketServer({ server: http });
  await new Promise<void>((resolve) => http.listen(path, resolve));
  const requests: { id?: string; method?: string; params?: unknown; result?: unknown }[] = [];
  upstream.on("connection", (socket) => {
    socket.on("message", (frame) => {
      const request = JSON.parse(String(frame));
      requests.push(request);
      if (["initialize", "thread/resume", "turn/interrupt"].includes(request.method)) {
        socket.send(JSON.stringify({ id: request.id, result: {} }));
      }
    });
  });
  const callbacks = await startOrchestrationCallbackRelay(callbackPath, path, {});
  const token = randomUUID();
  let attested = true;
  let healthy = true;
  const paths: string[] = [];
  const control = await startControlServer(controlPath, token, async (request) => {
    paths.push(request.url ?? "");
    return {
      status: healthy || request.url === "/native-health" ? 200 : 503,
      value: {
        protocolVersion: 1,
        pid: 2,
        codexPid: 3,
        executionIncarnation: attested ? "native-child-incarnation" : undefined,
        nativeSocket: "/do-not-dial-an-in-container-path",
        callbackProtocolVersion: 1,
        callbackIncarnation: callbacks.incarnation,
        threadTitleToolVersion: 1,
      },
    };
  });
  t.after(async () => {
    await callbacks.close();
    for (const socket of upstream.clients) socket.terminate();
    upstream.close();
    await control.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const dials: string[] = [];
  const fences: string[] = [];
  let replace = false;
  const runtime: Parameters<typeof attachWorkspaceCodex>[0] = {
    workspaceId: "test-codex",
    async describe(endpoint) {
      assert.equal(endpoint.name, "codex-control");
      return { token };
    },
    async connect(endpoint, onData) {
      dials.push(endpoint.name);
      return unixDial(endpoint.name === "codex-control" ? controlPath : callbackPath)(onData);
    },
    async fenced(endpoint, operation) {
      fences.push(endpoint.name);
      const result = await operation({
        placement: { agentIncarnation: "fixture-incarnation" },
        describe: () => runtime.describe(endpoint),
        connect: (onData) => runtime.connect(endpoint, onData),
      });
      if (replace) throw new Error("Workspace agent incarnation changed");
      return result;
    },
  };
  const codex = attachWorkspaceCodex(runtime, () => true);
  assert.deepEqual(await codex.health(), {
    pid: 3,
    incarnation: "native-child-incarnation",
    callbackIncarnation: callbacks.incarnation,
    supportsThreadTitle: true,
  });
  healthy = false;
  await assert.rejects(codex.health(), /AppServer unavailable/u);
  assert.equal((await codex.health(true)).pid, 3);
  healthy = true;
  attested = false;
  await assert.rejects(codex.open("stable-host", () => assert.fail()), /AppServer unavailable/u);
  assert.ok(dials.every((target) => target === "codex-control"));
  attested = true;
  replace = true;
  await assert.rejects(codex.open("stale-host", () => assert.fail()), /incarnation changed/u);
  replace = false;
  await assert.rejects(codex.open("invalid&lane", () => assert.fail()), /Invalid Codex callback lane/u);

  async function until<T>(find: () => T | undefined): Promise<T> {
    const deadline = Date.now() + 3000;
    for (;;) {
      const value = find();
      if (value !== undefined) return value;
      if (Date.now() > deadline) throw Error("Timed out waiting for native AppServer");
      await delay(5);
    }
  }
  async function open(id: string) {
    const messages: Record<string, unknown>[] = [];
    const socket = await codex.open("stable-host", (frame) => messages.push(JSON.parse(frame)));
    t.after(() => socket.close());
    await socket.send(JSON.stringify({
      id, method: "initialize", params: { clientInfo: { name: "gateway", version: "1" } },
    }));
    await until(() => messages.find((message) => message.id === id));
    await socket.send(JSON.stringify({ method: "initialized" }));
    return { socket, messages };
  }

  const first = await open("initialize-first");
  await until(() => requests.find((request) => request.method === "initialized"));
  // The first throwaway connection never initialized. Select the real active lane.
  const native = [...upstream.clients].at(-1)!;
  native.send(JSON.stringify({
    id: "approval", method: "item/commandExecution/requestApproval",
    params: { threadId: "thread", turnId: "turn", itemId: "approval-item" },
  }));
  native.send(JSON.stringify({
    method: "item/agentMessage/delta",
    params: { threadId: "thread", turnId: "turn", itemId: "assistant", delta: "response" },
  }));
  const approval = await until(() => first.messages.find((message) => message.id === "approval"));
  await until(() => first.messages.find((message) => message.method === "item/agentMessage/delta"));
  await first.socket.close();
  await delay(15);

  const second = await open("initialize-second");
  const pending = await until(() => second.messages.find((message) => message.id === "approval"));
  assert.equal(pending.__opencraftInteractionKey, approval.__opencraftInteractionKey);
  const reply = JSON.stringify({ id: "approval", result: { decision: "accept" } });
  await second.socket.send(reply);
  await second.socket.send(reply);
  await second.socket.send(JSON.stringify({
    id: "interrupt", method: "turn/interrupt", params: { threadId: "thread", turnId: "turn" },
  }));
  await until(() => second.messages.find((message) => message.id === "interrupt"));
  await second.socket.send(JSON.stringify({
    id: "resume", method: "thread/resume", params: { threadId: "thread" },
  }));
  await until(() => second.messages.find((message) => message.id === "resume"));
  assert.equal(requests.filter((request) => request.id === "approval").length, 1);
  assert.equal(requests.filter((request) => request.method === "initialize").length, 1);
  assert.equal(requests.filter((request) => request.method === "turn/interrupt").length, 1);
  assert.ok(paths.includes("/native-health"));
  assert.ok(fences.includes("codex-native"));
  await second.socket.close();
});
