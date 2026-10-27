/* OpenCraft Host Preview proxy. This worker owns routing only; credentials and
 * physical Host transports remain in the controlled Workbench page. */
const VERSION = 1;
const SERVER_BASE = (self.location.pathname || "").replace(/\/__opencraft\/opencraft-host-proxy-sw\.js$/, "");
const PREFIX = SERVER_BASE + "/__opencraft/host-proxy/v1/";
const INTERNAL_PREFIX = SERVER_BASE + "/__opencraft/";
const brokers = new Map();
const brokerWaiters = new Map();
const clientRoutes = new Map();
const requests = new Map();
let sequence = 0;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function isLoopback(url) {
  return url.protocol === "http:" && (
    url.hostname === "localhost"
    || url.hostname === "0.0.0.0"
    || url.hostname === "::1"
    || url.hostname === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
  );
}

function decodeRoute(input) {
  let url;
  try { url = new URL(input); } catch { return null; }
  if (!url.pathname.startsWith(PREFIX)) return null;
  const parts = url.pathname.slice(PREFIX.length).split("/");
  if (parts.length < 4 || parts[2] !== "http") return null;
  try {
    const brokerId = decodeURIComponent(parts[0]);
    const hostId = decodeURIComponent(parts[1]);
    const authority = decodeURIComponent(parts[3]);
    const targetUrl = new URL(`http://${authority}/${parts.slice(4).join("/")}${url.search}${url.hash}`);
    if (!brokerId || !hostId || !isLoopback(targetUrl)) return null;
    return {
      brokerId,
      hostId,
      targetUrl: targetUrl.href,
      targetOrigin: targetUrl.origin,
    };
  } catch { return null; }
}

function encodeTarget(route, target) {
  const url = new URL(target);
  if (!isLoopback(url)) return target;
  return `${self.location.origin}${PREFIX}${encodeURIComponent(route.brokerId)}`
    + `/${encodeURIComponent(route.hostId)}/http/${encodeURIComponent(url.host)}`
    + `${url.pathname}${url.search}${url.hash}`;
}

function routeForEvent(event) {
  const direct = decodeRoute(event.request.url);
  if (direct !== null) return { route: direct, direct: true };
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin || requestUrl.pathname.startsWith(INTERNAL_PREFIX)) return null;
  const mapped = clientRoutes.get(event.clientId);
  if (mapped !== undefined) return { route: mapped, direct: false };
  const referrer = decodeRoute(event.request.referrer);
  return referrer === null ? null : { route: referrer, direct: false };
}

function targetForRequest(match, requestUrl) {
  if (match.direct) return match.route.targetUrl;
  const url = new URL(requestUrl);
  return `${match.route.targetOrigin}${url.pathname}${url.search}`;
}

function safeRequestHeaders(request, targetUrl) {
  const allowed = new Set([
    "accept", "accept-language", "cache-control", "content-type", "if-match",
    "if-modified-since", "if-none-match", "if-range", "if-unmodified-since",
    "pragma", "range",
  ]);
  const headers = [];
  request.headers.forEach((value, name) => {
    if (allowed.has(name.toLowerCase())) headers.push([name, value]);
  });
  const target = new URL(targetUrl);
  headers.push(["origin", target.origin]);
  if (request.referrer) headers.push(["referer", targetUrl]);
  return headers;
}

function sanitizeResponseHeaders(entries, route, targetUrl) {
  const headers = new Headers(entries);
  for (const name of [
    "connection", "content-security-policy", "content-security-policy-report-only",
    "keep-alive", "proxy-authenticate", "proxy-authorization", "set-cookie",
    "te", "trailer", "transfer-encoding", "upgrade", "x-frame-options",
  ]) headers.delete(name);
  headers.delete("access-control-allow-credentials");
  headers.set("access-control-allow-origin", "*");
  headers.set("cross-origin-resource-policy", "cross-origin");
  const location = headers.get("location");
  if (location !== null) {
    try {
      const redirected = new URL(location, targetUrl);
      if (isLoopback(redirected)) headers.set("location", encodeTarget(route, redirected.href));
    } catch { /* Preserve malformed upstream Location for browser diagnostics. */ }
  }
  return headers;
}

function preflightResponse(request) {
  const requestedMethod = request.headers.get("access-control-request-method") || "GET";
  const requestedHeaders = request.headers.get("access-control-request-headers");
  const headers = new Headers({
    "access-control-allow-origin": "*",
    "access-control-allow-methods": requestedMethod,
    "access-control-max-age": "600",
    "cache-control": "no-store",
  });
  if (requestedHeaders) headers.set("access-control-allow-headers", requestedHeaders);
  return new Response(null, { status: 204, headers });
}

function rewriteText(text, route, targetUrl, contentType) {
  const target = new URL(targetUrl);
  const port = target.port ? `:${target.port}` : "";
  const pattern = new RegExp(
    `http:\\/\\/(?:localhost|0\\.0\\.0\\.0|127(?:\\.\\d{1,3}){3}|\\[::1\\])${port.replace(":", "\\:")}`,
    "gi",
  );
  let output = text.replace(pattern, (origin) => encodeTarget(route, `${origin}/`).replace(/\/$/, ""));
  if (contentType.includes("text/html") && !output.includes("/__opencraft/preview-bridge.js")) {
    const script = `<script src="${SERVER_BASE}/__opencraft/preview-bridge.js"></script>`;
    output = /<\/head\s*>/i.test(output)
      ? output.replace(/<\/head\s*>/i, `${script}</head>`)
      : `${script}${output}`;
  }
  return output;
}

function finishRequest(requestId) {
  const pending = requests.get(requestId);
  if (pending === undefined) return;
  clearTimeout(pending.timer);
  requests.delete(requestId);
}

function onBrokerMessage(message) {
  if (!message || message.version !== VERSION || typeof message.requestId !== "string") return;
  const pending = requests.get(message.requestId);
  if (pending === undefined) return;
  if (message.type === "opencraft-host-proxy:head") {
    pending.head = message;
    pending.resolveHead(message);
    return;
  }
  if (message.type === "opencraft-host-proxy:chunk" && message.body instanceof ArrayBuffer) {
    const chunk = new Uint8Array(message.body);
    if (pending.controller === null) pending.chunks.push(chunk);
    else pending.controller.enqueue(chunk);
    return;
  }
  if (message.type === "opencraft-host-proxy:end") {
    pending.ended = true;
    pending.controller?.close();
    pending.resolveDone();
    if (pending.streaming) finishRequest(message.requestId);
    return;
  }
  if (message.type === "opencraft-host-proxy:error") {
    const error = new Error(message.message || "Host proxy request failed");
    if (pending.head === null) pending.rejectHead(error);
    pending.controller?.error(error);
    pending.rejectDone(error);
    finishRequest(message.requestId);
  }
}

self.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type !== "opencraft-host-proxy:bind" || message.version !== VERSION
    || typeof message.brokerId !== "string" || event.ports.length !== 1) return;
  const port = event.ports[0];
  const previous = brokers.get(message.brokerId);
  previous?.close();
  brokers.set(message.brokerId, port);
  const waiters = brokerWaiters.get(message.brokerId);
  if (waiters !== undefined) {
    brokerWaiters.delete(message.brokerId);
    for (const resolve of waiters) resolve(port);
  }
  port.onmessage = (portEvent) => onBrokerMessage(portEvent.data);
  port.start();
});

async function requireBroker(brokerId) {
  const existing = brokers.get(brokerId);
  if (existing !== undefined) return existing;
  const rebound = new Promise((resolve) => {
    const waiters = brokerWaiters.get(brokerId) ?? new Set();
    waiters.add(resolve);
    brokerWaiters.set(brokerId, waiters);
    setTimeout(() => {
      waiters.delete(resolve);
      if (waiters.size === 0 && brokerWaiters.get(brokerId) === waiters) {
        brokerWaiters.delete(brokerId);
      }
      resolve(null);
    }, 1_500);
  });
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage({
      type: "opencraft-host-proxy:rebind-needed",
      version: VERSION,
      brokerId,
    });
  }
  return rebound;
}

async function proxyFetch(event, match) {
  const broker = await requireBroker(match.route.brokerId);
  if (broker === null) {
    return new Response("Host proxy broker is not connected. Reload the Workbench and try again.", { status: 503 });
  }
  if (event.resultingClientId) clientRoutes.set(event.resultingClientId, match.route);
  // On document navigations clientId can identify the initiator rather than
  // the destination. Never accidentally grant the Workbench shell a Host route.
  if (event.request.mode !== "navigate" && event.clientId) {
    clientRoutes.set(event.clientId, match.route);
  }
  const targetUrl = targetForRequest(match, event.request.url);
  // A root-relative document navigation temporarily leaves the canonical proxy
  // path. Redirect it back before fetching so address/history events can always
  // be decoded to their logical Host URL. Asset requests remain transparent.
  if (!match.direct && event.request.mode === "navigate") {
    return Response.redirect(encodeTarget(match.route, targetUrl), 307);
  }
  const requestId = `proxy-${Date.now().toString(36)}-${++sequence}`;
  let resolveHead;
  let rejectHead;
  let resolveDone;
  let rejectDone;
  const headPromise = new Promise((resolve, reject) => { resolveHead = resolve; rejectHead = reject; });
  const donePromise = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  // Text responses await completion explicitly; avoid an unhandled rejection
  // while the response head is still in flight.
  donePromise.catch(() => undefined);
  const pending = {
    chunks: [], controller: null, ended: false, head: null, streaming: false,
    resolveHead, rejectHead, resolveDone, rejectDone,
    timer: setTimeout(() => {
      const error = new Error("Timed out waiting for the Host proxy response");
      rejectHead(error);
      rejectDone(error);
      requests.delete(requestId);
      broker.postMessage({ type: "opencraft-host-proxy:cancel", version: VERSION, requestId });
    }, 30000),
  };
  requests.set(requestId, pending);
  const method = event.request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? null : await event.request.arrayBuffer();
  broker.postMessage({
    type: "opencraft-host-proxy:fetch", version: VERSION, requestId,
    hostId: match.route.hostId, targetUrl, method,
    headers: safeRequestHeaders(event.request, targetUrl), body,
  }, body === null ? [] : [body]);
  event.request.signal.addEventListener("abort", () => {
    broker.postMessage({ type: "opencraft-host-proxy:cancel", version: VERSION, requestId });
  }, { once: true });

  try {
    const head = await headPromise;
    const headers = sanitizeResponseHeaders(head.headers, match.route, targetUrl);
    if (method === "HEAD" || head.status === 204 || head.status === 205 || head.status === 304) {
      await donePromise;
      finishRequest(requestId);
      return new Response(null, { status: head.status, statusText: head.statusText, headers });
    }
    if (head.status === 101) {
      broker.postMessage({ type: "opencraft-host-proxy:cancel", version: VERSION, requestId });
      finishRequest(requestId);
      return new Response("WebSocket upgrades require a dedicated Host socket bridge", {
        status: 501,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
    const contentType = headers.get("content-type")?.toLowerCase() || "";
    const transformText = contentType.includes("text/html")
      || contentType.includes("text/css")
      || contentType.includes("javascript");
    if (transformText) {
      await donePromise;
      const size = pending.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of pending.chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      headers.delete("content-length");
      const text = rewriteText(new TextDecoder().decode(bytes), match.route, targetUrl, contentType);
      finishRequest(requestId);
      return new Response(text, { status: head.status, statusText: head.statusText, headers });
    }
    pending.streaming = true;
    const stream = new ReadableStream({
      start(controller) {
        pending.controller = controller;
        for (const chunk of pending.chunks.splice(0)) controller.enqueue(chunk);
        if (pending.ended) { controller.close(); finishRequest(requestId); }
      },
      cancel() {
        broker.postMessage({ type: "opencraft-host-proxy:cancel", version: VERSION, requestId });
        finishRequest(requestId);
      },
    });
    return new Response(stream, { status: head.status, statusText: head.statusText, headers });
  } catch (error) {
    finishRequest(requestId);
    return new Response(`Host proxy failed: ${error instanceof Error ? error.message : String(error)}`, {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
}

self.addEventListener("fetch", (event) => {
  const match = routeForEvent(event);
  if (match === null) return;
  if (event.request.method === "OPTIONS"
    && event.request.headers.has("access-control-request-method")) {
    event.respondWith(Promise.resolve(preflightResponse(event.request)));
    return;
  }
  event.respondWith(proxyFetch(event, match));
});
