#!/usr/bin/env node
import { selectAssetEncoding } from "./web-asset-encoding.mjs";
import { serveNotModified } from "./web-asset-cache.mjs";

import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { resourceRecoveryHtml, resourceRecoveryPath } from "./web-resource-recovery.mjs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket, { WebSocketServer } from "ws";
import { createHeadlessBackendProxy, isHeadlessBackendPath } from './web-deployment/headless-backend.mjs';

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

export function websiteDeploymentConfig({ appServerTarget, codexServerTarget }) {
  const hosts = [
    ...(appServerTarget ? [{ hostId: "local", label: "Server", kind: "remote-control", url: "/appserver" }] : []),
    ...(codexServerTarget ? [{ hostId: "local-codex", label: "Server", kind: "remote-control", url: "/codex-appserver" }] : []),
  ];
  // HyperNode uses the same primary proxy. Its user header is transport
  // configuration, not permission to register a second execution Host.
  return { hosts, builtinAgents: hosts.length > 0, hypernode: false };
}

export function injectWebsiteDeploymentConfig(html, config) {
  // Escape '<' so a deployment value can never close the inert JSON script.
  const json = JSON.stringify(config).replaceAll("<", "\\u003c");
  if (!/<head(?:\s[^>]*)?>/iu.test(html)) throw new Error("Website HTML has no head element");
  return html.replace(/<head(?:\s[^>]*)?>/iu, head => `${head}<script id="opencraft-deployment-config" type="application/json">${json}</script>`);
}

async function serveFile(request, response, path, pathname, deploymentConfig) {
  let metadata = await stat(path);
  let representation = path;
  if (isContentHashedAsset(pathname) && /\.(?:js|css|svg|json)$/.test(pathname)) {
    response.setHeader("vary", "Accept-Encoding");
    const selected = await selectAssetEncoding(path, request.headers["accept-encoding"]);
    if (selected === null) { response.statusCode = 406; response.end(); return true; }
    representation = selected.path;
    metadata = selected.metadata;
    if (selected.encoding) response.setHeader("content-encoding", selected.encoding);
  }
  if (!metadata.isFile()) return false;
  response.statusCode = 200;
  const html = pathname === "/" || pathname === "/index.html"
    ? resourceRecoveryHtml(injectWebsiteDeploymentConfig(await readFile(path, "utf8"), deploymentConfig), request.url || "/") : null;
  response.setHeader("content-length", html === null ? metadata.size : Buffer.byteLength(html));
  response.setHeader("content-type", contentTypes.get(extname(path).toLowerCase()) || "application/octet-stream");
  response.setHeader("x-content-type-options", "nosniff");
  if (html === null) response.setHeader("etag", `W/\"${metadata.size.toString(16)}-${Math.trunc(metadata.mtimeMs).toString(16)}\"`);
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
  if (html !== null) response.end(html);
  else createReadStream(representation).pipe(response);
  return true;
}

export async function createWorkbenchWebServer({
  root,
  appServerTarget = "ws://127.0.0.1:9988/rpc",
  hyperNodeUser = "",
  codexServerTarget = null,
  headlessServer = false,
  headlessBackendTarget = null,
  optionalResources = null,
  machineDisplayNames = null,
} = {}) {
  const staticRoot = await realpath(resolve(root || join(repositoryRoot, "apps/workbench-web/dist")));
  const normalizedTarget = appServerTarget === null ? null : normalizeTarget(appServerTarget);
  const normalizedCodexTarget = codexServerTarget === null ? null : normalizeTarget(codexServerTarget);
  const headlessBackend = createHeadlessBackendProxy(headlessBackendTarget);
  const deploymentConfig = headlessServer ? { hosts: [{ hostId: "opencraft-server", label: "Server", kind: "durable",
    executionLocation: "This server", url: "/appserver", workspaceBrowseRoots: ["/"] }], builtinAgents: true, hypernode: false } : websiteDeploymentConfig({
    appServerTarget: normalizedTarget, codexServerTarget: normalizedCodexTarget, hyperNodeUser,
  });
  if (machineDisplayNames !== null) {
    if (typeof machineDisplayNames !== 'object' || Array.isArray(machineDisplayNames)
      || Object.entries(machineDisplayNames).some(([id, name]) => !id || typeof name !== 'string' || !name.trim() || name.trim().length > 64 || /\p{Cc}/u.test(name))) throw new Error('Invalid machine display names');
    deploymentConfig.machineDisplayNames = Object.fromEntries(Object.entries(machineDisplayNames).map(([id, name]) => [id, name.trim()]));
  }
  const runtimeReports = [];

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://opencraft.invalid");
      if (url.pathname === "/__opencraft_health") {
        sendJson(response, 200, { ok: true, staticRoot, appServerTarget: normalizedTarget });
        return;
      }
      // A fixed launcher may predate new core routes. Its generic HTTP fallback
      // reaches this versioned worker; core still owns identity and authorization.
      // Keep worker health local so candidate readiness does not depend on execution startup.
      if (headlessBackend && isHeadlessBackendPath(url.pathname)) {
        headlessBackend.http(request, response, () => {});
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
      if (url.pathname === "/appserver" || url.pathname === "/codex-appserver") {
        if ((url.pathname === "/codex-appserver" ? normalizedCodexTarget : normalizedTarget) === null) {
          sendJson(response, 404, { ok: false, error: "AppServer proxy is not available in this host" });
          return;
        }
        response.setHeader("connection", "upgrade");
        sendJson(response, 426, { ok: false, error: "WebSocket upgrade required" });
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { ok: false, error: "GET or HEAD required" });
        return;
      }
      if (/\.map(?:\.(?:gz|br))?$/.test(url.pathname)) {
        sendJson(response, 404, { ok: false, error: "Source maps are not public" });
        return;
      }

      if (optionalResources && url.pathname.startsWith("/__opencraft_resources/")) {
        try {
          const id = url.pathname.slice("/__opencraft_resources/".length);
          const found = await optionalResources.prepare(id);
          sendJson(response, found ? 200 : 404, { ok: found });
        } catch { sendJson(response, 503, { ok: false, error: "Optional resources are unavailable; retry later" }); }
        return;
      }

      const resourcePath = resourceRecoveryPath(url.pathname);
      const requestedPath = resolveRequestPath(staticRoot, resourcePath);
      if (requestedPath == null) {
        sendJson(response, 400, { ok: false, error: "Invalid path" });
        return;
      }
      try {
        if (await serveFile(request, response, requestedPath, resourcePath, deploymentConfig)) return;
        if (extname(url.pathname) === "" && await serveFile(request, response, join(requestedPath, "index.html"), url.pathname, deploymentConfig)) return;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }

      if (optionalResources) {
        try {
          const optional = await optionalResources.resolveFile(resourcePath);
          if (optional && await serveFile(request, response, optional, resourcePath, deploymentConfig)) return;
        } catch { sendJson(response, 503, { ok: false, error: "Optional resources are unavailable; retry later" }); return; }
      }

      const acceptsHtml = (request.headers.accept || "").includes("text/html");
      if (
        acceptsHtml &&
        (extname(url.pathname) === "" || isWorkbenchApplicationRoute(url.pathname))
      ) {
        await serveFile(request, response, join(staticRoot, "index.html"), "/index.html", deploymentConfig);
        return;
      }
      sendJson(response, 404, { ok: false, error: "Not found" });
    } catch (error) {
      console.error("[opencraft static server]", error);
      if (!response.headersSent) sendJson(response, 500, { ok: false, error: "Internal server error" });
      else response.destroy(error);
    }
  });

  const websocketServer = new WebSocketServer({ noServer: true });
  const headlessTunnels = new Set();
  server.on("upgrade", (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url || "/", "http://opencraft.invalid").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (headlessBackend && isHeadlessBackendPath(pathname, true)) {
      headlessBackend.upgrade(request, socket, head, () => {}, headlessTunnels); return;
    }
    if (pathname !== "/appserver" && pathname !== "/codex-appserver") {
      socket.destroy();
      return;
    }
    const target = pathname === "/codex-appserver" ? normalizedCodexTarget : normalizedTarget;
    if (target === null) {
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (client) => {
      bridgeAppServerSocket(client, request, {
        appServerTarget: target,
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
      for (const socket of headlessTunnels) socket.destroy();
      for (const client of websocketServer.clients) client.terminate();
      websocketServer.close();
      return new Promise((resolvePromise, reject) => {
        server.close((error) => error ? reject(error) : resolvePromise());
      });
    },
  };
}
