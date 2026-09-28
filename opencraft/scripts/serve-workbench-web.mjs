#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket, { WebSocketServer } from "ws";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function sendJson(response, statusCode, value) {
  response.statusCode = statusCode;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value)}\n`);
}

async function readJsonBody(request, maximumBytes = 256 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maximumBytes) throw new Error("Request body exceeds the runtime report limit");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function normalizeTarget(target) {
  const url = new URL(target);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`Unsupported AppServer WebSocket protocol: ${url.protocol}`);
  }
  return url.href;
}

function normalizeForwardedCloseCode(code, fallback) {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : fallback;
}

function requestOrigin(request, loopbackOnly) {
  const host = request.headers.host;
  if (typeof host !== "string") return null;
  try {
    const parsed = new URL(`http://${host}`);
    if (parsed.host !== host || (loopbackOnly && !["127.0.0.1", "localhost"].includes(parsed.hostname))) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function allowedSameOriginRequest(request, requireOrigin, loopbackOnly) {
  const expected = requestOrigin(request, loopbackOnly);
  if (expected === null) return false;
  const origin = request.headers.origin;
  if (requireOrigin) return origin === expected;
  return origin === undefined || origin === expected;
}

function bridgeAppServerSocket(client, request, options) {
  const protocolHeader = request.headers["sec-websocket-protocol"];
  const protocols = typeof protocolHeader === "string"
    ? protocolHeader.split(",").map((value) => value.trim()).filter(Boolean)
    : [];
  const upstreamOptions = {
    handshakeTimeout: 10_000,
    headers: {
      ...(options.hyperNodeUser ? { "x-hypernode-user": options.hyperNodeUser } : {}),
    },
  };
  const upstream = protocols.length > 0
    ? new WebSocket(options.appServerTarget, protocols, upstreamOptions)
    : new WebSocket(options.appServerTarget, upstreamOptions);
  const pending = [];
  let pendingBytes = 0;
  let clientClosed = false;

  client.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
      return;
    }
    if (upstream.readyState !== WebSocket.CONNECTING) return;
    pendingBytes += data.length;
    if (pending.length >= 512 || pendingBytes > 8 * 1024 * 1024) {
      client.close(1009, "AppServer connection queue limit exceeded");
      return;
    }
    pending.push({ data, isBinary });
  });

  upstream.on("open", () => {
    for (const message of pending.splice(0)) {
      upstream.send(message.data, { binary: message.isBinary });
    }
    pendingBytes = 0;
  });
  upstream.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on("close", (code, reason) => {
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
      client.close(normalizeForwardedCloseCode(code, 1011), reason);
    }
  });
  upstream.on("error", (error) => {
    if (!clientClosed) console.error("[opencraft appserver proxy]", error.message);
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
      client.close(1011, "AppServer gateway unavailable");
    }
  });
  client.on("close", (code, reason) => {
    clientClosed = true;
    if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
    else if (upstream.readyState === WebSocket.OPEN) {
      upstream.close(normalizeForwardedCloseCode(code, 1001), reason);
    }
  });
  client.on("error", () => upstream.terminate());
}

function validAppHostFrame(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const validId = value => typeof value === "string" && value.length > 0 && value.length <= 4096;
  if (message.type === "hello") {
    return message.protocolVersion === 1 && validId(message.rendererId);
  }
  if (!validId(message.requestId) || !validId(message.hostId) || !validId(message.leaseId)) return false;
  if (message.type === "host/connect") return true;
  if (message.type !== "host/send" && message.type !== "host/disconnect") return false;
  if (!Number.isSafeInteger(message.generation) || message.generation < 0) return false;
  return message.type === "host/disconnect" || typeof message.frame === "string";
}

const appHostAttemptPattern = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|client-[0-9]{10,15}-[a-z0-9]{1,20})$/iu;
const appHostFailureKinds = new Set(["socket-error", "socket-close", "handshake-timeout", "invalid-response"]);
const appHostPhases = new Set(["connecting", "socket-open", "ready"]);
const appHostDiagnosticKeys = new Set(["attemptId", "failure", "phase", "readyState", "ageMs", "closeCode"]);

function validAppHostDiagnostic(report) {
  return report && typeof report === "object" && !Array.isArray(report)
    && Object.keys(report).every(key => appHostDiagnosticKeys.has(key))
    && typeof report.attemptId === "string" && appHostAttemptPattern.test(report.attemptId)
    && appHostFailureKinds.has(report.failure)
    && appHostPhases.has(report.phase)
    && Number.isInteger(report.readyState) && report.readyState >= 0 && report.readyState <= 3
    && Number.isInteger(report.ageMs) && report.ageMs >= 0 && report.ageMs <= 86_400_000
    && (report.closeCode === undefined || (Number.isInteger(report.closeCode) && report.closeCode >= 0 && report.closeCode <= 4999));
}

function bridgeAppHostSocket(client, appHostServer, logDiagnostic) {
  const listeners = new Set();
  const pendingConnects = new Set();
  let connection = null;
  const port = {
    postMessage(message) {
      if (message?.type === "response" && pendingConnects.delete(message.requestId)) {
        logDiagnostic("host-connect", { ok: message.ok === true });
      }
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {},
    close() {
      if (client.readyState === WebSocket.OPEN) client.close(1000, "App Host closed");
    },
  };
  client.on("message", (raw, isBinary) => {
    if (isBinary) { logDiagnostic("invalid-frame", { code: 1003 }); client.close(1003, "Text frames required"); return; }
    let message;
    try { message = JSON.parse(raw.toString()); }
    catch { logDiagnostic("invalid-frame", { code: 1003 }); client.close(1003, "Invalid App Host frame"); return; }
    if (!validAppHostFrame(message)) { logDiagnostic("invalid-frame", { code: 1008 }); client.close(1008, "Invalid App Host request"); return; }
    if (connection === null) {
      if (message?.type !== "hello" || typeof message.rendererId !== "string" || !message.rendererId) {
        logDiagnostic("hello-required", { code: 1008 });
        client.close(1008, "App Host hello required");
        return;
      }
      try { connection = appHostServer.accept(port, message.rendererId); }
      catch { logDiagnostic("hello-rejected", { code: 1011 }); client.close(1011, "App Host unavailable"); return; }
      logDiagnostic("hello-accepted");
    }
    if (message.type === "host/connect") pendingConnects.add(message.requestId);
    for (const listener of listeners) listener(message);
  });
  client.once("close", () => connection?.close());
  client.once("error", () => connection?.close());
}

function resolveRequestPath(staticRoot, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const relativePath = decoded.replace(/^\/+/, "");
  const candidate = resolve(staticRoot, relativePath || "index.html");
  if (candidate !== staticRoot && !candidate.startsWith(`${staticRoot}${sep}`)) return null;
  return candidate;
}

function isContentHashedAsset(pathname) {
  return /^\/assets\/.+-[a-zA-Z0-9_-]{6,}\.[^/]+$/u.test(pathname);
}

function isWorkbenchApplicationRoute(pathname) {
  return /^\/(?:local|settings|threads|views)\/[^/]+\/?$/u.test(pathname);
}

async function serveFile(request, response, path, pathname) {
  const metadata = await stat(path);
  if (!metadata.isFile()) return false;
  response.statusCode = 200;
  response.setHeader("content-length", metadata.size);
  response.setHeader("content-type", contentTypes.get(extname(path).toLowerCase()) || "application/octet-stream");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("etag", `W/\"${metadata.size.toString(16)}-${Math.trunc(metadata.mtimeMs).toString(16)}\"`);
  if (pathname === "/" || pathname === "/index.html" || pathname === "/version.json") {
    response.setHeader("cache-control", "no-store, max-age=0");
  } else if (isContentHashedAsset(pathname)) {
    response.setHeader("cache-control", "public, max-age=31536000, immutable");
  } else {
    response.setHeader("cache-control", "no-cache");
  }
  if (request.method === "HEAD") {
    response.end();
    return true;
  }
  createReadStream(path).pipe(response);
  return true;
}

export async function createWorkbenchWebServer({
  root,
  appServerTarget = "ws://127.0.0.1:9988/rpc",
  hyperNodeUser = "",
  loopbackOnly = false,
  appHostServer = null,
  webSocketHeartbeatIntervalMs = 15_000,
  onAppHostDiagnostic = diagnostic => console.info("[opencraft apphost connection]", JSON.stringify(diagnostic)),
} = {}) {
  const staticRoot = await realpath(resolve(root || join(repositoryRoot, "apps/workbench-web/dist")));
  const normalizedTarget = appServerTarget === null ? null : normalizeTarget(appServerTarget);
  const runtimeReports = [];
  const emitAppHostDiagnostic = diagnostic => {
    try { onAppHostDiagnostic(diagnostic); }
    catch { /* Observability must not affect the connection. */ }
  };

  const server = createServer(async (request, response) => {
    try {
      if (loopbackOnly && !allowedSameOriginRequest(request, false, true)) {
        sendJson(response, 403, { ok: false, error: "Matching origin required" });
        return;
      }
      const url = new URL(request.url || "/", "http://vela.invalid");
      if (url.pathname === "/__opencraft_health") {
        sendJson(response, 200, { ok: true, appServerConfigured: normalizedTarget !== null });
        return;
      }
      if (url.pathname === "/__opencraft_runtime_error") {
        if (request.method !== "POST") {
          sendJson(response, 405, { ok: false, error: "POST required" });
          return;
        }
        const report = await readJsonBody(request);
        runtimeReports.push({ receivedAt: new Date().toISOString(), report });
        runtimeReports.splice(0, Math.max(0, runtimeReports.length - 20));
        console.error("[opencraft runtime error]", report);
        sendJson(response, 202, { ok: true });
        return;
      }
      if (url.pathname === "/__opencraft_apphost_diagnostic") {
        if (request.method !== "POST") {
          sendJson(response, 405, { ok: false, error: "POST required" });
          return;
        }
        let report;
        try { report = await readJsonBody(request, 1024); }
        catch {
          sendJson(response, 400, { ok: false, error: "Invalid App Host diagnostic" });
          return;
        }
        if (!validAppHostDiagnostic(report)) {
          sendJson(response, 400, { ok: false, error: "Invalid App Host diagnostic" });
          return;
        }
        emitAppHostDiagnostic({ event: "client-failure", attemptId: report.attemptId,
          failure: report.failure, phase: report.phase, readyState: report.readyState,
          ageMs: report.ageMs, ...(report.closeCode === undefined ? {} : { closeCode: report.closeCode }) });
        sendJson(response, 202, { ok: true });
        return;
      }
      if (url.pathname === "/appserver") {
        if (normalizedTarget === null) {
          sendJson(response, 404, { ok: false, error: "AppServer proxy is not available in this host" });
          return;
        }
        response.setHeader("connection", "upgrade");
        sendJson(response, 426, { ok: false, error: "WebSocket upgrade required" });
        return;
      }
      if (url.pathname === "/apphost") {
        sendJson(response, appHostServer === null ? 404 : 426,
          appHostServer === null
            ? { ok: false, error: "App Host is not available in this host" }
            : { ok: false, error: "WebSocket upgrade required" });
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { ok: false, error: "GET or HEAD required" });
        return;
      }
      if (url.pathname.endsWith(".map")) {
        sendJson(response, 404, { ok: false, error: "Source maps are not public" });
        return;
      }

      const requestedPath = resolveRequestPath(staticRoot, url.pathname);
      if (requestedPath == null) {
        sendJson(response, 400, { ok: false, error: "Invalid path" });
        return;
      }
      try {
        if (await serveFile(request, response, requestedPath, url.pathname)) return;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }

      const acceptsHtml = (request.headers.accept || "").includes("text/html");
      if (
        acceptsHtml &&
        (extname(url.pathname) === "" || isWorkbenchApplicationRoute(url.pathname))
      ) {
        await serveFile(request, response, join(staticRoot, "index.html"), "/index.html");
        return;
      }
      sendJson(response, 404, { ok: false, error: "Not found" });
    } catch (error) {
      console.error("[opencraft static server]", error);
      if (!response.headersSent) sendJson(response, 500, { ok: false, error: "Internal server error" });
      else response.destroy(error);
    }
  });

  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  const activeAppHostSockets = new Set();
  const liveWebSockets = new WeakSet();
  const appHostSocketDiagnostics = new WeakMap();
  const trackWebSocket = (client, logDiagnostic) => {
    liveWebSockets.add(client);
    client.on("pong", () => liveWebSockets.add(client));
    if (logDiagnostic) appHostSocketDiagnostics.set(client, logDiagnostic);
  };
  const heartbeat = webSocketHeartbeatIntervalMs > 0 ? setInterval(() => {
    for (const client of websocketServer.clients) {
      if (!liveWebSockets.has(client)) {
        appHostSocketDiagnostics.get(client)?.("heartbeat-timeout");
        client.terminate();
        continue;
      }
      liveWebSockets.delete(client);
      try { client.ping(); }
      catch { client.terminate(); }
    }
  }, webSocketHeartbeatIntervalMs) : null;
  heartbeat?.unref();
  server.on("upgrade", (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url || "/", "http://vela.invalid");
    } catch {
      socket.destroy();
      return;
    }
    const pathname = url.pathname;
    const attemptId = pathname === "/apphost" && appHostAttemptPattern.test(url.searchParams.get("attempt") || "")
      ? url.searchParams.get("attempt") : randomUUID();
    const startedAt = Date.now();
    const logAppHost = (event, detail = {}) => {
      if (pathname === "/apphost") emitAppHostDiagnostic({ event, attemptId, ageMs: Date.now() - startedAt, ...detail });
    };
    if (pathname === "/apphost") logAppHost("upgrade-attempt");
    if (loopbackOnly && !allowedSameOriginRequest(request, true, true)) {
      logAppHost("upgrade-rejected", { reason: "origin", code: 403 });
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (pathname === "/apphost" && appHostServer !== null) {
      websocketServer.handleUpgrade(request, socket, head, (client) => {
        trackWebSocket(client, logAppHost);
        activeAppHostSockets.add(client);
        logAppHost("upgrade-accepted", { active: activeAppHostSockets.size });
        client.once("close", code => {
          activeAppHostSockets.delete(client);
          logAppHost("closed", { code, active: activeAppHostSockets.size });
        });
        bridgeAppHostSocket(client, appHostServer, logAppHost);
      });
      return;
    }
    if (pathname === "/apphost") logAppHost("upgrade-rejected", { reason: "unavailable", code: 404 });
    if (pathname !== "/appserver") {
      socket.destroy();
      return;
    }
    if (normalizedTarget === null) {
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (client) => {
      trackWebSocket(client);
      bridgeAppServerSocket(client, request, {
        appServerTarget: normalizedTarget,
        hyperNodeUser,
      });
    });
  });

  return {
    server,
    staticRoot,
    appServerTarget: normalizedTarget,
    listen({ host = "0.0.0.0", port = 10000 } = {}) {
      return new Promise((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolvePromise(server.address());
        });
      });
    },
    close() {
      if (heartbeat !== null) clearInterval(heartbeat);
      for (const client of websocketServer.clients) client.terminate();
      websocketServer.close();
      return new Promise((resolvePromise, reject) => {
        server.close((error) => error ? reject(error) : resolvePromise());
      });
    },
  };
}

function parseNumber(value, fallback) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return parsed;
}

export async function runWorkbenchWebCli() {
  const host = process.env.OPENCRAFT_WEB_HOST || "0.0.0.0";
  const port = parseNumber(process.env.OPENCRAFT_WEB_PORT, 10000);
  const webServer = await createWorkbenchWebServer({
    root: process.env.OPENCRAFT_WEB_ROOT || join(repositoryRoot, "apps/workbench-web/dist"),
    appServerTarget: process.env.OPENCRAFT_APPSERVER_URL || "ws://127.0.0.1:9988/rpc",
    hyperNodeUser: process.env.OPENCRAFT_HYPERNODE_USER?.trim() || "",
  });
  const address = await webServer.listen({ host, port });
  console.log(`[opencraft static] ${webServer.staticRoot} -> http://${host}:${address.port}`);
  console.log(`[opencraft appserver] /appserver -> ${webServer.appServerTarget === null ? "disabled" : "configured"}`);
  const shutdown = async () => {
    await webServer.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
