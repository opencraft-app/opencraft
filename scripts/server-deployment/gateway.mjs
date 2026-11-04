import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { CodexCoreControlClient } from "../../packages/account-pool-host/src/index.ts";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket, WebSocketServer } from "ws";
import { MessagePortAppHostClient } from "../../packages/app-host-client/src/index.ts";
import { OpenCraftDaemonClientManager } from "../../apps/workbench-electron/src/daemon-client.ts";
import { readGatewayUpdateIntent } from './gateway-update-intent.mjs';

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
// Keep one idle IPC observer: a startup snapshot cannot prove daemon liveness.
// Recovery is shared, and probes never wait for a daemon to restart.
let stopping = false;
let readiness;
let readinessAttempt;
function ensureReadiness() {
  if (stopping || readiness) return Promise.resolve();
  if (!readinessAttempt) {
    const operation = daemon.connectAppHost('gateway-readiness').then(connection => {
      if (stopping) { connection.close(); return; }
      const unsubscribe = connection.subscribeClose(() => {
        unsubscribe();
        if (readiness === connection) readiness = undefined;
      });
      readiness = connection;
    }).finally(() => {
      if (readinessAttempt === operation) readinessAttempt = undefined;
    });
    readinessAttempt = operation;
  }
  return readinessAttempt;
}
// Startup traverses the deployed daemon IPC and Core without initializing DSH.
await core.health(AbortSignal.timeout(5000));
await ensureReadiness();
const server = createServer(async (request, response) => {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (stopping) { response.writeHead(503); response.end('{}'); return; }
  if (request.url !== '/health') { response.writeHead(404); response.end('{}'); return; }
  try {
    const observed = readiness;
    if (!observed) {
      void ensureReadiness().catch(() => {});
      throw new Error("Daemon readiness unavailable");
    }
    const health = await core.health(AbortSignal.timeout(5000));
    if (stopping || readiness !== observed) throw new Error("Daemon readiness changed");
    response.end(JSON.stringify({ ok: true, version: manifest.version, buildId: manifest.opencraftWeb.buildId, core: health, storage: observed.storage }));
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
    const next = queue.then(async () => {
      await ready;
      if (!closed) await transport.send(frame);
    }).catch((error) => {
      if (!closed) console.error(`[appserver-gateway] ${id}:`, error);
      close();
    });
    queue = next;
    // Retaining every completed promise keeps their closures reachable for the
    // life of a long-lived WebSocket. Truncate the chain once it is idle.
    void next.finally(() => { if (queue === next) queue = Promise.resolve(); });
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[appserver-gateway] ws://127.0.0.1:${port}/rpc`);
});
let shutdownOperation;
const shutdown = (update = null) => {
  if (shutdownOperation) return shutdownOperation;
  stopping = true;
  shutdownOperation = Promise.resolve().then(async () => {
    if (update) for (const socket of sockets.clients) if (socket.readyState === WebSocket.OPEN) socket.close(1012);
    readiness?.close();
    readiness = undefined;
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
  });
  return shutdownOperation;
};
const stop = () => void readGatewayUpdateIntent().then(update => shutdown(update)).then(() => process.exit(0), error => {console.error(error);process.exit(1);});
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
