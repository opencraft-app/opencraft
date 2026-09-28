import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { MessageChannel } from "node:worker_threads";
import type { BrowserPageId, BrowserUrl } from "@opencraft/browser-core";

import {
  decodeHostProxyUrl,
  encodeHostProxyUrl,
  HOST_PROXY_PATH_PREFIX,
  HOST_PROXY_SERVICE_WORKER_SCOPE,
  HOST_PROXY_SERVICE_WORKER_URL,
  isLoopbackHttpUrl,
} from "../apps/workbench-web/src/browser/host-proxy-url";

test("Host proxy Service Worker is scoped to the OpenCraft proxy namespace", () => {
  assert.equal(HOST_PROXY_SERVICE_WORKER_URL, "/__opencraft/opencraft-host-proxy-sw.js");
  assert.equal(HOST_PROXY_SERVICE_WORKER_SCOPE, "/__opencraft/host-proxy/");
  assert.ok(`${HOST_PROXY_PATH_PREFIX}/`.startsWith(HOST_PROXY_SERVICE_WORKER_SCOPE));
});
import { WebBrowserPageRuntime } from "../apps/workbench-web/src/browser/web-browser-runtime";
import {
  browserSurfaceSandboxForNavigation,
  type BrowserSurfaceHost,
} from "../apps/workbench-web/src/browser/web-browser-surface-host";

test("only trusted Host proxy navigation drops the iframe sandbox", () => {
  assert.equal(browserSurfaceSandboxForNavigation(true), null);
  assert.match(browserSurfaceSandboxForNavigation(false) ?? "", /allow-same-origin/u);
});

test("Host proxy URLs preserve the logical loopback address without exposing routing state", () => {
  const physical = encodeHostProxyUrl({
    appOrigin: "https://chat.lightvela.com",
    brokerId: "broker/a",
    hostId: "host:velahermes0",
    targetUrl: "http://127.0.0.1:4180/posts/你好?q=a%2Fb#intro",
  });

  assert.equal(
    physical,
    "https://chat.lightvela.com/__opencraft/host-proxy/v1/broker%2Fa/host%3Avelahermes0/http/127.0.0.1%3A4180/posts/%E4%BD%A0%E5%A5%BD?q=a%2Fb#intro",
  );
  assert.deepEqual(decodeHostProxyUrl(physical), {
    brokerId: "broker/a",
    hostId: "host:velahermes0",
    targetUrl: "http://127.0.0.1:4180/posts/%E4%BD%A0%E5%A5%BD?q=a%2Fb#intro",
  });
});

test("Host proxy admits only plain HTTP loopback endpoints", () => {
  assert.equal(isLoopbackHttpUrl("http://localhost:3000"), true);
  assert.equal(isLoopbackHttpUrl("http://127.9.8.7:3000"), true);
  assert.equal(isLoopbackHttpUrl("http://[::1]:3000"), true);
  assert.equal(isLoopbackHttpUrl("https://127.0.0.1:3000"), false);
  assert.equal(isLoopbackHttpUrl("http://192.168.1.10:3000"), false);
  assert.equal(isLoopbackHttpUrl("http://example.com:3000"), false);
  assert.throws(() => encodeHostProxyUrl({
    appOrigin: "https://chat.lightvela.com",
    brokerId: "broker",
    hostId: "host",
    targetUrl: "http://example.com:3000",
  }), /loopback/u);
});

test("malformed and non-proxy same-origin paths never decode as Host routes", () => {
  assert.equal(decodeHostProxyUrl("https://chat.lightvela.com/local/thread"), null);
  assert.equal(decodeHostProxyUrl(
    "https://chat.lightvela.com/__opencraft/host-proxy/v1/broker/host/https/example.com/",
  ), null);
});

test("Service Worker routes documents and root-relative assets through one Host broker", async () => {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const workerSelf = {
    location: { origin: "https://chat.lightvela.com" },
    clients: { claim: async () => undefined },
    skipWaiting: () => undefined,
    addEventListener(type: string, handler: (event: Record<string, unknown>) => void) {
      handlers.set(type, handler);
    },
  };
  const source = readFileSync(
    new URL("../apps/workbench-web/public/opencraft-host-proxy-sw.js", import.meta.url),
    "utf8",
  );
  vm.runInNewContext(source, {
    self: workerSelf,
    URL,
    Headers,
    Response,
    ReadableStream,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    Error,
    Promise,
    setTimeout,
    clearTimeout,
  });

  const brokerId = "broker-test";
  const hostId = "velahermes0";
  const channel = new MessageChannel();
  const targets: string[] = [];
  const forwardedHeaders: Array<readonly (readonly [string, string])[]> = [];
  channel.port1.on("message", (message: Record<string, unknown>) => {
    if (message.type !== "opencraft-host-proxy:fetch") return;
    targets.push(String(message.targetUrl));
    forwardedHeaders.push(message.headers as readonly (readonly [string, string])[]);
    const requestId = String(message.requestId);
    const body = new TextEncoder().encode(
      targets.length === 1
        ? '<html><head></head><body><a href="http://localhost:4180/next">Next</a></body></html>'
        : "body { color: red; }",
    );
    channel.port1.postMessage({
      type: "opencraft-host-proxy:head",
      version: 1,
      requestId,
      status: 200,
      statusText: "OK",
      headers: [["content-type", targets.length === 1 ? "text/html" : "text/css"]],
    });
    channel.port1.postMessage({
      type: "opencraft-host-proxy:chunk",
      version: 1,
      requestId,
      body: body.buffer,
    }, [body.buffer]);
    channel.port1.postMessage({ type: "opencraft-host-proxy:end", version: 1, requestId });
  });
  handlers.get("message")?.({
    data: { type: "opencraft-host-proxy:bind", version: 1, brokerId },
    ports: [channel.port2],
  });

  const physical = encodeHostProxyUrl({
    appOrigin: workerSelf.location.origin,
    brokerId,
    hostId,
    targetUrl: "http://127.0.0.1:4180/posts/one",
  });
  const dispatchFetch = async (request: Request, input: {
    readonly clientId?: string;
    readonly resultingClientId?: string;
  } = {}) => {
    let responsePromise: Promise<Response> | null = null;
    handlers.get("fetch")?.({
      request,
      clientId: input.clientId ?? "",
      resultingClientId: input.resultingClientId ?? "",
      respondWith(value: Promise<Response>) { responsePromise = value; },
    });
    assert.notEqual(responsePromise, null);
    return responsePromise!;
  };

  try {
    const documentResponse = await dispatchFetch(new Request(physical, {
      headers: {
        accept: "text/html",
        authorization: "Bearer must-not-cross",
        cookie: "workbench-session=must-not-cross",
      },
    }), {
      resultingClientId: "preview-frame",
    });
    const html = await documentResponse.text();
    assert.equal(targets[0], "http://127.0.0.1:4180/posts/one");
    assert.equal(documentResponse.headers.get("access-control-allow-origin"), "*");
    assert.match(html, /__opencraft\/preview-bridge\.js/u);
    assert.match(html, /__opencraft\/host-proxy\/v1\/broker-test\/velahermes0\/http\/localhost%3A4180\/next/u);
    assert.equal(forwardedHeaders[0]?.some(([name]) => name === "authorization"), false);
    assert.equal(forwardedHeaders[0]?.some(([name]) => name === "cookie"), false);
    assert.equal(forwardedHeaders[0]?.find(([name]) => name === "origin")?.[1], "http://127.0.0.1:4180");

    const assetResponse = await dispatchFetch(
      new Request("https://chat.lightvela.com/styles/site.css"),
      { clientId: "preview-frame" },
    );
    assert.equal(await assetResponse.text(), "body { color: red; }");
    assert.equal(targets[1], "http://127.0.0.1:4180/styles/site.css");

    const preflight = await dispatchFetch(new Request(
      "https://chat.lightvela.com/api/save",
      {
        method: "OPTIONS",
        headers: {
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      },
    ), { clientId: "preview-frame" });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-methods"), "POST");
    assert.equal(preflight.headers.get("access-control-allow-headers"), "content-type");
    assert.equal(targets.length, 2);
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
});

test("restored Pages recover Host ownership before materializing their physical surface", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const storage = new Map<string, string>([[
    "vela.browser-pages.v1",
    JSON.stringify([{
      id: "page-restored",
      ownerId: "conversation:one",
      createdAt: 1,
      entries: [{ url: "http://127.0.0.1:4180/", title: "Preview" }],
      index: 0,
    }]),
  ]]);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    },
  });
  const navigations: Array<{ url: BrowserUrl | null; opaque: boolean | undefined }> = [];
  const surfaces: BrowserSurfaceHost = {
    setRoot() {},
    navigate(_pageId, _title, url, _events, _force, opaque) {
      navigations.push({ url, opaque });
      return true;
    },
    stop() {},
    automation: () => null,
    commit() {},
    block() {},
    park() {},
    close() {},
    dispose() {},
  };
  const runtime = new WebBrowserPageRuntime(
    surfaces,
    {
      toPhysicalUrl: (url, hostId) => `https://chat.lightvela.com/proxy/${hostId}?url=${encodeURIComponent(url)}` as BrowserUrl,
      toLogicalUrl: (url) => url,
      isPhysicalProxyUrl: (url) => url.includes("/proxy/"),
    },
    (ownerId) => ownerId === "conversation:one" ? "velahermes0" : null,
  );
  try {
    runtime.prepareSurface("page-restored" as BrowserPageId);
    assert.deepEqual(navigations, [{
      url: "https://chat.lightvela.com/proxy/velahermes0?url=http%3A%2F%2F127.0.0.1%3A4180%2F",
      opaque: true,
    }]);
  } finally {
    runtime.dispose();
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", previousWindow);
  }
});
