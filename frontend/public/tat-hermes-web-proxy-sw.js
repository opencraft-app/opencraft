const PROXY_PREFIX = "/__tat_hermes_proxy/";
const FILE_DOWNLOAD_PREFIX = "/__tat_file_download/";
const SERVICE_WORKER_VERSION = "tat-file-download-v6";
const REQUEST_TIMEOUT_MS = 45_000;
const PROXY_ACCEPT_TIMEOUT_MS = 1500;
const PROXY_CHUNK_TIMEOUT_MS = 60_000;
const FILE_CHUNK_TIMEOUT_MS = 60_000;
const BROKER_REGISTRY_TTL_MS = 5 * 60 * 1000;
const brokerRegistry = new Map();

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (event.data?.type === "PING_TAT_FILE_DOWNLOAD") {
    event.ports[0]?.postMessage({
      type: "TAT_FILE_DOWNLOAD_READY",
      version: SERVICE_WORKER_VERSION,
    });
    return;
  }
  if (event.data?.type === "tat-hermes-proxy-broker-register" && typeof event.data.botId === "string") {
    registerBroker(event.data.botId, event.source?.id);
    return;
  }
  if (event.data?.type === "tat-hermes-proxy-broker-unregister" && typeof event.data.botId === "string") {
    unregisterBroker(event.data.botId, event.source?.id);
  }
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith(FILE_DOWNLOAD_PREFIX)) {
    event.respondWith(handleFileDownloadFetch(event.request, event.clientId));
    return;
  }
  if (!url.pathname.startsWith(PROXY_PREFIX)) {
    return;
  }
  event.respondWith(handleProxyFetch(event.request, event.clientId));
});

const parseFileDownloadRequest = (request) => {
  const url = new URL(request.url);
  const botId = decodeURIComponent(url.pathname.slice(FILE_DOWNLOAD_PREFIX.length));
  const path = url.searchParams.get("path") || "/";
  const fallbackName = path.split("/").filter(Boolean).at(-1) || "download";
  const name = url.searchParams.get("name") || fallbackName;
  return { botId, path, name };
};

const encodeContentDispositionFilename = (name) => {
  const fallback = String(name).replace(/[^\x20-\x7E]+/g, "_").replace(/["\\]/g, "_") || "download";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};

const makeFileDownloadHeaders = ({ name }) =>
  new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Disposition": encodeContentDispositionFilename(name),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-LightVela-TAT-File-Download": "1",
  });

const fileDownloadErrorResponse = (status, detail) =>
  new Response(detail, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });

const candidateClientsForDownload = async (clientId) => {
  const clients = [];
  if (clientId) {
    const current = await self.clients.get(clientId);
    if (current) {
      clients.push(current);
    }
  }
  const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of allClients) {
    if (!clients.some((candidate) => candidate.id === client.id)) {
      clients.push(client);
    }
  }
  return clients;
};

const handleFileDownloadFetch = async (request, clientId) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return fileDownloadErrorResponse(405, "TAT file download only supports GET and HEAD.");
  }

  const fileRequest = parseFileDownloadRequest(request);
  if (!fileRequest.botId || !fileRequest.path) {
    return fileDownloadErrorResponse(400, "Missing bot id or file path.");
  }

  const headers = makeFileDownloadHeaders(fileRequest);
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  const clients = await candidateClientsForDownload(clientId);
  if (clients.length === 0) {
    return fileDownloadErrorResponse(503, "No LightVela page is available to bridge this TAT file download.");
  }

  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const startFileDownloadFromClient = (client, controller) =>
    new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      let port = channel.port1;
      let settled = false;
      let accepted = false;
      let timer = null;

      const clearTimer = () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      };

      const fail = (error) => {
        if (!settled) {
          settled = true;
          clearTimer();
          port?.close();
          reject(error);
        }
      };

      const resetTimer = () => {
        clearTimer();
        timer = setTimeout(() => {
          fail(new Error("TAT file download timed out"));
        }, accepted ? FILE_CHUNK_TIMEOUT_MS : 1500);
      };

      port.onmessage = (event) => {
        const message = event.data || {};
        if (message.requestId !== requestId) {
          return;
        }
        if (message.type === "tat-file-download-accepted") {
          accepted = true;
          resetTimer();
          resolve({ cancel: () => {
            port?.postMessage({ type: "tat-file-download-cancel", requestId });
            port?.close();
          } });
          return;
        }
        if (message.type === "tat-file-download-chunk") {
          accepted = true;
          resetTimer();
          const chunk = message.chunk instanceof ArrayBuffer ? new Uint8Array(message.chunk) : new Uint8Array();
          controller.enqueue(chunk);
          port?.postMessage({
            type: "tat-file-download-ack",
            requestId,
            sequence: message.sequence,
          });
          return;
        }
        if (message.type === "tat-file-download-done") {
          settled = true;
          clearTimer();
          port?.close();
          controller.close();
          return;
        }
        if (message.type === "tat-file-download-error") {
          fail(new Error(message.error || "TAT file download failed"));
        }
      };

      resetTimer();
      client.postMessage({
        type: "tat-file-download-request",
        requestId,
        botId: fileRequest.botId,
        path: fileRequest.path,
        name: fileRequest.name,
        size: fileRequest.size,
      }, [channel.port2]);
    });

  let activeDownload = null;
  const stream = new ReadableStream({
    async start(controller) {
      for (const client of clients) {
        try {
          activeDownload = await startFileDownloadFromClient(client, controller);
          return;
        } catch {
          activeDownload = null;
        }
      }
      controller.error(new Error("No LightVela page accepted this TAT file download."));
    },
    cancel() {
      activeDownload?.cancel();
    },
  });

  return new Response(stream, {
    status: 200,
    headers,
  });
};

const parseProxyRequest = (request) => {
  const url = new URL(request.url);
  const rest = url.pathname.slice(PROXY_PREFIX.length);
  const slashIndex = rest.indexOf("/");
  const botId = slashIndex >= 0 ? decodeURIComponent(rest.slice(0, slashIndex)) : decodeURIComponent(rest);
  const remotePath = slashIndex >= 0 ? rest.slice(slashIndex) || "/" : "/";
  return {
    botId,
    remoteUrl: `${remotePath}${url.search}`,
  };
};

const isNullBodyResponse = (status) => status === 204 || status === 205 || status === 304;

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const errorResponse = (status, title, detail) =>
  new Response(
    `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; padding: 24px; font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #111827; background: #fff; }
    h1 { margin: 0 0 12px; font-size: 16px; }
    pre { white-space: pre-wrap; word-break: break-word; margin: 0; color: #b91c1c; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <pre>${escapeHtml(detail)}</pre>
</body>
</html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );

const requestFromClient = (client, payload) =>
  new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    let timer = null;
    let settled = false;
    let streamController = null;
    let streamResolved = false;

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer();
      channel.port1.close();
      reject(error);
    };

    const failStream = (error) => {
      clearTimer();
      channel.port1.close();
      if (streamResolved) {
        streamController?.error(error);
        return;
      }
      fail(error);
    };

    const resetTimer = (timeoutMs) => {
      clearTimer();
      timer = setTimeout(() => {
        failStream(new Error("Hermes WebUI proxy timed out"));
      }, timeoutMs);
    };

    channel.port1.onmessage = (event) => {
      const message = event.data || {};
      if (message.requestId !== payload.requestId) {
        return;
      }
      if (message.type === "tat-hermes-proxy-accepted") {
        resetTimer(REQUEST_TIMEOUT_MS);
        return;
      }
      if (message.type !== "tat-hermes-proxy-response") {
        if (message.type === "tat-hermes-proxy-chunk") {
          resetTimer(PROXY_CHUNK_TIMEOUT_MS);
          const chunk = message.chunk instanceof ArrayBuffer ? new Uint8Array(message.chunk) : new Uint8Array();
          streamController?.enqueue(chunk);
          channel.port1.postMessage({
            type: "tat-hermes-proxy-ack",
            requestId: payload.requestId,
            sequence: message.sequence,
          });
          return;
        }
        if (message.type === "tat-hermes-proxy-done") {
          settled = true;
          clearTimer();
          channel.port1.close();
          streamController?.close();
          return;
        }
        failStream(new Error("invalid Hermes WebUI proxy response"));
        return;
      }
      if (message.error) {
        failStream(new Error(message.error));
        return;
      }
      if (message.stream) {
        settled = true;
        streamResolved = true;
        resetTimer(PROXY_CHUNK_TIMEOUT_MS);
        const body = new ReadableStream({
          start(controller) {
            streamController = controller;
          },
          cancel() {
            clearTimer();
            channel.port1.postMessage({
              type: "tat-hermes-proxy-cancel",
              requestId: payload.requestId,
            });
            channel.port1.close();
          },
        });
        resolve({ ...message, body });
        return;
      }
      settled = true;
      clearTimer();
      channel.port1.close();
      resolve(message);
    };

    resetTimer(PROXY_ACCEPT_TIMEOUT_MS);
    client.postMessage(payload, [channel.port2]);
  });

const isProxyBrokerClient = (client) => {
  try {
    const url = new URL(client.url);
    return !url.pathname.startsWith(PROXY_PREFIX) && !url.pathname.startsWith(FILE_DOWNLOAD_PREFIX);
  } catch {
    return false;
  }
};

const registerBroker = (botId, clientId) => {
  if (!botId || !clientId) {
    return;
  }
  let clients = brokerRegistry.get(botId);
  if (!clients) {
    clients = new Map();
    brokerRegistry.set(botId, clients);
  }
  clients.set(clientId, Date.now());
};

const unregisterBroker = (botId, clientId) => {
  const clients = brokerRegistry.get(botId);
  if (!clients || !clientId) {
    return;
  }
  clients.delete(clientId);
  if (clients.size === 0) {
    brokerRegistry.delete(botId);
  }
};

const registeredBrokerClientsForBot = async (botId) => {
  const registered = brokerRegistry.get(botId);
  if (!registered) {
    return [];
  }
  const now = Date.now();
  const clients = [];
  for (const [clientId, updatedAt] of registered) {
    if (now - updatedAt > BROKER_REGISTRY_TTL_MS) {
      registered.delete(clientId);
      continue;
    }
    const client = await self.clients.get(clientId);
    if (client && isProxyBrokerClient(client)) {
      clients.push(client);
    } else {
      registered.delete(clientId);
    }
  }
  if (registered.size === 0) {
    brokerRegistry.delete(botId);
  }
  return clients;
};

const candidateClientsForProxy = async (botId, clientId) => {
  const clients = [];
  const addClient = (client) => {
    if (client && isProxyBrokerClient(client) && !clients.some((candidate) => candidate.id === client.id)) {
      clients.push(client);
    }
  };

  for (const client of await registeredBrokerClientsForBot(botId)) {
    addClient(client);
  }
  if (clientId) {
    addClient(await self.clients.get(clientId));
  }
  const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of allClients) {
    addClient(client);
  }
  if (clients.length > 0) {
    return clients;
  }
  return allClients;
};

const requestFromFirstAvailableClient = async (clients, payload) => {
  let lastError = null;
  for (const client of clients) {
    try {
      return await requestFromClient(client, payload);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("no Hermes WebUI proxy broker responded");
};

const handleProxyFetch = async (request, clientId) => {
  const { botId, remoteUrl } = parseProxyRequest(request);
  const clients = await candidateClientsForProxy(botId, clientId);
  if (clients.length === 0) {
    return errorResponse(503, "Hermes WebUI proxy broker is not available", "No LightVela page is available to bridge this proxy request.");
  }

  const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const payload = {
    type: "tat-hermes-proxy-request",
    requestId,
    botId,
    method: request.method,
    url: remoteUrl,
    headers: Array.from(request.headers.entries()),
    body,
  };

  try {
    const response = await requestFromFirstAvailableClient(clients, payload);
    const responseBody = isNullBodyResponse(response.status) ? null : response.body || null;
    return new Response(responseBody, {
      status: response.status || 502,
      statusText: response.statusText || "",
      headers: response.headers || [],
    });
  } catch (error) {
    return errorResponse(
      502,
      "Hermes WebUI proxy failed",
      `${error instanceof Error ? error.message : String(error)}\n\nTarget: VM 127.0.0.1:9119\nPath: ${remoteUrl}`,
    );
  }
};
