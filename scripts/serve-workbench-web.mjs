#!/usr/bin/env node
import { McpAppsRpcSession } from "../packages/mcp-apps/src/transport.ts";
import { serveNotModified } from "./web-asset-cache.mjs";
import { APP_HOST_PROTOCOL_VERSION } from "@opencraft/app-host-protocol/version";

import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket, { WebSocketServer } from "ws";
import { trackSocketHeartbeat } from "./websocket-heartbeat.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contentTypes = new Map([
  [".webmanifest", "application/manifest+json"],
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

// TLS may terminate at the trusted deployment's reverse proxy. Compare the
// browser's exact Origin authority with Host, never trust forwarded headers.
function allowedInternalDesktopOrigin(request) {
  try {
    const origin = new URL(request.headers.origin);
    return ["http:", "https:"].includes(origin.protocol)
      && origin.origin === request.headers.origin && origin.host === request.headers.host;
  } catch { return false; }
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
  const identitySession = options.identity?.open(frame => {
    if (client.readyState === WebSocket.OPEN && options.authorize?.() !== false) client.send(frame);
  });
  const appSession = options.mcpAppsService ? new McpAppsRpcSession(options.mcpAppsService, frame => {
    if (client.readyState === WebSocket.OPEN && options.authorize?.() !== false) client.send(frame);
  }) : null;
  const querySession = options.createAppServerQuerySession?.(frame => {
    if (client.readyState === WebSocket.OPEN && options.authorize?.() !== false) client.send(frame);
  });
  const forward = async (data, isBinary) => {
    if (options.authorize?.() === false) { client.close(1008, 'Instance access revoked'); return; }
    if (identitySession && isBinary) { client.close(1003, "Text frames only"); return; }
    try {
      if (!isBinary && await querySession?.receive(data.toString("utf8"), options.submissionContext)) return;
      if (clientClosed || options.authorize?.() === false) return;
      if (!isBinary && appSession?.receive(data.toString("utf8"), options.submissionContext)) return;
      const frame = identitySession ? identitySession.toNative(data.toString("utf8"), options.submissionContext) : data;
      if (frame !== null) upstream.send(frame, { binary: isBinary });
    } catch {
      client.close(1011, "Thread identity service unavailable"); upstream.close();
    }
  };
  const pending = [];
  let pendingBytes = 0;
  let clientClosed = false;

  client.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      forward(data, isBinary);
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
      forward(message.data, message.isBinary);
    }
    pendingBytes = 0;
  });
  upstream.on("message", (data, isBinary) => {
    if (client.readyState !== WebSocket.OPEN) return;
    if (options.authorize?.() === false) { client.close(1008, 'Instance access revoked'); return; }
    try {
      if (identitySession && isBinary) throw new Error("Binary identity frame");
      // Identity restores rewritten request IDs before query initialization is correlated.
      const restored = identitySession ? identitySession.fromNative(data.toString("utf8")) : data;
      const frame = restored !== null && !isBinary && querySession ? querySession.project(String(restored)) : restored;
      if (frame !== null) client.send(appSession && !isBinary ? appSession.project(String(frame), options.submissionContext) : frame, { binary: isBinary });
    } catch {
      client.close(1011, "Thread identity service unavailable"); upstream.close();
    }
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
    querySession?.close();
    appSession?.close();
    identitySession?.close();
    if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
    else if (upstream.readyState === WebSocket.OPEN) {
      upstream.close(normalizeForwardedCloseCode(code, 1001), reason);
    }
  });
  client.on("error", () => upstream.terminate());
}

// Return bounded, allowlisted metadata only: never echo an untrusted frame value.
export function appHostFrameRejection(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return { reason: "not-object" };
  const types = ["hello", "connection/probe", "host/connect", "host/send", "host/disconnect"];
  const messageType = types.includes(message.type) ? message.type : "unknown";
  const reject = (reason, extra = {}) => ({ reason, messageType, ...extra });
  const validId = value => typeof value === "string" && value.length > 0 && value.length <= 4096;
  if (message.type === "hello") {
    if (message.protocolVersion !== APP_HOST_PROTOCOL_VERSION) return reject("protocol-version", {
      receivedProtocolVersion: Number.isSafeInteger(message.protocolVersion) && message.protocolVersion >= 0
        ? message.protocolVersion : "invalid",
    });
    return validId(message.rendererId) ? null : reject("renderer-id");
  }
  if (!validId(message.requestId)) return reject("request-id");
  if (message.type === "connection/probe") return null;
  if (!validId(message.hostId)) return reject("host-id");
  if (!validId(message.leaseId)) return reject("lease-id");
  if (message.type === "host/connect") return null;
  if (message.type !== "host/send" && message.type !== "host/disconnect") return reject("message-type");
  if (!Number.isSafeInteger(message.generation) || message.generation < 0) return reject("generation");
  return message.type === "host/disconnect" || typeof message.frame === "string" ? null : reject("frame-type");
}

const appHostAttemptPattern = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|client-[0-9]{10,15}-[a-z0-9]{1,20})$/iu;
const appHostFailureKinds = new Set(["socket-error", "socket-close", "handshake-timeout", "probe-timeout", "invalid-response"]);
const appHostPhases = new Set(["connecting", "socket-open", "ready"]);
const appHostDiagnosticKeys = new Set(["attemptId", "failure", "phase", "readyState", "ageMs", "closeCode"]);

const recoveryDiagnosticKeys = new Set(["kind", "recoveryId", "stage", "attemptId", "eventAtMs", "method", "elapsedMs", "attempt", "delayMs", "demand", "durationMs", "requests", "responseBytes", "projectionMs", "extraConversations", "nativeReads", "nativeEvents", "displayVersion", "messages", "timestamps", "workClocks", "authoritative", "cacheHit", "storageFailure", "renderedTimes", "visibleTimes", "touch", "viewportWidth"]);
const recoveryStages = new Set(["display-load", "display-save", "display-paint", "transport-unavailable", "manual-block", "waiting", "backoff", "connecting", "initializing", "host-ready", "resources", "revalidate", "provider-history", "history-started", "history-backoff", "request-slow", "request-failed", "history-authoritative", "history-failed", "history-authoritative-failed", "capability-ready", "capability-ready-failed", "replica-ready", "replica-ready-failed", "settled"]);
function validRecoveryDiagnostic(report) {
  return report && report.kind === "recovery" && Object.keys(report).every(key => recoveryDiagnosticKeys.has(key))
    && typeof report.recoveryId === "string" && /^recovery-[a-z0-9]{1,20}-[0-9]{1,12}$/.test(report.recoveryId)
    && recoveryStages.has(report.stage)
    && (report.attemptId === undefined || (typeof report.attemptId === "string" && appHostAttemptPattern.test(report.attemptId)))
    && (report.method === undefined || ["initialize", "thread/resume", "thread/read", "thread/turns/list", "thread/items/list"].includes(report.method))
    && Number.isFinite(report.elapsedMs) && report.elapsedMs >= 0
    && (report.demand === undefined || ["visible", "open", "cache"].includes(report.demand))
    && Object.entries(report).every(([key, value]) => ["kind", "recoveryId", "stage", "attemptId", "method", "demand"].includes(key)
      || (Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER));
}

const viewportGeometryKeys = new Set(["layoutHeight", "layoutWidth", "visualHeight", "visualWidth", "visualTop", "visualLeft", "pageTop", "scrollY", "scale", "shellTop", "shellHeight", "editorTop", "sendBottom", "editing"]);
const viewportOptionalGeometryKeys = new Set(["screenHeight", "screenWidth", "standalone", "statusBarOverlayRequested", "edgeSamplingActive", "safeLayoutTop", "rowTop", "rowHeight", "headerTop", "headerHeight", "shellPaddingTop", "rowPaddingTop", "cssTop", "cssHeight", "clientHeight", "rootTop", "rootHeight", "bodyTop", "bodyHeight", "fixedTop", "fixedLeft", "editorBottom", "composerTop", "composerBottom", "draftScroll", "editorScroll", "sendTop", "sendHit", "touchSequence", "touchScreenClientY", "touchPageClientY", "editorMinTop", "editorMaxTop", "shellMinTop", "shellMaxTop", "observedSamples"]);
function validViewportDiagnostic(report) {
  return report?.kind === "viewport"
    && typeof report.episode === "string" && /^viewport-[a-z0-9]{1,20}$/.test(report.episode)
    && typeof report.sourceRevision === "string" && /^[a-f0-9]{40}$/.test(report.sourceRevision)
    && [...viewportGeometryKeys].every(key => Number.isFinite(report[key]))
    && Object.entries(report).every(([key, value]) => ["kind", "episode", "sourceRevision"].includes(key)
      || ((viewportGeometryKeys.has(key) || viewportOptionalGeometryKeys.has(key)) && Number.isFinite(value) && Math.abs(value) <= 100_000))
    && (report.standalone === undefined || [0, 1].includes(report.standalone))
    && ["statusBarOverlayRequested", "edgeSamplingActive"].every(key => report[key] === undefined || [0, 1].includes(report[key]))
    && (report.safeLayoutTop === undefined || [0, 1].includes(report.safeLayoutTop))
    && [0, 1].includes(report.editing) && report.scale > 0 && report.scale <= 20;
}

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

function bridgeAppHostSocket(client, appHostServer, logDiagnostic, authorize = () => true, submissionContext = { sender: null }) {
  const listeners = new Set();
  const pendingConnects = new Set();
  let connection = null;
  let frameSequence = 0;
  const frameContext = () => ({ frameSequence, phase: connection === null ? "awaiting-hello" : "ready" });
  const port = {
    postMessage(message) {
      if (!authorize(message)) { client.close(1008, "Connection access expired"); return; }
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
    frameSequence += 1;
    if (isBinary) { logDiagnostic("invalid-frame", { code: 1003, reason: "binary", ...frameContext() }); client.close(1003, "Text frames required"); return; }
    let message;
    try { message = JSON.parse(raw.toString()); }
    catch { logDiagnostic("invalid-frame", { code: 1003, reason: "json", ...frameContext() }); client.close(1003, "Invalid App Host frame"); return; }
    const rejection = appHostFrameRejection(message);
    if (rejection !== null) {
      logDiagnostic("invalid-frame", { code: 1008, ...frameContext(), ...rejection });
      if (rejection.reason === "protocol-version" && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "fatal", error: {
          code: "APP_HOST_PROTOCOL_MISMATCH",
          message: "Client and server versions are incompatible. Update or reload the client to reconnect.",
          retryable: false,
        } }));
      }
      client.close(1008, "Invalid App Host request");
      return;
    }
    if (!authorize(message)) {
      client.send(JSON.stringify({ type: "response", requestId: message.requestId, ok: false,
        error: { code: "SSH_ACCESS_REQUIRED", message: "Unlock remote connections in settings", retryable: false } }));
      return;
    }
    if (connection === null) {
      if (message?.type !== "hello" || typeof message.rendererId !== "string" || !message.rendererId) {
        logDiagnostic("hello-required", { code: 1008, ...frameContext(), messageType: message.type });
        client.close(1008, "App Host hello required");
        return;
      }
      try { connection = appHostServer.accept(port, message.rendererId, submissionContext); }
      catch { logDiagnostic("hello-rejected", { code: 1011 }); client.close(1011, "App Host unavailable"); return; }
      logDiagnostic("hello-accepted", { frameSequence, receivedProtocolVersion: message.protocolVersion });
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
  if (serveNotModified(request, response)) return true;
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
  resolveAppServerTarget,
  appServerIdentity = null,
  createAppServerQuerySession = null,
  hyperNodeUser = "",
  loopbackOnly = false,
  appHostServer = null,
  sshServerDescriptors = [],
  sshManagement = null,
  getStorageOutcomes,
  getPluginHealth,
  getExecutionHealth,
  getHostReadiness,
  desktopService = null,
  desktopAccess = "loopback",
  speechService = null,
  remoteBrowserService = null,
  /** @type {import('@opencraft/app-host-server').WorkbenchRequestIdentity | null} */
  identityService = null,
  localAccess = null,
  accessService = null,
  actorService = null,
  actorCollaborationService = null,
  turnPushService = null,
  authService = null,
  observability = null,
  mcpAppsService = null,
  getImService = () => null,
  connectorService = null,
  hubService = null,
  speechPublicAccess = process.env.OPENCRAFT_SPEECH_PUBLIC_ACCESS === "1",
  webSocketHeartbeatIntervalMs = 15_000,
  onAppHostDiagnostic = diagnostic => console.info("[opencraft apphost connection]", JSON.stringify(diagnostic)),
  ...unknownOptions
} = {}) {
  if (Object.keys(unknownOptions).length) throw new Error("Unknown workbench gateway option; check server composition");
  if (identityService !== null && (!identityService || ["admissionStatus", "connectionContext", "handle"].some(method => typeof identityService[method] !== "function"))) throw new Error("Invalid request identity service");
  if (!["loopback", "trusted-internal"].includes(desktopAccess)) throw new Error("Invalid desktop access policy");
  if (desktopService !== null && desktopAccess === "loopback" && !loopbackOnly) throw new Error("Local desktop requires a loopback-only gateway");
  const staticRoot = await realpath(resolve(root || join(repositoryRoot, "apps/workbench-web/dist")));
  if (sshServerDescriptors.length && !loopbackOnly && !sshManagement?.options.publicOrigin && !sshManagement?.options.publicAccess) throw new Error("SSH Server catalog requires a protected listener");
  const normalizedTarget = appServerTarget === null ? null : normalizeTarget(appServerTarget);
  const sameOrigin = (request, requireOrigin) => {
    const localOrigin = localAccess?.origin(request);
    return (!!localOrigin && (!requireOrigin || request.headers.origin === localOrigin))
      || allowedSameOriginRequest(request, requireOrigin, true)
      || (!!accessService?.trustedOrigin(request) && (request.headers.origin === accessService.trustedOrigin(request) || (!requireOrigin && request.headers.origin === undefined)));
  };
  const runtimeReports = [];
  let lastImRejection = {key: "", at: 0};
  const imRejectionCodes = new Set([
    "authentication_required", "instance_access_denied", "actor_access_denied",
    "actor_resource_interface_required", "human_authentication_required", "unsupported_host",
    "im_unavailable", "same_origin_required", "channel_denied", "missing",
    "too_large", "operation_failed", "invalid_input", "invalid_operation",
    "revision_conflict", "channel_missing", "invalid_route", "invalid_route_result",
    "invalid_preview", "invalid_credentials", "bot_already_configured",
    "connection_failed", "identity_conflict", "invalid_delivery", "invalid_platform",
  ]);
  const emitAppHostDiagnostic = diagnostic => {
    try { onAppHostDiagnostic({ serverProtocolVersion: APP_HOST_PROTOCOL_VERSION, ...diagnostic }); }
    catch { /* Observability must not affect the connection. */ }
  };

  const server = createServer(async (request, response) => {
    // Capture bounded error codes only, including admission failures before the
    // IM handler. Never retain request bodies, headers, identities or credentials.
    if ((request.url ?? "").split("?")[0] === "/__opencraft_im") {
      let code = "unknown";
      const end = response.end;
      response.end = function (...args) {
        if (response.statusCode >= 400) {
          try {
            const body = args[0];
            if ((typeof body === "string" || Buffer.isBuffer(body)) && Buffer.byteLength(body) <= 4096) {
              const value = JSON.parse(String(body)).error;
              if (typeof value === "string" && imRejectionCodes.has(value)) code = value;
              else if (value === "Matching origin required") code = "matching_origin_required";
            }
          } catch { /* Diagnostics never alter a response. */ }
        }
        return end.apply(this, args);
      };
      response.once("finish", () => {
        if (response.statusCode < 400) return;
        const key = response.statusCode + ":" + code, at = Date.now();
        if (lastImRejection.key === key && at - lastImRejection.at < 30000) return;
        lastImRejection = {key, at};
        console.warn("[opencraft im request rejected]", {status: response.statusCode, code});
      });
    }
    try {
      if (loopbackOnly && !sameOrigin(request, false)) {
        sendJson(response, 403, { ok: false, error: "Matching origin required" });
        return;
      }
      const url = new URL(request.url || "/", "http://opencraft.invalid");
      const local = !!localAccess?.origin(request);
      if (!local && !["/health", "/__opencraft_health"].includes(url.pathname)) await accessService?.prepare?.(request);
      // Login/callback endpoints must remain reachable before instance admission.
      if (url.pathname === '/__opencraft_auth' || url.pathname.startsWith('/__opencraft_auth/')) {
        if (authService && await authService.handle(request, response)) return;
        sendJson(response, 404, { error: 'missing' }); return;
      }
      if (url.pathname.startsWith('/__opencraft_actors/collaboration/')) {
        if (actorCollaborationService && await actorCollaborationService.handle(request, response)) return;
        sendJson(response, 404, { error: 'missing' }); return;
      }
      // Actor API has its own verified admission. A Session credential is never a
      // substitute for membership on the legacy unscoped execution interfaces.
      if (url.pathname === '/__opencraft_actors' || url.pathname.startsWith('/__opencraft_actors/')) {
        if (actorService && await actorService.handle(request, response)) return;
        sendJson(response, 404, { error: 'missing' }); return;
      }
      if (url.pathname === "/__opencraft_connectors") {
        if (connectorService && await connectorService.handle(request, response)) return;
        sendJson(response, 404, { error: "missing" }); return;
      }
      if (url.pathname === '/__opencraft_push') {
        if (turnPushService && await turnPushService.handle(request, response)) return;
        sendJson(response, 404, { error: 'missing' }); return;
      }
      if (actorService?.isSessionRequest(request)) {
        sendJson(response, 403, { error: 'actor_resource_interface_required' }); return;
      }
      // Health remains available to installation probes; no application data bypasses admission.
      if (!["/health", "/__opencraft_health"].includes(url.pathname)) {
        const status = local ? 204 : authService?.invalidSession(request) ? 401 : accessService?.admissionStatus(request) ?? identityService?.admissionStatus(request) ?? 204;
        if (status !== 204) {
          response.setHeader("cache-control", "private, no-store");
          if (request.headers.accept?.includes("text/html")) {
            response.writeHead(status, { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" });
            response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>访问受限</title><style>:root{color-scheme:light dark}a{color:inherit}a:focus-visible{outline:2px solid currentColor;outline-offset:4px}</style><body style="font:16px system-ui;margin:12vh auto;padding:24px;max-width:480px"><h1>暂时无法访问</h1><p>' + (status === 401 ? (authService ? '请登录后继续。' : '请通过认证入口重新访问。') : '你的账号暂未获得访问权限，请联系管理员。') + '</p>' + (authService ? '<a href="/__opencraft_auth/">登录与账号</a> · ' : '') + '<a href="">重新检查</a></body></html>');
          } else sendJson(response, status, { error: status === 401 ? "authentication_required" : "instance_access_denied" });
          return;
        }
      }
      if (!["/health", "/__opencraft_health"].includes(url.pathname) && actorService?.legacyAdmissionStatus(request) === 403) {
        sendJson(response, 403, { error: 'actor_access_denied' }); return;
      }
      if (local && url.pathname === '/__opencraft_access/admission' && request.method === 'GET') { response.writeHead(204, { 'cache-control': 'no-store' }); response.end(); return; }
      if (accessService) {
        const identity = accessService.authenticate(request);
        if (identity) { const unwatch = accessService.watch(identity, () => response.destroy()); response.once('close', unwatch); }
        if (await accessService.handle(request, response)) return;
      }
      if (url.pathname.startsWith("/__opencraft_observe/")) {
        if (observability && await observability.handle(request, response)) return;
        sendJson(response, url.pathname.endsWith("/capabilities") ? 200 : 503, url.pathname.endsWith("/capabilities") ? {available:false,telemetry:false} : {error:{code:"observation_unavailable",retryable:true}}); return;
      }
      if(url.pathname === '/__opencraft_im' || url.pathname.startsWith('/__opencraft_im/')) {
        const service=getImService();
        if(service && await service.handle(request,response,sameOrigin))return;
        sendJson(response,503,{error:'im_unavailable'});return;
      }
      if (hubService && await hubService.handle(request, response, () => {
        const identity = accessService?.authenticate(request);
        return identity && accessService.role(identity) === 'admin' ? JSON.stringify([identity.provider, identity.subject]) : null;
      })) return;
      if (url.pathname === "/__opencraft_access/admission") {
        if (request.method !== "GET") { sendJson(response, 405, { error: "method_not_allowed" }); return; }
        response.writeHead(204, { "cache-control": "private, no-store" }); response.end(); return;
      }
      if (identityService && await identityService.handle(request, response)) return;
      if (url.pathname.startsWith("/__opencraft_speech/")) {
        if (speechService === null) {
          const probe = url.pathname === "/__opencraft_speech/capabilities" && request.method === "GET";
          sendJson(response, probe ? 200 : 503, probe ? { available: false } : { error: { code: "unavailable", retryable: false } }); return;
        }
        await speechService.handle(request, response, (req, mutation) => {
          if (!loopbackOnly && !speechPublicAccess) return false;
          const origin = localAccess?.origin(req) ?? accessService?.trustedOrigin(req) ?? requestOrigin(req, loopbackOnly);
          if (origin === null) return false;
          // An HTTPS reverse proxy may retain the public Host; never trust forwarded Origin headers.
          const supplied = req.headers.origin;
          return mutation ? supplied === origin || (!loopbackOnly && supplied === origin.replace(/^http:/u, "https:"))
            : supplied === undefined || supplied === origin || (!loopbackOnly && supplied === origin.replace(/^http:/u, "https:"));
        });
        return;
      }
      if (url.pathname === '/__opencraft_browser/capabilities') {
        if (request.method !== 'GET') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        response.setHeader('cache-control', 'private, no-store');
        sendJson(response, 200, { available: !!remoteBrowserService && await remoteBrowserService.available(), codec: 'avc1.42E028', width: 1280, height: 720 }); return;
      }
      if (sshManagement && await sshManagement.handle(request, response)) return;
      if (!sshManagement && (url.pathname === "/__opencraft_ssh" || url.pathname.startsWith("/__opencraft_ssh/"))) {
        sendJson(response, 404, { error: "missing" }); return;
      }
      if (url.pathname === "/health" && getExecutionHealth) {
        try {
          const health = await getExecutionHealth();
          sendJson(response, health.ok === true ? 200 : 503, { ...health, storage: getStorageOutcomes?.() ?? [], ...(getPluginHealth ? {plugins:getPluginHealth()} : {}), ...(getHostReadiness ? { hosts: getHostReadiness() } : {}) });
        } catch { sendJson(response, 503, { ok: false }); }
        return;
      }
      if (url.pathname === "/__opencraft_health") {
        sendJson(response, 200, { ok: true, appServerConfigured: normalizedTarget !== null, ...(getPluginHealth ? {plugins:getPluginHealth()} : {}), ...(getHostReadiness ? { hosts: getHostReadiness() } : {}), ...(getStorageOutcomes ? { storage: getStorageOutcomes() } : {}) });
        return;
      }
      if (url.pathname === "/__opencraft_ssh_servers") {
        if (request.method !== "GET") { sendJson(response, 405, { ok: false }); return; }
        if (sshManagement) {
          sendJson(response, 200, sshManagement.authorized(request) ? [...sshServerDescriptors, ...sshManagement.catalog(request)] : []);
        } else {
          if (!loopbackOnly && sshServerDescriptors.length) { sendJson(response, 403, { ok: false }); return; }
          sendJson(response, 200, sshServerDescriptors);
        }
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
        try { report = await readJsonBody(request, 2048); }
        catch {
          sendJson(response, 400, { ok: false, error: "Invalid App Host diagnostic" });
          return;
        }
        if (validViewportDiagnostic(report)) {
          emitAppHostDiagnostic({ event: "client-viewport", ...report });
          sendJson(response, 202, { ok: true });
          return;
        }
        if (validRecoveryDiagnostic(report)) {
          emitAppHostDiagnostic({ event: "client-recovery", ...report });
          sendJson(response, 202, { ok: true });
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
      if (url.pathname === "/desktop/connect") {
        sendJson(response, desktopService === null ? 404 : 426, { ok: false, error: "Desktop connection unavailable" });
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
      if (url.pathname === "/apphost" || url.pathname === "/ssh-apphost") {
        sendJson(response, appHostServer === null ? 404 : 426,
          appHostServer === null
            ? { ok: false, error: "App Host is not available in this host" }
            : { ok: false, error: "WebSocket upgrade required" });
        return;
      }
      // Unregistered API routes cannot fall through to the SPA or a static file.
      if (url.pathname.startsWith("/__opencraft_")) {
        sendJson(response, 404, { ok: false, error: "Not found" }); return;
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
        // Product-owned standalone documents can share the static origin without
        // booting the Workbench SPA. Admission and reserved API routing stay above.
        if (extname(url.pathname) === "" && await serveFile(request, response, join(requestedPath, "index.html"), url.pathname)) return;
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

  // A supported 32 MiB attachment expands to ~43 MiB in Base64, then travels
  // inside JSON-RPC and (for Codex) an AppHost envelope. Keep a bounded 48 MiB
  // message limit so valid files do not disconnect the shared Host transport.
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 48 * 1024 * 1024 });
  const desktopWebSockets = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  const activeAppHostSockets = new Set();
  const socketHeartbeats = new WeakMap();
  const privateSockets = new Map();
  const revokePrivateSockets = () => {
    for (const [client, request] of privateSockets) if (!sshManagement?.authorized(request)) client.close(1008, "Connection access expired");
  };
  const unsubscribeRevocation = sshManagement?.onRevocation(revokePrivateSockets);
  const trackWebSocket = (client, logDiagnostic) => {
    socketHeartbeats.set(client, trackSocketHeartbeat(client, { intervalMs: webSocketHeartbeatIntervalMs, diagnostic: logDiagnostic }));
  };
  const heartbeat = webSocketHeartbeatIntervalMs > 0 ? setInterval(() => {
    revokePrivateSockets();
    for (const client of [...websocketServer.clients, ...desktopWebSockets.clients, ...(remoteBrowserService?.sockets ?? [])]) {
      socketHeartbeats.get(client)?.();
    }
  }, webSocketHeartbeatIntervalMs) : null;
  heartbeat?.unref();
  server.on("upgrade", async (request, socket, head) => {
    if (hubService?.node?.handleUpgrade(request, socket, head)) return;
    let url;
    try {
      url = new URL(request.url || "/", "http://opencraft.invalid");
    } catch {
      socket.destroy();
      return;
    }
    const pathname = url.pathname;
    const privateConnection = pathname === "/ssh-apphost";
    const appHostConnection = pathname === "/apphost" || privateConnection;
    const attemptId = appHostConnection && appHostAttemptPattern.test(url.searchParams.get("attempt") || "")
      ? url.searchParams.get("attempt") : randomUUID();
    const startedAt = Date.now();
    const logAppHost = (event, detail = {}) => {
      if (appHostConnection) emitAppHostDiagnostic({ event, attemptId, channel: privateConnection ? "private" : "public", ageMs: Date.now() - startedAt, ...detail });
    };
    if (appHostConnection) logAppHost("upgrade-attempt");
    if (loopbackOnly && !sameOrigin(request, true)) {
      logAppHost("upgrade-rejected", { reason: "origin", code: 403 });
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (actorService?.isSessionRequest(request)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n"); return;
    }
    let admissionStatus, submissionContext, principal;
    try {
      const local = !!localAccess?.origin(request);
      if (!local) await accessService?.prepare?.(request);
      admissionStatus = local ? 204 : authService?.invalidSession(request) ? 401 : accessService?.admissionStatus(request) ?? identityService?.admissionStatus(request) ?? 204;
      submissionContext = local ? { sender: null } : identityService ? identityService.connectionContext(request) : { sender: null };
      principal = local ? null : accessService?.authenticate(request);
      if (submissionContext !== null && (typeof submissionContext !== 'object'
        || (submissionContext.validUntil !== undefined && !Number.isFinite(submissionContext.validUntil)))) throw new Error("Invalid connection identity context");
    } catch {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); return;
    }
    if (admissionStatus !== 204) {
      logAppHost("upgrade-rejected", { reason: "identity-admission", code: admissionStatus });
      socket.end(`HTTP/1.1 ${admissionStatus} ${admissionStatus === 401 ? "Unauthorized" : "Forbidden"}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n`); return;
    }
    if (submissionContext === null || submissionContext.validUntil <= Date.now()) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n"); return;
    }
    try {
      if (actorService?.legacyAdmissionStatus(request) === 403) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n"); return;
      }
    } catch {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); return;
    }
    const actorAllowed = () => {
      try { return !actorService || actorService.legacyAdmissionStatus(request) === 204; }
      catch { return false; }
    };
    const actor = actorService?.authenticate(request);
    const ownerId = actor?.actorId ?? (principal ? JSON.stringify([principal.provider, principal.subject]) : submissionContext.sender ? `employee:${submissionContext.sender.loginName}` : "local-anonymous");
    submissionContext = { ...submissionContext, tokenUsageAuthority: () => {
      if (socket.destroyed || !actorAllowed() || (submissionContext.validUntil !== undefined && submissionContext.validUntil <= Date.now())) return null;
      const current = actorService?.usageAuthority(request);
      return current && current.actorId === actor?.actorId ? current : null;
    }, ...(actor ? {actorContext: actor} : {}), resourceOwner: {id: ownerId, assertCurrent() {
      if (socket.destroyed || !actorAllowed() || (actor && actorService.authenticate(request)?.actorId !== actor.actorId)
        || (submissionContext.validUntil !== undefined && submissionContext.validUntil <= Date.now())
        || (principal && !accessService.role(principal))) throw new Error("App resource authority revoked");
    }} };
    const admissionDeadline = Math.min(principal?.expiresAt ?? Infinity, submissionContext.validUntil ?? Infinity);
    const trackAdmittedWebSocket = (client, diagnostic) => {
      trackWebSocket(client, diagnostic);
      const retire = reason => {
        // A peer may ignore the close handshake. Stop delivery before destroying the wire.
        client.removeAllListeners('message'); client.close(1008, reason); client.terminate();
      };
      if (actorService) { const unwatch = actorService.watch(request, () => retire('Actor access revoked')); client.once('close', unwatch); }
      if (principal) { const unwatch = accessService.watch(principal, () => retire('Instance access revoked')); client.once('close', unwatch); }
      if (!Number.isFinite(admissionDeadline)) return;
      let timer;
      const expire = () => {
        const remaining = admissionDeadline - Date.now();
        if (remaining <= 0) { retire("Identity access expired"); return; }
        timer = setTimeout(expire, Math.min(remaining, 2_147_483_647)); timer.unref();
      };
      expire(); client.once("close", () => clearTimeout(timer));
    };
    if (pathname === '/__opencraft_browser/stream') {
      if (!remoteBrowserService || !(sameOrigin(request, true) || allowedInternalDesktopOrigin(request))) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
      }
      remoteBrowserService.upgrade(request, socket, head, { ownerId,
        authorize: () => submissionContext.resourceOwner.assertCurrent(),
        track: client => trackAdmittedWebSocket(client) });
      return;
    }
    const privateRejection = !privateConnection ? null : !sshManagement ? "management-unavailable"
      : !sshManagement.sameOrigin(request, true) ? "origin" : !sshManagement.authorized(request) ? "session" : null;
    if (privateRejection !== null) {
      logAppHost("upgrade-rejected", { reason: privateRejection, code: 403 });
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); return;
    }
    if (pathname === "/desktop/connect") {
      if (desktopService === null || url.search) { socket.destroy(); return; }
      const allowed = desktopAccess === "trusted-internal"
        ? allowedInternalDesktopOrigin(request) : sameOrigin(request, true);
      if (!allowed) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); return;
      }
      desktopWebSockets.handleUpgrade(request, socket, head, client => {
        trackAdmittedWebSocket(client);
        desktopService.accept(client);
      });
      return;
    }
    if ((pathname === "/apphost" || privateConnection) && appHostServer !== null) {
      websocketServer.handleUpgrade(request, socket, head, (client) => {
        trackAdmittedWebSocket(client, logAppHost);
        activeAppHostSockets.add(client);
        if (privateConnection) privateSockets.set(client, request);
        logAppHost("upgrade-accepted", { active: activeAppHostSockets.size });
        client.once("close", code => {
          activeAppHostSockets.delete(client);
          privateSockets.delete(client);
          logAppHost("closed", { code, active: activeAppHostSockets.size });
        });
        bridgeAppHostSocket(client, appHostServer, logAppHost, message => {
          // The anonymous channel cannot guess a remote ID. Private sockets
          // bind the server-validated cookie, never the renderer-supplied ID.
          if (!actorAllowed() || admissionDeadline <= Date.now() || (principal && !accessService.role(principal))) return false;
          if (privateConnection) return sshManagement.authorized(request);
          return !sshManagement || !message.hostId?.startsWith("ssh:");
        }, submissionContext);
      });
      return;
    }
    if (appHostConnection) logAppHost("upgrade-rejected", { reason: "unavailable", code: 404 });
    if (pathname !== "/appserver") {
      socket.destroy();
      return;
    }
    if (normalizedTarget === null) {
      socket.destroy();
      return;
    }
    let target = normalizedTarget;
    try {
      if (resolveAppServerTarget) target = normalizeTarget(await resolveAppServerTarget());
    } catch {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    if (socket.destroyed) return;
    if (!actorAllowed() || admissionDeadline <= Date.now() || (principal && !accessService.role(principal))) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    websocketServer.handleUpgrade(request, socket, head, (client) => {
      trackAdmittedWebSocket(client);
      bridgeAppServerSocket(client, request, {
        appServerTarget: target,
        mcpAppsService,
        hyperNodeUser,
        identity: appServerIdentity,
        createAppServerQuerySession,
        submissionContext,
        authorize: () => actorAllowed() && admissionDeadline > Date.now() && (!principal || !!accessService.role(principal)),
      });
    });
  });

  return {
    server,
    staticRoot,
    appServerTarget: normalizedTarget,
    listen({ host = "0.0.0.0", port = 10000 } = {}) {
      if (desktopService !== null && desktopAccess === "loopback" && host !== "127.0.0.1") return Promise.reject(new Error("Local desktop requires loopback"));
      return new Promise((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolvePromise(server.address());
        });
      });
    },
    close() {
      speechService?.close();
      remoteBrowserService?.close();
      unsubscribeRevocation?.();
      if (heartbeat !== null) clearInterval(heartbeat);
      for (const client of websocketServer.clients) client.terminate();
      for (const client of desktopWebSockets.clients) client.terminate();
      websocketServer.close();
      desktopWebSockets.close();
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
