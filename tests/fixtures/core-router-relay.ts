import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { WebSocketServer } from "ws";
import { startOrchestrationCallbackRelay } from "../../apps/codex-core/src/orchestration-callback-lane";
import { CodexGenerationRegistry } from "../../apps/codex-core/src/generation-registry";
import { CodexGenerationRouter, startGenerationSocket, type GenerationRuntimeDirectory } from "../../apps/codex-core/src/generation-router";
import { startControlServer } from "../../apps/codex-core/src/control-server";

/** Real routing and retained callback ownership, backed by a read-only native fixture. */
export async function coreRouterRelayFixture() {
  const root = await mkdtemp(join(tmpdir(), "oc-initialize-recovery-"));
  const hostDataDirectory = join(root, "headless/codex"), directory = join(root, "native");
  await mkdir(directory, { mode: 0o700 });
  const nativePath = join(directory, "native.sock"), callbackPath = join(directory, "callback.sock"), routingPath = join(root, "router.sock");
  const http = createServer(), server = new WebSocketServer({ server: http }), sockets = new Set<WebSocket>();
  const calls: string[] = [];
  server.on("connection", socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    socket.on("message", raw => {
      const message = JSON.parse(String(raw));
      if (typeof message.method !== "string") return;
      calls.push(message.method);
      assert.ok(!["turn/start", "turn/steer", "thread/start"].includes(message.method), "recovery cannot replay execution");
      if (message.id === undefined) return;
      const result = message.method === "initialize" ? { userAgent: "synthetic-native", codexHome: directory }
        : ["thread/list", "thread/loaded/list", "model/list"].includes(message.method) ? { data: [] } : {};
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  await new Promise<void>(resolve => http.listen(nativePath, resolve));
  const relay = await startOrchestrationCallbackRelay(callbackPath, nativePath);
  const registry = new CodexGenerationRegistry(join(root, "registry"));
  registry.register({ id: "native", endpoint: join(root, "unused.sock"), runtimeDataDirectory: directory, executable: process.execPath,
    bundle: "/synthetic/app-server.mjs", node: process.execPath, cwd: root });
  registry.ready("native"); registry.activate("native", 0);
  const health = { protocolVersion: 1 as const, pid: process.pid, codexPid: process.pid, dataDirectory: directory,
    nativeSocket: callbackPath, proxyBaseUrl: "http://127.0.0.1:1", callbackProtocolVersion: 1 as const, pendingCallbacks: 0, pendingOrchestrationMutations: 0 };
  const runtime: GenerationRuntimeDirectory = { registry, ensure: async () => health, admit(ticket) { assert.ok(registry.valid(ticket)); return () => {}; }, observe() {} };
  let listener = await startGenerationSocket(routingPath, new CodexGenerationRouter(runtime));
  const endpoint = join(root, "control.sock"), token = "synthetic-initialize-recovery";
  const control = await startControlServer(endpoint, token, async request => request.url === "/health"
    ? { status: 200, value: { ...health, nativeSocket: routingPath, orchestrationRoutingVersion: 1, routingEpoch: registry.ownerEpoch } }
    : { status: 404, value: {} });
  const old = new WebSocket(`ws+unix://${routingPath}:/?opencraftLane=${createHash("sha256").update(hostDataDirectory).digest("hex")}`);
  const initialized = new Promise<void>((resolve, reject) => {
    old.once("message", raw => { const reply = JSON.parse(String(raw)); reply.error ? reject(Error(reply.error.message)) : resolve(); });
    old.once("error", reject);
  });
  await new Promise<void>((resolve, reject) => { old.once("open", resolve); old.once("error", reject); });
  old.send(JSON.stringify({ id: "old-init", method: "initialize", params: {} })); await initialized;
  return { root, hostDataDirectory, endpoint, token, calls,
    async releaseOld() { if (old.readyState !== WebSocket.CLOSED) { const closed = new Promise<void>(resolve => old.once("close", () => resolve())); old.terminate(); await closed; } await delay(100); },
    async restartRouter() { await listener.close(); listener = await startGenerationSocket(routingPath, new CodexGenerationRouter(runtime)); },
    async close() { old.terminate(); await listener.close(); await control.close(); await relay.close(); for (const socket of sockets) socket.terminate(); server.close(); await new Promise<void>(resolve => http.close(() => resolve())); registry.close(); await rm(root, { recursive: true, force: true }); },
  };
}
