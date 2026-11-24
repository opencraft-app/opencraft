// The WorkspaceHost object's container endpoint adapters
// (apps/headless-server/src/cloudflare/workspace-link.ts) against the real Node
// servers the container owners use: `node:http` and `ws` on a Unix socket, reached
// through a dial that carries bytes the way an endpoint relay does.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import type { SandboxEndpointConnection } from "@opencraft/sandbox";
import {
  endpointHttpRequest,
  endpointJsonRpcRead,
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
  const result = await endpointJsonRpcRead(dial, "/rpc?token=t", "thread/turns/list", { threadId: "t" });
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
