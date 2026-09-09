import { randomBytes } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { WebSocket, WebSocketServer } from "ws";

import { DshAppServerAdapter } from "./dsh-appserver-adapter.js";
import { DshClient, DshClientError } from "./dsh-client.js";
import { DshSupervisor } from "./dsh-supervisor.js";
import { HostProcessService } from "./process-service.js";

type JsonRpcMessage = Record<string, unknown>;

function rpcError(error: unknown): { code: number; message: string; data?: unknown } {
  if (error instanceof DshClientError) return { code: -32001, message: error.message, data: { code: error.code, retryable: error.retryable } };
  return { code: -32603, message: error instanceof Error ? error.message : String(error) };
}

function send(socket: WebSocket, value: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

async function fileRequest(method: string, params: unknown): Promise<unknown> {
  const value = typeof params === "object" && params !== null ? params as Record<string, unknown> : {};
  const path = resolve(String(value.path ?? homedir()));
  if (method === "fs/readDirectory") {
    const entries = await readdir(path, { withFileTypes: true });
    return { entries: entries.map((entry) => ({ name: entry.name, path: resolve(path, entry.name), type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "unknown" })) };
  }
  if (method === "fs/getMetadata") {
    const metadata = await stat(path);
    return { path, type: metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : "unknown", size: metadata.size, modifiedAt: Math.floor(metadata.mtimeMs / 1_000) };
  }
  if (method === "fs/readFile") return { dataBase64: (await readFile(path)).toString("base64") };
  if (method === "fs/writeFile") {
    await writeFile(path, Buffer.from(String(value.dataBase64 ?? ""), "base64"));
    return {};
  }
  throw new Error(`Unsupported filesystem method ${method}`);
}

export async function startLocalAgentHost(options: {
  readonly host?: string;
  readonly port?: number;
  readonly token?: string;
  readonly dshUrl?: string;
  readonly dshExecutable?: string;
  readonly dshRepository?: string;
  readonly dataDirectory?: string;
} = {}) {
  const supervisor = new DshSupervisor({
    executable: options.dshExecutable,
    repository: options.dshRepository,
    dataDirectory: options.dataDirectory,
  });
  const dshUrl = options.dshUrl ?? await supervisor.start();
  const adapter = new DshAppServerAdapter(new DshClient(dshUrl));
  const processes = new HostProcessService();
  const token = options.token ?? randomBytes(24).toString("base64url");
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (url.pathname === "/health") {
      response.statusCode = 200;
      response.end(`${JSON.stringify({ ok: true, engine: "dsh" })}\n`);
      return;
    }
    response.statusCode = 404;
    response.end(`${JSON.stringify({ ok: false, error: "Not found" })}\n`);
  });
  const websocketServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/rpc" || url.searchParams.get("token") !== token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (client) => websocketServer.emit("connection", client, request));
  });
  websocketServer.on("connection", (socket) => {
    const offered = new Set<string>();
    const openedThreads = new Set<string>();
    let unsubscribeInteractions: (() => void) | undefined;
    const unsubscribe = adapter.subscribe((method, params) => {
      if (method === "serverRequest/resolved") offered.delete(String((params as { requestId: unknown }).requestId));
      send(socket, { jsonrpc: "2.0", method, params });
    });
    const unsubscribeProcesses = processes.subscribe((method, params) => send(socket, { jsonrpc: "2.0", method, params }));
    socket.on("message", async (data, isBinary) => {
      if (isBinary) { socket.close(1003, "Text frames only"); return; }
      let request: JsonRpcMessage;
      try { request = JSON.parse(data.toString("utf8")) as JsonRpcMessage; }
      catch { send(socket, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }); return; }
      if (request && typeof request === "object" && typeof request.id === "string" && !("method" in request) && ("result" in request || "error" in request)) {
        if (!offered.has(request.id)) return;
        try { await adapter.interactions.respond(request.id, request); }
        catch (error) {
          console.error("[opencraft local host] interaction response failed", error);
          socket.close(1011, "Interaction response failed; reconnect to recover pending requests");
        }
        return;
      }
      // JSON-RPC notifications (including initialized) have no response.
      if (request && typeof request === "object" && !("id" in request) && typeof request.method === "string") return;
      if (!request || typeof request !== "object" || (typeof request.id !== "string" && typeof request.id !== "number") || typeof request.method !== "string") {
        send(socket, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
        return;
      }
      try {
        const result = request.method.startsWith("process/")
          ? processes.dispatch(request.method, request.params)
          : request.method.startsWith("fs/")
          ? await fileRequest(request.method, request.params)
          : await adapter.dispatch(request.method, request.params);
        send(socket, { jsonrpc: "2.0", id: request.id, result });
        // Initialization (including preflight) must not claim another client's
        // user interactions. Only a connection opening a thread may answer it.
        if (["thread/start", "thread/resume", "thread/fork", "turn/start"].includes(request.method) && socket.readyState === WebSocket.OPEN) {
          const reply = result as { thread?: { id?: string } } | null;
          const params = request.params as { threadId?: string } | undefined;
          const threadId = reply?.thread?.id ?? params?.threadId;
          if (typeof threadId === "string") openedThreads.add(threadId);
          unsubscribeInteractions?.();
          unsubscribeInteractions = adapter.interactions.subscribe(interaction => {
            if (!openedThreads.has(interaction.params.threadId) || offered.has(interaction.id)) return;
            offered.add(interaction.id);
            send(socket, { jsonrpc: "2.0", ...interaction });
          });
        }
      } catch (error) {
        send(socket, { jsonrpc: "2.0", id: request.id, error: rpcError(error) });
      }
    });
    socket.once("close", () => { unsubscribe(); unsubscribeProcesses(); unsubscribeInteractions?.(); offered.clear(); openedThreads.clear(); });
  });
  try {
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
        server.off("error", reject);
        resolvePromise();
      });
    });
  } catch (error) {
    adapter.close();
    processes.close();
    for (const client of websocketServer.clients) client.terminate();
    websocketServer.close();
    if (server.listening) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await supervisor.stop();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Local Agent Host did not bind a TCP port");
  const websocketUrl = `ws://127.0.0.1:${address.port}/rpc?token=${encodeURIComponent(token)}`;
  return {
    websocketUrl,
    dshUrl,
    async close(): Promise<void> {
      adapter.close();
      processes.close();
      for (const client of websocketServer.clients) client.close(1001, "OpenCraft is quitting");
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      await supervisor.stop();
    },
  };
}
