#!/usr/bin/env node
import { observeNotificationRequest } from '@opencraft/web-push-node/diagnostics';
import { McpAppsRpcSession } from "@opencraft/mcp-apps/transport";
import { serveNotModified } from "./web-asset-cache.mjs";
import { selectAssetEncoding } from "./web-asset-encoding.mjs";
import { injectUserPluginBootstrap, loadUserPlugins, userPluginAsset } from './web-deployment/user-plugins.mjs';
import { createUserPluginCatalog } from './web-deployment/craft-plugins.mjs';
import { resourceRecoveryHtml, resourceRecoveryPath } from './web-resource-recovery.mjs';
import { HtmlFilePreviews } from "./html-file-previews.mjs";
import { APP_HOST_PROTOCOL_VERSION } from "@opencraft/app-host-protocol/version";
import { CHANNELS_HOST_ID } from "@opencraft/appserver-protocol/channels";

import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket, { WebSocketServer } from "ws";
import { createWebSocketSender } from "@opencraft/relay-protocol/websocket-sender";
import { RESUME_ACK_DELAY_MS, isAcknowledgement, isResumeAttempt, isSequence, parseResumeAttempt } from "@opencraft/app-host-resume";
import { ResumeRegistry, ResumeSessionCapacityError } from "@opencraft/app-host-resume/server";
import { trackSocketHeartbeat } from "./websocket-heartbeat.mjs";
import { appHostWebSocketOptions } from "./apphost-websocket-options.mjs";

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
  const accessSession = options.createAccessSession?.(options.submissionContext, frame => {
    if (client.readyState === WebSocket.OPEN && options.authorize?.() !== false) client.send(frame);
  });
  let outbound=Promise.resolve();
  const write = (frame, isBinary = false) => {
    if(accessSession?.prepare) {
      outbound=outbound.then(async()=>{
        if(client.readyState!==WebSocket.OPEN||options.authorize?.()===false)return;
        if(isBinary)throw new Error("Text frames required");
        await accessSession.prepare(String(frame));
        if(client.readyState!==WebSocket.OPEN||options.authorize?.()===false)return;
        const projected=accessSession.project(String(frame));
        if(projected!==null)client.send(projected,{binary:false});
      }).catch(()=>{client.close(1002,"Invalid RPC frame");});
      return;
    }
    if (client.readyState !== WebSocket.OPEN || options.authorize?.() === false) return;
    if (accessSession && isBinary) { client.close(1003, 'Text frames required'); return; }
    try {
      const projected = accessSession ? accessSession.project(String(frame)) : frame;
      if (projected !== null) client.send(projected, {binary:isBinary});
    } catch {
      // An invalid upstream packet cannot bypass policy or escape its socket owner.
      client.close(1002, 'Invalid RPC frame');
    }
  };
  client.once('close', () => accessSession?.close());
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
    write(frame);
  });
  const appSession = options.mcpAppsService ? new McpAppsRpcSession(options.mcpAppsService, frame => {
    write(frame);
  }) : null;
  const querySession = options.createAppServerQuerySession?.(frame => {
    write(frame);
  });
  const terminalSession = options.createTerminalSession?.(frame => {
    write(frame);
  });
  const terminalReady = terminalSession?.connect();
  const driverSession = options.createAppServerDriverSession?.(frame => write(frame));
  client.once('close', () => driverSession?.close());
  const dshPending = new Set();
  const dshPacket = frame => {try {const value=JSON.parse(String(frame));return value && typeof value === "object" ? value : null;}catch{return null;}};
  const dshKey = packet => JSON.stringify([packet.__opencraftClient ?? "",packet.id]);
  const forward = async (data, isBinary) => {
    if (options.authorize?.() === false) { client.close(1008, 'Instance access revoked'); return; }
    if (identitySession && isBinary) { client.close(1003, "Text frames only"); return; }
    try {
      // Register and authorize the request before a local terminal intercepts it.
      // Otherwise the policy owner cannot correlate its direct result and drops it.
      if (accessSession && isBinary) { client.close(1003,'Text frames required'); return; }
      if (accessSession && await accessSession.receive(data.toString('utf8'))) return;
      if (terminalSession) {
        if (isBinary) { client.close(1003, 'Text frames only'); return; }
        await terminalReady;
        if (clientClosed || options.authorize?.() === false) return;
        if (await terminalSession.receive(data.toString('utf8'), options.submissionContext)) return;
      }
      if(accessSession?.rewrite)data=accessSession.rewrite(data.toString('utf8'));
      if (!isBinary && driverSession) {
        const prepared = await driverSession.prepare(data.toString("utf8"), options.submissionContext);
        if (prepared === null) return;
        data = prepared;
      }
      if (!isBinary && await querySession?.receive(data.toString("utf8"), options.submissionContext)) return;
      if (clientClosed || options.authorize?.() === false) return;
      if (!isBinary && appSession?.receive(data.toString("utf8"), options.submissionContext)) return;
      const frame = identitySession ? await identitySession.prepareNative(data.toString("utf8"), options.submissionContext) : data;
      if (frame !== null) {
        if (!isBinary) { const packet = dshPacket(frame);if (packet && packet.id !== undefined && typeof packet.method === "string") dshPending.add(dshKey(packet));if(dshPending.size>4096)throw new Error("DSH consumer request limit"); }
        upstream.send(frame, { binary: isBinary });
      }
    } catch {
      client.close(1011, "Thread identity service unavailable"); upstream.close();
    }
  };
  let forwarding = Promise.resolve(), observing = Promise.resolve();
  let forwardingBytes=0, forwardingCount=0, observingBytes=0, observingCount=0;
  const enqueue = (data,isBinary) => {
    if (++forwardingCount>512 || (forwardingBytes+=data.length)>64*1024*1024) { client.close(1009,"AppServer forwarding queue limit exceeded"); return; }
    forwarding = forwarding.then(() => forward(data,isBinary)).finally(() => {forwardingCount--;forwardingBytes-=data.length;});
  };
  const pending = [];
  let pendingBytes = 0;
  let clientClosed = false;

  client.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      enqueue(data, isBinary);
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
      enqueue(message.data, message.isBinary);
    }
    pendingBytes = 0;
  });
  upstream.on("message", (data, isBinary) => {
    if (++observingCount>512 || (observingBytes+=data.length)>64*1024*1024) { client.close(1009,"AppServer observation queue limit exceeded"); upstream.close(); return; }
    observing = observing.then(async () => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (options.authorize?.() === false) { client.close(1008, 'Instance access revoked'); return; }
      try {
        if (identitySession && isBinary) throw new Error("Binary identity frame");
        // Identity restores rewritten request IDs before query initialization is correlated.
        const restored = identitySession ? await identitySession.observeNative(data.toString("utf8")) : data;
        const terminalFrame = restored !== null && !isBinary && terminalSession ? terminalSession.project(String(restored)) : restored;
        const driven = terminalFrame !== null && !isBinary && driverSession ? driverSession.project(String(terminalFrame)) : terminalFrame;
        const frame = driven !== null && !isBinary && querySession ? querySession.project(String(driven)) : driven;
        if (frame !== null) write(appSession && !isBinary ? appSession.project(String(frame), options.submissionContext) : frame, isBinary);
        if (!isBinary) {
          const packet = dshPacket(data), key = packet ? dshKey(packet) : null, proof = packet?.opencraftDshReceipt;
          if (proof && dshPending.has(key)) {
            if (typeof proof.id !== "string" || typeof proof.receipt !== "string") throw new Error("Invalid DSH receipt");
            upstream.send(JSON.stringify({jsonrpc:"2.0",method:"opencraft/owner/receipt",params:proof}));
          }
          if (packet && !packet.method && packet.id !== undefined) dshPending.delete(key);
        }
      } catch {
        client.close(1011, "Thread identity service unavailable"); upstream.close();
      }
    }).finally(() => {observingCount--;observingBytes-=data.length;});
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
    terminalSession?.close();
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
export const APP_HOST_HEARTBEAT_MS = 10_000;
const APP_HOST_HEARTBEAT_MAX_BUFFERED = 1024 * 1024;
const APP_HOST_HEARTBEAT_FRAME = JSON.stringify({ type: "connection/heartbeat" });

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
const appHostFailureKinds = new Set(["socket-error", "socket-close", "handshake-timeout", "probe-timeout", "liveness-timeout", "invalid-response"]);
const appHostPhases = new Set(["connecting", "socket-open", "ready"]);
const appHostDiagnosticNumbers = ["eventAtMs", "bufferedBytes", "lastMessageAgoMs", "probeElapsedMs", "lastProbeRttMs", "timeoutMs", "timerLateMs", "pagePauseMs", "pageResumeAgoMs", "pageHiddenForMs"];
const appHostDiagnosticKeys = new Set(["attemptId", "failure", "phase", "readyState", "ageMs", "closeCode", "visibility", "networkState", "wasClean", ...appHostDiagnosticNumbers]);

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
    && Number.isSafeInteger(report.ageMs) && report.ageMs >= 0
    && appHostDiagnosticNumbers.every(key => report[key] === undefined || (Number.isSafeInteger(report[key]) && report[key] >= 0))
    && (report.visibility === undefined || ["visible", "hidden"].includes(report.visibility))
    && (report.networkState === undefined || ["online", "offline", "unknown"].includes(report.networkState))
    && (report.wasClean === undefined || [0, 1].includes(report.wasClean))
    && (report.closeCode === undefined || (Number.isInteger(report.closeCode) && report.closeCode >= 0 && report.closeCode <= 4999));
}

// A socket that died abnormally may come back within the detach window.
// Normal closes, policy closes and server-initiated closes end the session.
const APP_HOST_DETACHABLE_CLOSE_CODES = new Set([1001, 1005, 1006]);

/**
 * App Host WebSocket bridge. With `resume` (registry, identity, route,
 * deadline) and a client that asks for it, the App Host connection outlives
 * its socket for a short window and frames are numbered so a reconnecting
 * client continues the same session. Without it, behavior is unchanged: the
 * connection ends with its socket.
 */
// Mark explicit application closures only. ws also calls close() internally to
// echo a peer's close frame; intercepting close() mistakes that echo for a
// server-initiated policy close and destroys sessions during route replacement.
const appHostServerClosedSockets = new WeakSet();
function closeAppHostSocket(client, ...args) {
  appHostServerClosedSockets.add(client);
  client.close(...args);
}

function bridgeAppHostSocket(client, appHostServer, logDiagnostic, authorize = () => true, submissionContext = { sender: null }, resume = null) {
  const wire = {
    client, send: createWebSocketSender(client), authorize, logDiagnostic, route: resume?.route ?? null,
    heartbeatRequested: false, heartbeatTimer: null,
    frameSequence: 0, probeSequence: 0, lastProbeObservedAt: -Infinity, probes: new Map(),
    session: null,
  };
  // A close the server initiated (revocation, expiry, policy) never leaves a resumable session,
  // even when terminate() makes the reported code look abnormal.
  const probeDetail = probe => ({ probeSequence: probe.sequence, eventAtMs: Date.now(),
    elapsedMs: Math.max(0, performance.now() - probe.started),
    readyState: wire.client.readyState, bufferedBytes: wire.client.bufferedAmount });
  const frameContext = () => ({ frameSequence: wire.frameSequence, phase: wire.session === null ? "awaiting-hello" : "ready" });
  const stopHeartbeat = () => { if (wire.heartbeatTimer !== null) clearInterval(wire.heartbeatTimer); wire.heartbeatTimer = null; };
  // Opt-in liveness: a client that asks for heartbeats judges the route by the
  // age of its last received frame instead of a slow, foreground-only probe.
  const startHeartbeat = () => {
    if (wire.heartbeatTimer !== null) return;
    wire.heartbeatTimer = setInterval(() => {
      if (wire.client.readyState !== WebSocket.OPEN) { stopHeartbeat(); return; }
      // A congested socket already proves nothing new; do not grow its queue.
      if (wire.client.bufferedAmount > APP_HOST_HEARTBEAT_MAX_BUFFERED) return;
      wire.send(APP_HOST_HEARTBEAT_FRAME);
    }, APP_HOST_HEARTBEAT_MS);
    wire.heartbeatTimer.unref?.();
  };
  const protocolError = (reason) => {
    logDiagnostic("invalid-frame", { code: 1008, ...frameContext(), reason });
    closeAppHostSocket(client, 1008, "Invalid App Host request");
    wire.session?.resumable?.end("protocol-error");
  };

  /** Shared state of one App Host connection; outlives sockets only when resumable. */
  const createSession = () => {
    const session = {
      wire: null, connection: null, listeners: new Set(), pendingConnects: new Set(),
      authorize, resumable: null, sequencing: false, heartbeat: false, ackTimer: null, route: resume?.route ?? null,
      port: null, authority: null,
    };
    const current = () => session.wire;
    session.port = {
      postMessage(message) {
        if (session.resumable?.isEnded) return;
        const active = current();
        if (!session.authorize(message)) {
          if (active) closeAppHostSocket(active.client, 1008, "Connection access expired");
          else session.resumable?.end("access-expired");
          return;
        }
        if (message?.type === "ready") {
          const capabilities = { ...message.capabilities };
          if (active?.heartbeatRequested) { capabilities.heartbeatMs = APP_HOST_HEARTBEAT_MS; session.heartbeat = true; }
          if (session.resumable) capabilities.resume = session.resumable.grant();
          message = { ...message, capabilities };
          if (session.heartbeat && active) active.startHeartbeat();
        }
        if (message?.type === "response" && session.pendingConnects.delete(message.requestId)) {
          active?.logDiagnostic("host-connect", { ok: message.ok === true });
        }
        let frame;
        if (session.sequencing) {
          // Numbered and retained (as UTF-8 bytes, off the V8 heap) until acknowledged.
          const link = session.resumable.link, seq = link.next();
          frame = JSON.stringify({ ...message, seq });
          const bytes = Buffer.byteLength(frame);
          link.retain(seq, bytes > link.maxBytes ? null : Buffer.from(frame), bytes);
        } else frame = JSON.stringify(message);
        if (message?.type === "ready" && session.resumable) session.sequencing = true;
        if (!active || active.client.readyState !== WebSocket.OPEN) return;
        const probe = message?.type === "response" ? active.probes.get(message.requestId) : undefined;
        if (probe) {
          active.probes.delete(message.requestId);
          const responseMs = Math.max(0, performance.now() - probe.started);
          active.logDiagnostic("probe-response", { ...active.probeDetail(probe), responseMs, ok: message.ok === true });
          active.send(frame, error => {
            // A completed local write does not acknowledge browser receipt.
            active.logDiagnostic("probe-written", { ...active.probeDetail(probe), responseMs, ok: !error });
          });
        } else active.send(frame);
      },
      subscribe(listener) {
        session.listeners.add(listener);
        return () => session.listeners.delete(listener);
      },
      start() {},
      close() {
        const active = current();
        if (active && active.client.readyState === WebSocket.OPEN) closeAppHostSocket(active.client, 1000, "App Host closed");
        session.resumable?.end("connection-closed");
      },
    };
    session.adoptAuthority = authority => {
      const old = session.authority;
      session.authority = authority;
      authority?.hold(reason => {
        const active = session.wire;
        if (active) { active.client.removeAllListeners('message'); closeAppHostSocket(active.client, 1008, reason); active.client.terminate(); }
        session.end(reason === "Identity access expired" ? "access-expired" : "access-revoked");
      });
      if (old !== authority) old?.release();
    };
    session.end = reason => {
      if (session.resumable) session.resumable.end(reason);
      else session.connection?.close();
    };
    session.scheduleAck = () => {
      const due = session.resumable?.link.acknowledgementDue;
      if (!due) return;
      const flush = () => {
        session.ackTimer = null;
        const active = current();
        if (!active || active.client.readyState !== WebSocket.OPEN || session.resumable.isEnded) return;
        active.send(JSON.stringify({ type: "connection/ack", received: session.resumable.link.acknowledged() }));
      };
      if (due === "now") { if (session.ackTimer !== null) clearTimeout(session.ackTimer); flush(); }
      else if (session.ackTimer === null) { session.ackTimer = setTimeout(flush, RESUME_ACK_DELAY_MS); session.ackTimer.unref?.(); }
    };
    return session;
  };
  wire.probeDetail = probeDetail;
  wire.startHeartbeat = startHeartbeat;

  const adopt = (session, attempt, heartbeatRequested) => {
    const replay = session.resumable.link.replay(attempt.received);
    if (replay === null) return false;
    const previous = session.wire;
    if (previous) { previous.session = null; previous.client.terminate(); }
    session.resumable.attach();
    session.wire = wire; wire.session = session;
    session.authorize = authorize;
    session.adoptAuthority(resume.authority);
    // Authority closures of the original upgrade follow the live socket and request.
    if (session.route && resume.route && session.route !== resume.route) Object.assign(session.route, resume.route);
    wire.heartbeatRequested = heartbeatRequested;
    wire.send(JSON.stringify({ type: "connection/resumed", received: session.resumable.link.received }));
    for (const frame of replay) wire.send(frame.data.toString("utf8"));
    if (session.heartbeat && heartbeatRequested) startHeartbeat();
    return replay.length;
  };

  client.on("message", (raw, isBinary) => {
    if (client.readyState !== WebSocket.OPEN || appHostServerClosedSockets.has(client)) return;
    wire.frameSequence += 1;
    if (isBinary) { logDiagnostic("invalid-frame", { code: 1003, reason: "binary", ...frameContext() }); closeAppHostSocket(client, 1003, "Text frames required"); return; }
    let message;
    try { message = JSON.parse(raw.toString()); }
    catch { logDiagnostic("invalid-frame", { code: 1003, reason: "json", ...frameContext() }); closeAppHostSocket(client, 1003, "Invalid App Host frame"); return; }
    const session = wire.session;
    if (session?.resumable?.isEnded) { closeAppHostSocket(client, 1000, "App Host session ended"); return; }
    if (message && typeof message === "object" && !Array.isArray(message)) {
      if (message.type === "connection/ack") {
        if (!session?.resumable || !isAcknowledgement(message.received) || !session.resumable.link.acknowledge(message.received)) protocolError("acknowledgement");
        return;
      }
      if (message.type === "connection/end") {
        if (session?.resumable) session.resumable.end("client-end");
        closeAppHostSocket(client, 1000, "App Host session ended");
        return;
      }
    }
    let seq;
    if (message && typeof message === "object" && "seq" in message) {
      if (!session?.sequencing || !isSequence(message.seq)) { protocolError("sequence"); return; }
      ({ seq, ...message } = message);
    }
    if (session && (message?.type === "hello" || (session.sequencing && seq === undefined))) {
      protocolError("sequence-required"); return;
    }
    const rejection = appHostFrameRejection(message);
    if (rejection !== null) {
      logDiagnostic("invalid-frame", { code: 1008, ...frameContext(), ...rejection });
      if (rejection.reason === "protocol-version" && client.readyState === WebSocket.OPEN) {
        wire.send(JSON.stringify({ type: "fatal", error: {
          code: "APP_HOST_PROTOCOL_MISMATCH",
          message: "Client and server versions are incompatible. Update or reload the client to reconnect.",
          retryable: false,
        } }), () => closeAppHostSocket(client, 1008, "Invalid App Host request"));
        return;
      }
      wire.session?.resumable?.end("protocol-error");
      closeAppHostSocket(client, 1008, "Invalid App Host request");
      return;
    }
    if (message.type === "connection/probe") {
      const started = performance.now();
      const sequence = ++wire.probeSequence;
      // Observe normal five-second probes, bounded even for a flooding peer.
      if (started - wire.lastProbeObservedAt >= 1000 && wire.probes.size < 8 && !wire.probes.has(message.requestId)) {
        wire.lastProbeObservedAt = started;
        const probe = { sequence, started };
        wire.probes.set(message.requestId, probe);
        logDiagnostic("probe-received", { ...probeDetail(probe), frameSequence: wire.frameSequence });
      }
    }
    if (seq !== undefined) {
      const arrival = wire.session.resumable.link.accept(seq, raw.length);
      if (arrival === "duplicate") return;
      if (arrival === "gap") { protocolError("sequence-gap"); return; }
      wire.session.scheduleAck();
    }
    if (!authorize(message)) {
      const probe = wire.probes.get(message.requestId);
      if (probe) {
        wire.probes.delete(message.requestId);
        logDiagnostic("probe-rejected", { ...probeDetail(probe), reason: "access" });
      }
      const denied = { type: "response", requestId: message.requestId, ok: false,
        error: submissionContext.actorContext?.credentialId
          ? { code: "CHANNEL_SCOPE_REQUIRED", message: "This credential can only access Channels", retryable: false }
          : { code: "SSH_ACCESS_REQUIRED", message: "Unlock remote connections in settings", retryable: false } };
      // A denied operation still occupies its valid transport sequence, but never
      // reaches Host dispatch. Reply through the same retained logical owner.
      if (wire.session) wire.session.port.postMessage(denied);
      else wire.send(JSON.stringify(denied));
      return;
    }
    if (wire.session === null) {
      if (message?.type !== "hello" || typeof message.rendererId !== "string" || !message.rendererId) {
        logDiagnostic("hello-required", { code: 1008, ...frameContext(), messageType: message.type });
        closeAppHostSocket(client, 1008, "App Host hello required");
        return;
      }
      const heartbeatRequested = message.heartbeat === true;
      const requested = resume && message.resume !== undefined ? parseResumeAttempt(message.resume) : null;
      if (requested && isResumeAttempt(requested)) {
        const found = resume.registry.find(requested, JSON.stringify([resume.identity, message.rendererId]));
        let reason = "failure" in found ? found.failure : null, replayed = 0;
        if (reason === null) {
          const adopted = adopt(found.session.payload, requested, heartbeatRequested);
          if (adopted === false) { reason = "gap"; found.session.end("gap"); }
          else replayed = adopted;
        }
        if (reason !== null) {
          logDiagnostic("resume-rejected", { reason });
          wire.send(JSON.stringify({ type: "connection/resume-failed", reason }), () => closeAppHostSocket(client, 1000, "App Host session not resumable"));
          return;
        }
        logDiagnostic("resume-accepted", { replayedFrames: replayed, ...resume.registry.stats });
        return;
      }
      const session = createSession();
      wire.session = session; session.wire = wire;
      wire.heartbeatRequested = heartbeatRequested;
      if (requested && resume) {
        try { session.resumable = resume.registry.create(JSON.stringify([resume.identity, message.rendererId]), session, reason => {
          if (session.ackTimer !== null) clearTimeout(session.ackTimer);
          session.ackTimer = null;
          session.authority?.release(); session.authority = null;
          try { session.connection?.close(); }
          finally { if (session.wire?.client.readyState === WebSocket.OPEN) closeAppHostSocket(session.wire.client, 1000, "App Host session ended"); }
          if (reason !== "connection-closed" && reason !== "client-end") logDiagnostic("resume-ended", { reason });
        }); } catch (error) {
          if (!(error instanceof ResumeSessionCapacityError)) { closeAppHostSocket(client, 1011, "App Host unavailable"); return; }
          // Resumption is optional: registry saturation cannot evict another owner or deny a fresh legacy connection.
          logDiagnostic("resume-unavailable", { reason: "capacity" });
        }
      }
      if (session.resumable) session.adoptAuthority(resume.authority);
      try { session.connection = appHostServer.accept(session.port, message.rendererId, submissionContext); }
      catch { logDiagnostic("hello-rejected", { code: 1011 }); session.resumable?.end("accept-failed"); closeAppHostSocket(client, 1011, "App Host unavailable"); return; }
      logDiagnostic("hello-accepted", { frameSequence: wire.frameSequence, receivedProtocolVersion: message.protocolVersion,
        ...(session.resumable ? { resumable: 1 } : {}) });
    }
    const active = wire.session;
    if (message.type === "host/connect") active.pendingConnects.add(message.requestId);
    for (const listener of active.listeners) listener(message);
  });
  client.once("close", code => {
    stopHeartbeat();
    for (const probe of wire.probes.values()) logDiagnostic("probe-abandoned", probeDetail(probe));
    wire.probes.clear();
    const session = wire.session;
    if (!session || session.wire !== wire) return;
    session.wire = null;
    if (session.resumable && !session.resumable.isEnded && session.sequencing && !appHostServerClosedSockets.has(client) && APP_HOST_DETACHABLE_CLOSE_CODES.has(code)) {
      session.resumable.detach(resume.deadline ?? Infinity);
      logDiagnostic("resume-detached", { code, ...resume.registry.stats });
      return;
    }
    session.end("socket-closed");
  });
  client.once("error", () => {
    // A resumable session decides on the following close; others end now.
    const session = wire.session;
    if (session && session.wire === wire && !session.resumable) session.connection?.close();
  });
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

async function serveFile(request, response, path, pathname, instanceId = null, assetVersion = null, userPlugins = null, browserBackend = null) {
  let metadata = await stat(path);
  if (!metadata.isFile()) return false;
  let selectedPath = path;
  let encoding = null;
  if (isContentHashedAsset(pathname)) {
    response.setHeader("vary", "Accept-Encoding");
    const selected = await selectAssetEncoding(path, request.headers["accept-encoding"]);
    if (!selected) {
      response.statusCode = 406;
      response.setHeader("cache-control", "no-store");
      response.end();
      return true;
    }
    ({ metadata, encoding, path: selectedPath } = selected);
    if (encoding) response.setHeader("content-encoding", encoding);
  }
  response.statusCode = 200;
  const shell = pathname === '/' || pathname === '/index.html';
  let html = extname(path) === '.html' ? await readFile(path, 'utf8') : null;
  if (html !== null && shell && userPlugins?.length) html = injectUserPluginBootstrap(html,userPlugins);
  if (html !== null && shell && browserBackend !== null) html = html.replace(/<head(?:\s[^>]*)?>/iu,
    head => head + '<meta name="opencraft-browser-backend" content="' + (browserBackend ? 'remote' : 'iframe') + '">');
  if (html !== null) {
    if (instanceId) html = html.replace(/<head(?:\s[^>]*)?>/iu,
      head => `${head}<script id="opencraft-instance-id" type="application/json">${JSON.stringify(instanceId)}</script>`);
    const url = new URL(request.url || '/', 'http://localhost');
    if (assetVersion && !url.searchParams.has('opencraft-resource-recovery')) url.searchParams.set('opencraft-resource-recovery', createHash('sha256').update(assetVersion).digest('hex').slice(0, 24));
    html = resourceRecoveryHtml(html, url.href);
  }
  response.setHeader("content-length", html === null ? metadata.size : Buffer.byteLength(html));
  response.setHeader("content-type", contentTypes.get(extname(path).toLowerCase()) || "application/octet-stream");
  response.setHeader("x-content-type-options", "nosniff");
  if (html === null) response.setHeader("etag", `W/\"${metadata.size.toString(16)}-${Math.trunc(metadata.mtimeMs).toString(16)}-${encoding ?? "identity"}\"`);
  if (pathname === "/" || pathname === "/index.html" || pathname === "/version.json") {
    response.setHeader("cache-control", "no-store, max-age=0");
  } else if (isContentHashedAsset(pathname)) {
    response.setHeader("cache-control", "public, max-age=31536000, immutable");
  } else {
    response.setHeader("cache-control", "no-cache");
  }
  if (html === null && serveNotModified(request, response)) return true;
  if (request.method === "HEAD") {
    response.end();
    return true;
  }
  if (html !== null) response.end(html);
  else createReadStream(selectedPath).pipe(response);
  return true;
}

export async function createWorkbenchWebServer({
  root,
  userPluginDirectory = null,
  productPluginAssets = null,
  instanceId = null,
  assetVersion = null,
  appServerTarget = "ws://127.0.0.1:9988/rpc",
  resolveAppServerTarget,
  appServerIdentity = null,
  createAppServerQuerySession = null,
  createTerminalSession = null,
  createAppServerDriverSession = null,
  hyperNodeUser = "",
  loopbackOnly = false,
  appHostServer = null,
  appHostResumeEnabled = process.env.OPENCRAFT_APPHOST_RESUME !== "0",
  appHostResumeOptions = {},
  sshServerDescriptors = [],
  sshManagement = null,
  fileDownloads = null,
  getStorageOutcomes,
  getPluginHealth,
  getExecutionHealth,
  getHostReadiness,
  desktopService = null,
  desktopAccess = "loopback",
  speechService = null,
  remoteBrowserService = null,
  /** @type {import('@opencraft/app-host-server').WorkbenchRequestIdentity | null} */
  modelPolicyService = null,
  identityService = null,
  localAccess = null,
  accessService = null,
  actorService = null,
  allowSessionChannels = false,
  createAppServerAccessSession = null,
  actorCollaborationService = null,
  turnPushService = null,
  serverInformationService = null,
  authService = null,
  accountService = null,
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
  if (instanceId !== null && (typeof instanceId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(instanceId))) throw new Error('Invalid instance storage identity');
  if (assetVersion !== null && (typeof assetVersion !== 'string' || !assetVersion || assetVersion.length > 128)) throw new Error('Invalid asset version');
  if (identityService !== null && (!identityService || ["admissionStatus", "connectionContext", "handle"].some(method => typeof identityService[method] !== "function"))) throw new Error("Invalid request identity service");
  if (!["loopback", "trusted-internal"].includes(desktopAccess)) throw new Error("Invalid desktop access policy");
  if (desktopService !== null && desktopAccess === "loopback" && !loopbackOnly) throw new Error("Local desktop requires a loopback-only gateway");
  const staticRoot = await realpath(resolve(root || join(repositoryRoot, "apps/workbench-web/dist")));
  const userPluginCatalog = userPluginDirectory ? await createUserPluginCatalog(userPluginDirectory, loadUserPlugins) : null;
  if (sshServerDescriptors.length && !loopbackOnly && !sshManagement?.options.publicAccess) throw new Error("SSH Server catalog requires a protected listener");
  const normalizedTarget = appServerTarget === null ? null : normalizeTarget(appServerTarget);
  const sameOrigin = (request, requireOrigin) => {
    const localOrigin = localAccess?.origin(request);
    return (!!localOrigin && (!requireOrigin || request.headers.origin === localOrigin))
      || allowedSameOriginRequest(request, requireOrigin, true)
      || (!!accessService?.trustedOrigin(request) && (request.headers.origin === accessService.trustedOrigin(request) || (!requireOrigin && request.headers.origin === undefined)));
  };
  const runtimeReports = [];
  const htmlPreviews = typeof fileDownloads?.readPreview === 'function'
    ? new HtmlFilePreviews((...args) => fileDownloads.readPreview(...args)) : null;
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

  let closing = false;
  const pendingRequests = new Set();
  const trackRequest = handler => (...args) => {
    const operation = Promise.resolve().then(() => handler(...args));
    pendingRequests.add(operation);
    void operation.then(() => pendingRequests.delete(operation), () => {
      pendingRequests.delete(operation); args[1]?.destroy?.();
    });
  };
  const server = createServer(trackRequest(async (request, response) => {
    observeNotificationRequest(request, response);
    if (closing) { response.writeHead(503, {connection:'close'}); response.end('{}'); return; }
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
      const url = new URL(request.url || "/", "http://opencraft.invalid");
      // The configured transport verifies provider signatures independently of browser origin.
      if (url.pathname.startsWith('/__opencraft_im/')
        && await getImService()?.handleChannelCallback?.(request, response, url.pathname)) return;
      if (loopbackOnly && !sameOrigin(request, false)) {
        sendJson(response, 403, { ok: false, error: "Matching origin required" });
        return;
      }
      const local = !!localAccess?.origin(request);
      // These capabilities only reach a frozen report, never installation APIs.
      if (htmlPreviews && await htmlPreviews.handlePublic(request, response, sameOrigin)) return;
      if (!local && !["/health", "/__opencraft_health"].includes(url.pathname)) await accessService?.prepare?.(request);
      // Login/callback endpoints must remain reachable before instance admission.
      if (url.pathname === '/setup' || url.pathname === '/__opencraft_account' || url.pathname.startsWith('/__opencraft_account/')) {
        if (accountService && await accountService.handle(request, response)) return;
        sendJson(response, 404, { error: 'missing' }); return;
      }
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
      if (url.pathname === '/__opencraft_server_information') {
        if (serverInformationService && await serverInformationService(request, response)) return;
        sendJson(response, 404, { error: 'missing' }); return;
      }
      if ((url.pathname === '/__opencraft_push' || url.pathname === '/__opencraft_notifications')) {
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
      if (url.pathname === "/__opencraft_files" || url.pathname === "/__opencraft_preview/tickets") {
        if (!fileDownloads) { sendJson(response, 404, { error: "missing" }); return; }
        const authorizeFile = hostId => {
          try {
            return sameOrigin(request, false)
              && (!hostId.startsWith("ssh:") || sshManagement?.authorized(request) === true)
              && (local || (!authService?.invalidSession(request)
                && (accessService?.admissionStatus(request) ?? identityService?.admissionStatus(request) ?? 204) === 204))
              && (!actorService || actorService.legacyAdmissionStatus(request) === 204);
          } catch { return false; }
        };
        if (url.pathname === "/__opencraft_preview/tickets") {
          if (!htmlPreviews) { sendJson(response,404,{error:'missing'}); return; }
          if (!sameOrigin(request,true)) { sendJson(response,403,{error:'same_origin_required'}); return; }
          await htmlPreviews.issue(request,response,authorizeFile);
        } else await fileDownloads.handle(request, response, authorizeFile);
        return;
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
      if (modelPolicyService && await modelPolicyService(request, response)) return;
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
          const hosts=getHostReadiness?.()??{};
          const ok=health.ok===true && Object.values(hosts).every(host=>host.state==='ready');
          sendJson(response, ok ? 200 : 503, { ...health, ok, storage: getStorageOutcomes?.() ?? [], ...(getPluginHealth ? {plugins:getPluginHealth()} : {}), ...(getHostReadiness ? { hosts: getHostReadiness() } : {}) });
        } catch { sendJson(response, 503, { ok: false }); }
        return;
      }
      if (url.pathname === "/__opencraft_health") {
        const hosts=getHostReadiness?.()??{};
        const ok=Object.values(hosts).every(host=>host.state==='ready');
        sendJson(response, ok ? 200 : 503, { ok, appServerConfigured: normalizedTarget !== null, ...(getPluginHealth ? {plugins:getPluginHealth()} : {}), ...(getHostReadiness ? { hosts: getHostReadiness() } : {}), ...(getStorageOutcomes ? { storage: getStorageOutcomes() } : {}) });
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
        // The closed validator above permits only local transport metadata.
        emitAppHostDiagnostic({ event: "client-failure", ...report });
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
      const refreshPlugins = url.pathname === '/__opencraft_plugin_catalog' || url.pathname === '/' || url.pathname === '/index.html'
        || (request.headers.accept || '').includes('text/html');
      const pluginSnapshot = userPluginCatalog ? (refreshPlugins ? await userPluginCatalog.refresh() : userPluginCatalog.getSnapshot()) : null;
      const userPlugins = pluginSnapshot?.plugins ?? null;
      if (url.pathname === '/__opencraft_plugin_catalog') {
        if (!['GET', 'HEAD'].includes(request.method)) { sendJson(response, 405, { error: 'GET or HEAD required' }); return; }
        response.setHeader('cache-control', 'no-store');
        sendJson(response, 200, { plugins: userPlugins ?? [], errors: pluginSnapshot?.errors ?? [] }); return;
      }
      if (userPlugins?.length && url.pathname.startsWith('/__opencraft_plugins/')) {
        if (!['GET', 'HEAD'].includes(request.method)) { sendJson(response, 405, { error: 'GET or HEAD required' }); return; }
        try {
          const relative = decodeURIComponent(url.pathname.slice('/__opencraft_plugins/'.length));
          if (!userPlugins.some(plugin => plugin.manifest.id === relative.split('/')[0])) throw new Error('Unknown plugin');
          const asset = await userPluginAsset(userPluginDirectory, relative);
          await serveFile(request, response, asset, url.pathname); return;
        } catch { sendJson(response, 404, { error: 'User plugin asset not found' }); return; }
      }
      if (url.pathname.startsWith("/__opencraft_")
        && !(productPluginAssets && url.pathname.startsWith('/__opencraft_product_plugins/'))) {
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

      if (url.pathname.startsWith('/__opencraft_product_plugins/') && productPluginAssets && !productPluginAssets.has(url.pathname.slice(1))) {
        sendJson(response, 404, { ok: false, error: 'Product plugin asset not found' }); return;
      }

      const resourcePath = resourceRecoveryPath(url.pathname);
      const requestedPath = resolveRequestPath(staticRoot, resourcePath);
      if (requestedPath == null) {
        sendJson(response, 400, { ok: false, error: "Invalid path" });
        return;
      }
      try {
        if (await serveFile(request, response, requestedPath, resourcePath, instanceId, assetVersion, userPlugins, !!remoteBrowserService)) return;
        // Product-owned standalone documents can share the static origin without
        // booting the Workbench SPA. Admission and reserved API routing stay above.
        if (extname(url.pathname) === "" && await serveFile(request, response, join(requestedPath, "index.html"), url.pathname, instanceId, assetVersion)) return;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }

      // Keep current static assets first. Retained plugin snapshots
      // supply exclusive code and dependencies needed by older browser tabs.
      if (productPluginAssets?.has(url.pathname.slice(1))) {
        const asset = await productPluginAssets.resolve(url.pathname.slice(1));
        if (await serveFile(request, response, asset, url.pathname)) return;
      }

      const acceptsHtml = (request.headers.accept || "").includes("text/html");
      if (
        acceptsHtml &&
        (extname(url.pathname) === "" || isWorkbenchApplicationRoute(url.pathname))
      ) {
        await serveFile(request, response, join(staticRoot, "index.html"), "/index.html", instanceId, assetVersion, userPlugins, !!remoteBrowserService);
        return;
      }
      sendJson(response, 404, { ok: false, error: "Not found" });
    } catch (error) {
      console.error("[opencraft static server]", error);
      if (!response.headersSent) sendJson(response, 500, { ok: false, error: "Internal server error" });
      else response.destroy(error);
    }
  }));

  // A supported 32 MiB attachment expands to ~43 MiB in Base64, then travels
  // inside JSON-RPC and (for Codex) an AppHost envelope. Keep a bounded 48 MiB
  // message limit so valid files do not disconnect the shared Host transport.
  const websocketServer = new WebSocketServer(appHostWebSocketOptions());
  const desktopWebSockets = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  const activeAppHostSockets = new Set();
  const appHostResume = appHostServer !== null && appHostResumeEnabled ? new ResumeRegistry(appHostResumeOptions) : null;
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
  server.on("upgrade", trackRequest(async (request, socket, head) => {
    if (closing) { socket.destroy(); return; }
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
    const sessionRequest = actorService?.isSessionRequest(request);
    let admissionStatus, submissionContext, principal, channelSession, localAdmission = false;
    try {
      if (sessionRequest) {
        channelSession = allowSessionChannels && pathname === '/apphost' && appHostServer !== null ? actorService.lease(request) : null;
        if (!channelSession?.context.credentialId) {
          socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n"); return;
        }
        admissionStatus = 204;
        submissionContext = { sender: null, validUntil: channelSession.context.expiresAt };
      } else {
        const local = !!localAccess?.origin(request);
        localAdmission = local;
        if (!local) await accessService?.prepare?.(request);
        admissionStatus = local ? 204 : authService?.invalidSession(request) ? 401 : accessService?.admissionStatus(request) ?? identityService?.admissionStatus(request) ?? 204;
        submissionContext = local ? { sender: null } : identityService ? identityService.connectionContext(request) : { sender: null };
        principal = local ? null : accessService?.authenticate(request);
        if (principal && submissionContext) {
          const claimed = submissionContext.executionPrincipal;
          if (claimed && (claimed.provider !== principal.provider || claimed.subject !== principal.subject)) throw new Error("Conflicting execution principal");
          submissionContext = { ...submissionContext,
            executionPrincipal: { provider: principal.provider, subject: principal.subject,
              ...(submissionContext.sender ? { loginName: submissionContext.sender.loginName } : {}) },
            validUntil: Math.min(submissionContext.validUntil ?? Infinity, principal.expiresAt) };
        }
      }
      if (submissionContext !== null && (typeof submissionContext !== 'object'
        || (submissionContext.validUntil !== undefined && !Number.isFinite(submissionContext.validUntil)))) throw new Error("Invalid connection identity context");
    } catch {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); return;
    }
    if (closing) { socket.destroy(); return; }
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
    // Authority checks read the live route: a resumed App Host session moves to
    // the new socket and request (same identity), so its closures follow them.
    const route = { socket, request, channelSession, principal };
    const actorAllowed = () => {
      try { return route.channelSession ? route.channelSession.isCurrent() : !actorService || actorService.legacyAdmissionStatus(route.request) === 204; }
      catch { return false; }
    };
    const actor = channelSession?.context ?? actorService?.authenticate(request);
    const ownerId = actor?.actorId ?? (principal ? JSON.stringify([principal.provider, principal.subject]) : submissionContext.sender ? `employee:${submissionContext.sender.loginName}` : "local-anonymous");
    submissionContext = { ...submissionContext, tokenUsageAuthority: () => {
      if (route.socket.destroyed || !actorAllowed() || (submissionContext.validUntil !== undefined && submissionContext.validUntil <= Date.now())) return null;
      const current = actorService?.usageAuthority(route.request);
      return current && current.actorId === actor?.actorId ? current : null;
    }, ...(actor ? {actorContext: actor} : {}), resourceOwner: {id: ownerId, assertCurrent() {
      if (route.socket.destroyed || !actorAllowed() || (actor && actorService.authenticate(route.request)?.actorId !== actor.actorId)
        || (submissionContext.validUntil !== undefined && submissionContext.validUntil <= Date.now())
        || (route.principal && !accessService.role(route.principal))) throw new Error("App resource authority revoked");
    }} };
    const admissionDeadline = Math.min(principal?.expiresAt ?? Infinity, submissionContext.validUntil ?? Infinity);
    const trackAdmittedWebSocket = (client, diagnostic) => {
      trackWebSocket(client, diagnostic);
      const cleanups = [];
      let active = true, retained = false, timer;
      const physicalRetire = reason => {
        client.removeAllListeners('message'); closeAppHostSocket(client, 1008, reason); client.terminate();
      };
      let retireOwner = physicalRetire;
      const authority = {
        hold(retire) { if (!active) return false; retained = true; retireOwner = retire; return true; },
        release() {
          if (!active) return;
          // Fence callbacks before invoking external disposers; old request watches cannot retire a successor.
          active = false; clearTimeout(timer);
          for (const cleanup of cleanups.splice(0)) { try { cleanup(); } catch { emitAppHostDiagnostic({ event: "authority-cleanup-failed" }); } }
        },
      };
      const retire = reason => { if (active) retireOwner(reason); };
      if (actorService) cleanups.push(actorService.watch(request, () => retire('Actor access revoked')));
      if (principal) cleanups.push(accessService.watch(principal, () => retire('Instance access revoked')));
      if (privateConnection && sshManagement?.onRevocation) cleanups.push(sshManagement.onRevocation(() => {
        if (!sshManagement.authorized(request)) retire('Connection access expired');
      }));
      if (Number.isFinite(admissionDeadline)) {
        const expire = () => {
          const remaining = admissionDeadline - Date.now();
          if (remaining <= 0) { retire("Identity access expired"); return; }
          timer = setTimeout(expire, Math.min(remaining, 2_147_483_647)); timer.unref();
        };
        expire();
      }
      // The bridge's close handler decides whether the physical loss is detachable.
      client.once('close', () => queueMicrotask(() => { if (!retained) authority.release(); }));
      return authority;
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
        if(!sessionRequest)turnPushService?.initializeDefaultsForRequest?.(request);
        const authority = trackAdmittedWebSocket(client, logAppHost);
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
          if (closing || !actorAllowed() || admissionDeadline <= Date.now() || (principal && !accessService.role(principal))) return false;
          if (channelSession) return message.hostId === undefined || message.hostId === CHANNELS_HOST_ID;
          if (privateConnection) return sshManagement.authorized(request);
          return !sshManagement || !message.hostId?.startsWith("ssh:");
        }, submissionContext, appHostResume === null ? null : {
          registry: appHostResume,
          // Exact route, Actor, credential and execution identity; no renderer authority.
          identity: JSON.stringify([pathname, ownerId, actor ?? null,
            channelSession?.context.credentialId ?? null, submissionContext.executionPrincipal ?? null,
            submissionContext.sender ?? null, submissionContext.validUntil ?? null, localAdmission]),
          route, authority, deadline: admissionDeadline,
        });
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
    if (closing || socket.destroyed) { socket.destroy(); return; }
    if (closing || !actorAllowed() || admissionDeadline <= Date.now() || (principal && !accessService.role(principal))) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    websocketServer.handleUpgrade(request, socket, head, (client) => {
      if(!sessionRequest)turnPushService?.initializeDefaultsForRequest?.(request);
      trackAdmittedWebSocket(client);
      bridgeAppServerSocket(client, request, {
        appServerTarget: target,
        mcpAppsService,
        hyperNodeUser,
        identity: appServerIdentity,
        createAppServerQuerySession,
        createTerminalSession,
        createAppServerDriverSession,
        createAccessSession: createAppServerAccessSession,
        submissionContext,
        authorize: () => actorAllowed() && admissionDeadline > Date.now() && (!principal || !!accessService.role(principal)),
      });
    });
  }));

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
    close(update = null, retireIngress = () => undefined) {
      htmlPreviews?.close();
      closing = true;
      speechService?.close();
      remoteBrowserService?.close();
      unsubscribeRevocation?.();
      if (heartbeat !== null) clearInterval(heartbeat);
      const disconnected = [...websocketServer.clients].filter(client => client.readyState === WebSocket.OPEN).length;
      const receipt = observability?.gatewayShutdown?.(disconnected, update)?.catch(() => {});
      const clients = [...websocketServer.clients];
      const clientClosures = clients.map(client => new Promise(done => {
        if (client.readyState === WebSocket.CLOSED) { done(); return; }
        client.once('close',done);
        if (update && client.readyState === WebSocket.OPEN) client.close(1012);
        else client.terminate();
      }));
      appHostResume?.close();
      let deadline;
      const closeClients = Promise.race([Promise.allSettled(clientClosures),new Promise(done => {deadline=setTimeout(done,250);})])
        .finally(()=>{clearTimeout(deadline);for(const client of clients)if(client.readyState!==WebSocket.CLOSED)client.terminate();});
      // Carrier sockets must outlive the restart close frame. Conversely,
      // externally owned Hub upgrades must retire before HTTP close can finish.
      const ingressClosed = closeClients.then(retireIngress);
      const requestsClosed = ingressClosed.then(() => Promise.allSettled([...pendingRequests]));
      for (const client of desktopWebSockets.clients) client.terminate();
      websocketServer.close();
      desktopWebSockets.close();
      return Promise.all([receipt, requestsClosed, new Promise((resolvePromise, reject) => {
        server.close((error) => error ? reject(error) : resolvePromise());
      })]).then(() => undefined);
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
