/* Replaced by the build plugin; the development template is never registered. */
const BUILD = "__OPENCRAFT_BUILD__";
const FILES = "__OPENCRAFT_FILES__";
const scope = new URL(self.registration.scope);
const prefix = `opencraft-shell-v1:${scope.href}:`;
const cacheName = prefix + BUILD;
const url = name => new URL(name, scope).href;
const staticUrls = new Set(Array.isArray(FILES) ? FILES.map(url) : []);
// Existing branding APIs use absolute public URLs even on a selected server.
// Only declared branding artifacts may alias their deployment-scoped build copy.
const brandingAliases = new Map(Array.isArray(FILES) ? FILES
  .filter(name => name === "opencraft-icon.svg" || name.startsWith("plugin-assets/"))
  .map(name => [new URL("/" + name, scope).href, url(name)]) : []);
const configurationUrl = url("opencraft-offline-configuration");

const installationUrl = url("opencraft-offline-installation");
const installationState = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

// Cache.put is atomic but cannot itself be cancelled. Fence the install result
// even if a browser cache write fails to settle after its response is aborted.
async function withResourceDeadline(work, active) {
  const controller = new AbortController();
  active.add(controller);
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(controller.signal.reason ?? new Error("Offline resource aborted"));
  controller.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Offline resource deadline exceeded")), 30_000);
  try { return await Promise.race([Promise.resolve().then(() => work(controller.signal)), aborted]); }
  finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", abort);
    active.delete(controller);
  }
}

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    if (!Array.isArray(FILES)) throw new Error("Offline shell requires a production build");
    const cache = await caches.open(cacheName);
    const createdAt = Date.now();
    await cache.put(installationUrl, installationState({ complete: false, active: false, createdAt }));
    try {
      let previous = (await caches.keys()).filter(name => name.startsWith(prefix) && name !== cacheName);
      const partial = [];
      for (const name of previous) {
        const status = await (await caches.open(name)).match(installationUrl);
        if (!status) continue;
        try { const value = await status.json(); if (value.complete === false || value.active === false) partial.push({ name, at: value.createdAt ?? 0 }); }
        catch { /* A legacy complete build has no installation metadata. */ }
      }
      // Bound failed-build storage while retaining the active complete build.
      const retired = partial.sort((a, b) => b.at - a.at).slice(1).map(value => value.name);
      for (const name of retired) await caches.delete(name);
      previous = previous.filter(name => !retired.includes(name));
      let index = 0, failure;
      const active = new Set();
      const stop = error => {
        failure ??= error;
        for (const controller of active) controller.abort();
      };
      const results = await Promise.allSettled(Array.from({ length: 2 }, async () => {
        while (!failure && index < FILES.length) {
          const name = FILES[index++];
          let response;
          if (/^assets\/.+-[a-zA-Z0-9_-]{6,}\.[^/]+$/.test(name)) {
            for (const oldName of [cacheName, ...previous]) {
              response = await (await caches.open(oldName)).match(url(name));
              if (response?.ok && !response.headers.get("content-type")?.includes("text/html")) break;
              response = null;
            }
          }
          if (failure) return;
          if (response) {
            try { await withResourceDeadline(() => cache.put(url(name), response), active); }
            catch (error) { stop(error); throw failure; }
            continue;
          }
          for (let attempt = 0; ; attempt++) {
            try {
              await withResourceDeadline(async signal => {
                response = await fetch(url(name), { credentials: "omit", cache: "default", priority: "low", redirect: "error", signal });
                if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                  const error = new Error("Offline resource denied: " + response.status);
                  stop(error); throw error;
                }
                if (!response.ok || (name !== "opencraft-offline.html" && response.headers.get("content-type")?.includes("text/html"))) throw new Error("Offline resource unavailable");
                // The bound includes body download and the atomic cache write.
                await cache.put(url(name), response);
              }, active);
              break;
            } catch (error) {
              if (failure || attempt >= 2 || error?.name === "QuotaExceededError") { stop(error); throw failure; }
              // Only transient failures retry, with bounded pacing rather than a hot loop.
              await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
              if (failure) throw failure;
            }
          }
        }
      }));
      const failed = results.find(result => result.status === "rejected");
      if (failure || failed) throw failure ?? failed.reason;
      await cache.put(installationUrl, installationState({ complete: true, active: false, createdAt }));
    } catch (error) {
      // This is staging until the browser accepts installation. Keep successful
      // immutable entries for the next attempt; failed installation never activates.
      throw error;
    }
    // No skipWaiting: existing documents retain their complete build until closed.
  })());
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const current = await caches.open(cacheName);
    const installed = await current.match(installationUrl);
    if (!installed) throw new Error("Offline build is incomplete");
    const installation = await installed.json();
    if (installation.complete !== true) throw new Error("Offline build is incomplete");
    await current.put(installationUrl, installationState({ ...installation, active: true }));
    const previous = (await caches.keys()).filter(name => name.startsWith(prefix) && name !== cacheName).sort().reverse();
    // A waiting update may activate on the first offline navigation, before a
    // document can configure it. Carry only the sanitized public recipe forward.
    if (!await current.match(configurationUrl)) for (const name of previous) {
      const stored = await (await caches.open(name)).match(configurationUrl);
      if (!stored) continue;
      try {
        const configuration = publicConfiguration(await stored.json());
        await current.put(configurationUrl, new Response(JSON.stringify(configuration), { headers: { "content-type": "application/json" } }));
        break;
      } catch { /* An invalid old recipe cannot become the new bootstrap. */ }
    }
    for (const name of previous) await caches.delete(name);
    await self.clients.claim();
  })());
});

function publicConfiguration(value) {
  const result = {};
  if (value.deployment) {
    const input = value.deployment;
    if (!Array.isArray(input.hosts) || input.hosts.length > 64) throw new Error("Invalid offline configuration");
    result.deployment = {
      hosts: input.hosts.map(host => {
        if (!host || typeof host.hostId !== "string" || typeof host.label !== "string" || typeof host.kind !== "string" || typeof host.url !== "string") throw new Error("Invalid offline Host");
        const endpoint = new URL(host.url, scope);
        if (!["http:", "https:", "ws:", "wss:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Private Host endpoint cannot be cached");
        return { hostId: host.hostId, label: host.label, kind: host.kind, url: host.url };
      }),
      builtinAgents: input.builtinAgents === true, hypernode: input.hypernode === true,
      ...(Array.isArray(input.extensions) ? { extensions: input.extensions.filter(id => typeof id === "string" && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id)) } : {}),
    };
  }
  if (value.server) {
    const input = value.server;
    if (typeof input.id !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(input.id) || typeof input.name !== "string"
      || !["/servers", "/__opencraft_servers"].includes(input.selectorPath)
      || !["", input.selectorPath + "/" + input.id].includes(input.basePath)) throw new Error("Invalid offline deployment scope");
    if (scope.pathname !== (input.basePath || "") + "/") throw new Error("Offline deployment scope mismatch");
    result.server = { id: input.id, name: input.name, selectorPath: input.selectorPath, basePath: input.basePath };
    if (typeof input.targetOrigin === "string") {
      const target = new URL(input.targetOrigin);
      if (!["http:", "https:"].includes(target.protocol) || target.origin !== input.targetOrigin || target.username || target.password) throw new Error("Invalid offline target origin");
      result.server.targetOrigin = input.targetOrigin;
    }
  }
  return result;
}
self.addEventListener("message", event => {
  const data = event.data;
  if (data?.type !== "opencraft-offline-configure" || data.buildId !== BUILD || !event.ports[0]) return;
  event.waitUntil((async () => {
    try {
      const client = event.source && await self.clients.get(event.source.id);
      if (!client || !client.url.startsWith(scope.href)) throw new Error("Untrusted offline configuration");
      if (JSON.stringify(data).length > 64 * 1024) throw new Error("Offline configuration too large");
      const configuration = publicConfiguration(data);
      await (await caches.open(cacheName)).put(configurationUrl, new Response(JSON.stringify(configuration), { headers: { "content-type": "application/json" } }));
      event.ports[0].postMessage({ ok: true, buildId: BUILD });
    } catch { event.ports[0].postMessage({ ok: false }); }
  })());
});
async function offlineDocument() {
  const cache = await caches.open(cacheName);
  const template = await cache.match(url("opencraft-offline.html"));
  const stored = await cache.match(configurationUrl);
  if (!template || !stored) return Response.error();
  const configuration = await stored.json();
  const inert = (id, value) => value ? `<script id="${id}" type="application/json">${JSON.stringify(value).replaceAll("<", "\\u003c")}</script>` : "";
  const body = (await template.text()).replace(/<head(?:\s[^>]*)?>/i, head => head
    + `<meta name="opencraft-offline-build" content="${BUILD.replaceAll('"', '&quot;')}">`
    + `<base href="${scope.href.replaceAll('"', '&quot;')}">`
    + inert("opencraft-deployment-config", configuration.deployment)
    + inert("opencraft-server-context", configuration.server));
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-opencraft-offline-build": BUILD } });
}
self.addEventListener("fetch", event => {
  const request = event.request;
  const target = new URL(request.url);
  if (request.method !== "GET" || target.origin !== scope.origin) return;
  const artifact = staticUrls.has(target.href) ? target.href : brandingAliases.get(target.href);
  if (!target.search && artifact) {
    event.respondWith(caches.open(cacheName).then(async cache => await cache.match(artifact) ?? fetch(request)));
    return;
  }
  if (!target.pathname.startsWith(scope.pathname)) return;
  const relative = target.pathname.slice(scope.pathname.length);
  if (request.mode === "navigate" && (relative === "" || relative === "index.html" || /^(?:local|overhome|environments|views|settings|apps|threads|tasks)(?:\/|$)/.test(relative))) {
    event.respondWith(fetch(request).then(response => response.status >= 500 ? offlineDocument() : response, offlineDocument));
  }
});
