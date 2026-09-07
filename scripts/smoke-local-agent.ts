import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { startLocalAgentHost } from "../apps/local-agent-host/src/main.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDirectory = await mkdtemp(resolve(tmpdir(), "opencraft-smoke-"));
// This command tests the bundled dependency, never an already running server.
delete process.env.OPENCRAFT_DSH_URL;
delete process.env.OPENCRAFT_DSH_REPOSITORY;
let host: Awaited<ReturnType<typeof startLocalAgentHost>> | undefined;
let socket: WebSocket | undefined;
async function request(id: number, method: string) {
  const client = socket!;
  return new Promise<any>((resolveResponse, reject) => {
    const timeout = setTimeout(() => {
      client.off("message", listener);
      reject(new Error(`AppServer ${method} timed out`));
    }, 15_000);
    const listener = (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString());
      if (frame.id !== id) return;
      clearTimeout(timeout);
      client.off("message", listener);
      if (frame.error) reject(new Error(`AppServer ${method}: ${frame.error.message}`));
      else resolveResponse(frame.result);
    };
    client.on("message", listener);
    client.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }));
  });
}
try {
  host = await startLocalAgentHost({
    dshExecutable: resolve(root, "runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"),
    dataDirectory,
  });
  socket = new WebSocket(host.websocketUrl);
  await new Promise<void>((resolveOpen, reject) => {
    socket!.once("open", resolveOpen);
    socket!.once("error", reject);
  });
  const initialized = await request(1, "initialize");
  assert.equal(typeof initialized.codexHome, "string");
  const threads = await request(2, "thread/list");
  assert.ok(Array.isArray(threads.data));
  assert.equal(threads.data.length, 0, "Smoke host must not reuse existing session data");
  console.log("Local Agent smoke passed: real DSH → AppServer → WebSocket, fresh data, no model request.");
} finally {
  socket?.terminate();
  await host?.close();
  await rm(dataDirectory, { recursive: true, force: true });
}
