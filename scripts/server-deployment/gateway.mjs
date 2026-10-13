import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { CodexCoreControlClient } from "../../packages/account-pool-host/src/index.ts";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket, WebSocketServer } from "ws";
import { MessagePortAppHostClient } from "../../packages/app-host-client/src/index.ts";
import { OpenCraftDaemonClientManager } from "../../apps/workbench-electron/src/daemon-client.ts";

const releaseRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
const root = resolve(required("OPENCRAFT_EXECUTION_CWD"));
const state = resolve(required("OPENCRAFT_EXECUTION_STATE"));
const coreEndpoint = required("OPENCRAFT_CODEX_CORE_ENDPOINT");
const tokenPath = join(state, "daemon.token");
const port = Number(process.env.OPENCRAFT_GATEWAY_PORT || "9988");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid gateway port");

const daemon = new OpenCraftDaemonClientManager({
  endpoint: join(state, "daemon.sock"),
  tokenPath,
  tokenMode: "existing",
  runtimeDirectory: root,
  machineName: process.env.OPENCRAFT_MACHINE_NAME || undefined,
  daemonEntry: join(releaseRoot, "execution/daemon.cjs"),
  dshExecutable: required("OPENCRAFT_DSH_EXECUTABLE"),
  dshCapabilityPlugin: join(releaseRoot, "execution/dsh-capability-plugin.mjs"),
  dataDirectory: join(state, "data"),
  modelStorageDirectory: join(state, "models"),
  skillsDirectory: join(state, "skills"),
  codexExecutable: "/external-core-only",
  codexDataDirectory: join(state, "codex"),
  codexCoreEndpoint: coreEndpoint,
  nativeCodexHomeDirectory: join(state, "native-codex"),
  executable: process.execPath,
});

const manifest = JSON.parse(await readFile(join(releaseRoot, 'package.json'), 'utf8'));
const core = new CodexCoreControlClient(coreEndpoint, (await readFile(tokenPath, 'utf8')).trim());
// Readiness traverses the deployed daemon IPC and core, without initializing DSH.
await core.health(AbortSignal.timeout(5000));
const readiness = await daemon.connectAppHost('gateway-readiness');
readiness.close();
let stopping = false;
const server = createServer(async (request, response) => {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (stopping) { response.writeHead(503); response.end('{}'); return; }
  if (request.url !== '/health') { response.writeHead(404); response.end('{}'); return; }
  try {
    const connection = await daemon.connectAppHost('gateway-health');
    connection.close();
    const health = await core.health(AbortSignal.timeout(5000));
    response.end(JSON.stringify({ ok: true, version: manifest.version, buildId: manifest.opencraftWeb.buildId, core: health, storage: connection.storage }));
  } catch { response.writeHead(503); response.end(JSON.stringify({ ok: false })); }
});
const sockets = new WebSocketServer({ noServer: true });
const activeClosers = new Set();
const pendingClosures = new Set();
server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  const hostId = pathname === "/rpc" ? "local" : pathname === "/rpc/codex" ? "local-codex" : null;
  if (stopping || hostId === null) {
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client, hostId));
});

sockets.on("connection", (socket, hostId) => {
  const id = `web-${randomUUID()}`;
  let closed = false;
  let appHost;
  let transport;
  let unsubscribeFrame;
  let unsubscribeStatus;
  let queue = Promise.resolve();
  const close = () => {
    if (closed) return;
    closed = true;
    activeClosers.delete(close);
    unsubscribeFrame?.();
    unsubscribeStatus?.();
    const operation = (async () => {
      try { await transport?.close(); }
      finally { appHost?.close(); }
    })();
    pendingClosures.add(operation);
    void operation.catch((error) => console.error(`[appserver-gateway] ${id} close:`, error))
      .finally(() => pendingClosures.delete(operation));
    if (socket.readyState === WebSocket.OPEN) socket.close(1011, "AppServer connection closed");
  };
  activeClosers.add(close);
  socket.on("close", close);
  socket.on("error", close);

  const ready = daemon.connectAppHost(id).then((connection) => {
    if (closed) { connection.close(); return; }
    const listeners = new Set();
    const unsubscribe = connection.subscribeMessage((payload) => {
      for (const listener of listeners) listener({ data: payload });
    });
    const stop = connection.subscribeClose(() => close());
    const portAdapter = {
      postMessage: (message) => connection.send(message),
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      start() {},
      close() { unsubscribe(); stop(); connection.close(); },
    };
    appHost = new MessagePortAppHostClient(portAdapter, id);
    transport = appHost.createTransport(hostId);
    unsubscribeFrame = transport.subscribeMessage((frame) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(frame);
    });
    unsubscribeStatus = transport.subscribeStatus((status) => {
      if (status.state === "failed" || status.state === "closed") close();
    });
    return transport.connect();
  });
  ready.catch((error) => {
    if (!closed) console.error(`[appserver-gateway] ${id}:`, error);
    close();
  });

  socket.on("message", (data, isBinary) => {
    if (isBinary) { socket.close(1003, "JSON-RPC text required"); return; }
    const frame = data.toString();
    queue = queue.then(async () => {
      await ready;
      if (!closed) await transport.send(frame);
    }).catch((error) => {
      if (!closed) console.error(`[appserver-gateway] ${id}:`, error);
      close();
    });
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[appserver-gateway] ws://127.0.0.1:${port}/rpc`);
});
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  const serverClosed = new Promise((done) => server.close(done));
  const daemonClosed = daemon.shutdown();
  for (const close of [...activeClosers]) close();
  let closeDeadline;
  await Promise.race([
    Promise.allSettled([...pendingClosures]),
    new Promise((resolveDone) => { closeDeadline = setTimeout(resolveDone, 2_000); }),
  ]);
  clearTimeout(closeDeadline);
  for (const socket of sockets.clients) socket.terminate();
  sockets.close();
  server.closeAllConnections();
  await Promise.all([serverClosed, daemonClosed]);
};
process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
