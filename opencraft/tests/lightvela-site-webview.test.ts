import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";

import * as webviewModule from "../apps/workbench-expo/src/runtime/lightvela-site-webview";

const { createLightVelaSiteBootstrap, isExpoGoAuthNavigation, isExpoGoGoogleAuthStart, LIGHTVELA_STATIC_PREFETCH } =
  ("default" in webviewModule ? webviewModule.default : webviewModule) as typeof import("../apps/workbench-expo/src/runtime/lightvela-site-webview");

test("iOS site session is written only on the first-party origin and cleared on web sign-out", () => {
  const stored = new Map<string, string>();
  const session = new Map<string, string>();
  const messages: string[] = [];
  let tick: (() => void) | undefined;
  const window = {
    location: { origin: "https://other.example" },
    localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) },
    sessionStorage: { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => session.set(key, value) },
    ReactNativeWebView: { postMessage: (message: string) => messages.push(message) },
    setInterval: (callback: () => void) => { tick = callback; },
    addEventListener: () => undefined,
  };
  runInNewContext(createLightVelaSiteBootstrap("example-session"), { window });
  assert.equal(stored.size, 0);

  window.location.origin = "https://lightvela.ai";
  runInNewContext(createLightVelaSiteBootstrap("example-session"), { window });
  assert.equal(stored.get("lightclaw-auth-token-v1"), "example-session");
  stored.delete("lightclaw-auth-token-v1");
  tick?.();
  assert.deepEqual(messages.map(message => JSON.parse(message)), [{ type: "signed-out" }]);
  assert.equal(session.get("opencraft.native-web-signed-out"), "1");

  runInNewContext(createLightVelaSiteBootstrap("example-session"), { window });
  assert.equal(stored.has("lightclaw-auth-token-v1"), false);
});

test("static prefetch requests anonymous route HTML and caches only first-party assets", async () => {
  const requests: Array<{ url: string; cache: string; credentials: string }> = [];
  const fetch = async (url: string, init: { cache: string; credentials: string }) => {
    requests.push({ url, ...init });
    if (url === "/agents/files") return {
      ok: true,
      headers: { get: () => "text/html" },
      text: async () => '<script src="/__releases/v1/_next/static/chunks/files.js"></script><img src="https://other.example/private.png">',
    };
    return { ok: false, headers: { get: () => null }, text: async () => "" };
  };
  const window = { location: { origin: "https://lightvela.ai", href: "https://lightvela.ai/agents" } };
  const document = {
    querySelectorAll: (selector: string) => selector === "a[href]"
      ? [{ href: "https://lightvela.ai/agents/files" }]
      : [],
  };
  runInNewContext(LIGHTVELA_STATIC_PREFETCH, { window, document, URL, Set, fetch });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(requests, [
    { url: "/agents/files", cache: "no-store", credentials: "omit" },
    { url: "https://lightvela.ai/__releases/v1/_next/static/chunks/files.js", cache: "force-cache", credentials: "omit" },
  ]);
});

test("Expo Go keeps only the known GitHub authorization hops inside the WebView", () => {
  assert.equal(isExpoGoAuthNavigation("https://api.lightvela.ai/auth/oauth/github/start?return_to=https%3A%2F%2Flightvela.ai%2Fagents"), true);
  assert.equal(isExpoGoAuthNavigation("https://github.com/login/oauth/authorize?client_id=example"), true);
  assert.equal(isExpoGoAuthNavigation("https://sites-auth.lightvela.site/auth/oauth/github/callback?code=example"), true);
  assert.equal(isExpoGoAuthNavigation("https://sites-auth.lightvela.site/auth/lightvela/callback?code=example"), true);
  assert.equal(isExpoGoAuthNavigation("https://api.lightvela.ai/v1/instances"), false);
  assert.equal(isExpoGoAuthNavigation("https://github.com.evil.example/login"), false);
  assert.equal(isExpoGoAuthNavigation("http://github.com/login"), false);
  assert.equal(isExpoGoGoogleAuthStart("https://api.lightvela.ai/auth/oauth/google/start"), true);
  assert.equal(isExpoGoGoogleAuthStart("https://github.com/login/oauth/authorize"), false);
});

test("static prefetch hands versioned assets to the site's existing worker", async () => {
  const messages: unknown[] = [];
  class TestMessageChannel {
    port1 = { onmessage: null as null | ((event: { data: unknown }) => void), close: () => undefined };
    port2 = { reply: (data: unknown) => this.port1.onmessage?.({ data }) };
  }
  const worker = { postMessage: (message: unknown, ports: Array<{ reply: (data: unknown) => void }>) => {
    messages.push(message);
    ports[0]?.reply({ type: "OPENCRAFT_STATIC_PREFETCH_ACCEPTED" });
  } };
  const navigator = { serviceWorker: { register: async () => ({ active: worker, update: async () => undefined }), ready: Promise.resolve({ active: worker }) } };
  const fetch = async (url: string) => {
    if (url === "/agents/files") return {
      ok: true,
      headers: { get: () => "text/html" },
      text: async () => '<script src="/__releases/v1/_next/static/chunks/files.js"></script>',
    };
    throw new Error(`Unexpected direct asset fetch: ${url}`);
  };
  const window = { location: { origin: "https://lightvela.ai", href: "https://lightvela.ai/agents" } };
  const document = { querySelectorAll: () => [] };
  runInNewContext(LIGHTVELA_STATIC_PREFETCH, { window, document, navigator, URL, Set, fetch, MessageChannel: TestMessageChannel, setTimeout, clearTimeout });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
    type: "OPENCRAFT_PREFETCH_STATIC",
    urls: ["https://lightvela.ai/__releases/v1/_next/static/chunks/files.js"],
  }]);
});

test("an older site worker falls back to ordinary asset prefetch", async () => {
  const requests: string[] = [];
  class SilentMessageChannel {
    port1 = { onmessage: null, close: () => undefined };
    port2 = {};
  }
  const worker = { postMessage: () => undefined };
  const navigator = { serviceWorker: { register: async () => ({ active: worker, update: async () => undefined }), ready: Promise.resolve({ active: worker }) } };
  const fetch = async (url: string) => {
    requests.push(url);
    return url === "/agents/files"
      ? { ok: true, headers: { get: () => "text/html" }, text: async () => '<script src="/__releases/v1/_next/static/chunks/files.js"></script>' }
      : { ok: true };
  };
  const window = { location: { origin: "https://lightvela.ai", href: "https://lightvela.ai/agents" } };
  const document = { querySelectorAll: () => [] };
  runInNewContext(LIGHTVELA_STATIC_PREFETCH, {
    window, document, navigator, URL, Set, fetch,
    MessageChannel: SilentMessageChannel,
    setTimeout: (callback: () => void) => { callback(); return 1; },
    clearTimeout: () => undefined,
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(requests, [
    "/agents/files",
    "/agents/automations",
    "https://lightvela.ai/__releases/v1/_next/static/chunks/files.js",
  ]);
});
