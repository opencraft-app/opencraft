import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";

import * as webviewModule from "../apps/workbench-expo/src/runtime/lightvela-site-webview";

const { createLightVelaMobileShellBootstrap, createLightVelaLocaleBootstrap, createLightVelaLocaleChange, createLightVelaSiteBootstrap, createLightVelaPageDiagnostics, createLightVelaStaticPrefetch, lightVelaSiteTabForUrl, lightVelaSiteTabUrl, lightVelaSiteUrl, LIGHTVELA_STATIC_PREFETCH } =
  ("default" in webviewModule ? webviewModule.default : webviewModule) as typeof import("../apps/workbench-expo/src/runtime/lightvela-site-webview");

test("native language reaches only the selected first-party site before its i18n starts", () => {
  const stored = new Map<string, string>();
  let reloads = 0;
  const window = {
    location: { origin: "https://other.example", reload: () => { reloads += 1; } },
    localStorage: { setItem: (key: string, value: string) => stored.set(key, value) },
  };
  runInNewContext(createLightVelaLocaleBootstrap("intl", "zh-SG"), { window });
  assert.equal(stored.size, 0);
  window.location.origin = "https://lightvela.ai";
  runInNewContext(createLightVelaLocaleBootstrap("intl", "zh-SG"), { window });
  assert.equal(stored.get("lw-locale"), "zh-SG");
  assert.equal(stored.get("lw-locale-explicit"), "1");
  runInNewContext(createLightVelaLocaleChange("intl", "en-US"), { window });
  assert.equal(stored.get("lw-locale"), "en-US");
  assert.equal(reloads, 1);
  runInNewContext(createLightVelaLocaleChange("cn", "zh-CN"), { window });
  assert.equal(reloads, 1);
});

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

test("domestic site bootstrap and static cache stay on lightvela.com", () => {
  const stored = new Map<string, string>();
  const window = {
    location: { origin: "https://lightvela.ai" },
    localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) },
    sessionStorage: { getItem: () => null },
    setInterval: () => undefined,
    addEventListener: () => undefined,
  };
  assert.equal(lightVelaSiteUrl("cn"), "https://lightvela.com/agents");
  runInNewContext(createLightVelaSiteBootstrap("cn-session", "cn"), { window });
  assert.equal(stored.size, 0);
  window.location.origin = "https://lightvela.com";
  runInNewContext(createLightVelaSiteBootstrap("cn-session", "cn"), { window });
  assert.equal(stored.get("lightclaw-auth-token-v1"), "cn-session");
  assert.match(createLightVelaStaticPrefetch("cn"), /https:\/\/lightvela\.com/);
  assert.doesNotMatch(createLightVelaStaticPrefetch("cn"), /lightvela\.ai/);
});

test("native bottom tabs follow the site's three exact first-party destinations", () => {
  assert.equal(lightVelaSiteTabUrl("cn", "agents"), "https://lightvela.com/agents");
  assert.equal(lightVelaSiteTabUrl("cn", "account"), "https://lightvela.com/account");
  assert.equal(lightVelaSiteTabUrl("intl", "billing"), "https://lightvela.ai/account/billing");
  assert.equal(lightVelaSiteTabForUrl("https://lightvela.ai/agents/settings", "intl"), "agents");
  assert.equal(lightVelaSiteTabForUrl("https://lightvela.ai/account/orders", "intl"), "account");
  assert.equal(lightVelaSiteTabForUrl("https://lightvela.ai/account/billing/", "intl"), "billing");
  assert.equal(lightVelaSiteTabForUrl("https://lightvela.com/account", "intl"), null);
  assert.equal(lightVelaSiteTabForUrl("https://evil.example/account/billing", "intl"), null);
});

test("mobile shell hides only the selected site's duplicate header", () => {
  const appended: Array<{ id: string; textContent: string }> = [];
  const document = {
    documentElement: { appendChild: (value: { id: string; textContent: string }) => appended.push(value) },
    getElementById: () => null,
    createElement: () => ({ id: "", textContent: "" }),
    addEventListener: () => undefined,
  };
  const window = { location: { origin: "https://lightvela.ai" } };
  runInNewContext(createLightVelaMobileShellBootstrap("cn"), { window, document });
  assert.equal(appended.length, 0);
  window.location.origin = "https://lightvela.com";
  runInNewContext(createLightVelaMobileShellBootstrap("cn"), { window, document });
  assert.match(appended[0]?.textContent ?? "", /\.lw-public-site-header \{ display: none !important/);
  assert.match(appended[0]?.textContent ?? "", /\.lw-app-top-pad \{ padding-top: 0 !important/);
});

test("page diagnostics report only first-party visible text length", () => {
  const messages: unknown[] = [];
  let sample: (() => void) | undefined;
  const window = {
    location: { origin: "https://other.example" },
    ReactNativeWebView: { postMessage: (raw: string) => messages.push(JSON.parse(raw)) },
    addEventListener: () => undefined,
    setTimeout: (callback: () => void) => { sample = callback; },
  };
  const document = { body: { innerText: "private page content" } };
  runInNewContext(createLightVelaPageDiagnostics("intl"), { window, document });
  assert.equal(sample, undefined);
  window.location.origin = "https://lightvela.ai";
  runInNewContext(createLightVelaPageDiagnostics("intl"), { window, document });
  sample?.();
  assert.deepEqual(messages, [{ type: "site-health", visibleChars: 20 }]);
  assert.equal(JSON.stringify(messages).includes("private"), false);
});

test("native tabs observe in-site history changes without remounting the WebView", () => {
  const messages: Array<{ type: string; href?: string; lang?: string }> = [];
  let tick: (() => void) | undefined;
  const stored = new Map([["lightclaw-auth-token-v1", "session"]]);
  const document = { documentElement: { lang: "en-US" } };
  const window = {
    location: { origin: "https://lightvela.ai", href: "https://lightvela.ai/agents" },
    localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) },
    sessionStorage: { getItem: () => null },
    ReactNativeWebView: { postMessage: (raw: string) => messages.push(JSON.parse(raw) as { type: string; href?: string; lang?: string }) },
    setInterval: (callback: () => void) => { tick = callback; },
    addEventListener: () => undefined,
  };
  runInNewContext(createLightVelaSiteBootstrap("session"), { window, document });
  window.location.href = "https://lightvela.ai/account/billing";
  tick?.();
  document.documentElement.lang = "zh-CN";
  tick?.();
  assert.deepEqual(messages, [
    { type: "site-location", href: "https://lightvela.ai/agents", lang: "en-US" },
    { type: "site-location", href: "https://lightvela.ai/account/billing", lang: "en-US" },
    { type: "site-location", href: "https://lightvela.ai/account/billing", lang: "zh-CN" },
  ]);
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
