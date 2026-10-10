import assert from "node:assert/strict";
import test from "node:test";
import Module, { createRequire } from "node:module";

test("stale native callback does not suppress an existing valid session", async () => {
  const store = new Map([
    ["vela.lightvela.session-token.v1", "fixture-session"],
    ["vela.lightvela.packaged-region.v1", "intl"],
    ["vela.lightvela.region.v1", "intl"],
  ]);
  const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
  const originalLoad = loader._load;
  const originalFetch = globalThis.fetch;
  const require = createRequire(import.meta.url);
  const path = "../apps/workbench-expo/src/runtime/lightvela-account.native.ts";
  loader._load = (id, ...args) => {
    if (id === "expo-linking") return { getInitialURL: async () => "opencraft://auth/lightvela?state=stale&code=stale" };
    if (id === "expo-secure-store") return {
      getItemAsync: async (key: string) => store.get(key) ?? null,
      setItemAsync: async (key: string, value: string) => { store.set(key, value); },
      deleteItemAsync: async (key: string) => { store.delete(key); },
    };
    if (id === "expo-web-browser" || id === "expo-crypto") return {};
    if (id.endsWith("mobile-account-display-cache.native")) return { mobileAccountDisplayCache: { scope: async () => "fixture-scope", clear: async () => undefined } };
    if (id.endsWith("mobile-conversation-drafts.native")) return { clearMobileConversationContinuity: async () => undefined };
    if (id.endsWith("mobile-account-query.native")) return { mobileAccountQueryClient: { clear: () => undefined } };
    if (id === "react-native") return { Platform: { OS: "ios" } };
    return originalLoad.call(Module, id, ...args);
  };
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "https://api.lightvela.ai/auth/session");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-session");
    return new Response(JSON.stringify({ data: { user_id: "test" } }), { status: 200 });
  };
  try {
    const { createMobileLightVelaAccount } = require(path) as typeof import("../apps/workbench-expo/src/runtime/lightvela-account.native");
    const account = createMobileLightVelaAccount();
    await account.initialize();
    assert.equal(account.getSnapshot().phase, "authenticated");
    assert.deepEqual(account.getAuthenticatedSession(), {
      region: "intl", token: "fixture-session", credentialScope: "fixture-scope",
    });
    assert.equal(store.get("vela.lightvela.session-token.v1"), "fixture-session");
    account.dispose();
  } finally {
    loader._load = originalLoad;
    globalThis.fetch = originalFetch;
    delete require.cache[require.resolve(path)];
  }
});

test("expired native session returns to App sign-in before opening the site", async () => {
  const store = new Map([
    ["vela.lightvela.session-token.v1", "expired-session"],
    ["vela.lightvela.packaged-region.v1", "intl"],
    ["vela.lightvela.region.v1", "intl"],
  ]);
  const cleared: string[] = [];
  const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
  const originalLoad = loader._load;
  const originalFetch = globalThis.fetch;
  const require = createRequire(import.meta.url);
  const path = "../apps/workbench-expo/src/runtime/lightvela-account.native.ts";
  loader._load = (id, ...args) => {
    if (id === "expo-linking") return { getInitialURL: async () => null };
    if (id === "expo-secure-store") return {
      getItemAsync: async (key: string) => store.get(key) ?? null,
      setItemAsync: async (key: string, value: string) => { store.set(key, value); },
      deleteItemAsync: async (key: string) => { store.delete(key); },
    };
    if (id === "expo-web-browser" || id === "expo-crypto") return {};
    if (id.endsWith("mobile-account-display-cache.native")) return { mobileAccountDisplayCache: { scope: async () => "fixture-scope", clear: async (region: string, token: string) => { cleared.push(`${region}:${token}`); } } };
    if (id.endsWith("mobile-conversation-drafts.native")) return { clearMobileConversationContinuity: async () => undefined };
    if (id.endsWith("mobile-account-query.native")) return { mobileAccountQueryClient: { clear: () => { cleared.push("query"); } } };
    if (id === "react-native") return { Platform: { OS: "ios" } };
    return originalLoad.call(Module, id, ...args);
  };
  globalThis.fetch = async () => new Response(null, { status: 401 });
  try {
    const { createMobileLightVelaAccount } = require(path) as typeof import("../apps/workbench-expo/src/runtime/lightvela-account.native");
    const account = createMobileLightVelaAccount();
    await account.initialize();
    assert.equal(account.getSnapshot().phase, "anonymous");
    assert.equal(account.getAuthenticatedSession(), null);
    assert.equal(store.has("vela.lightvela.session-token.v1"), false);
    assert.deepEqual(cleared, ["query", "intl:expired-session"]);
    account.dispose();
  } finally {
    loader._load = originalLoad;
    globalThis.fetch = originalFetch;
    delete require.cache[require.resolve(path)];
  }
});

test("region selection persists and restores the matching native auth API", async () => {
  const store = new Map<string, string>();
  const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
  const originalLoad = loader._load;
  const originalFetch = globalThis.fetch;
  const require = createRequire(import.meta.url);
  const path = "../apps/workbench-expo/src/runtime/lightvela-account.native.ts";
  loader._load = (id, ...args) => {
    if (id === "expo-linking") return { getInitialURL: async () => null };
    if (id === "expo-secure-store") return {
      getItemAsync: async (key: string) => store.get(key) ?? null,
      setItemAsync: async (key: string, value: string) => { store.set(key, value); },
      deleteItemAsync: async (key: string) => { store.delete(key); },
    };
    if (id === "expo-web-browser" || id === "expo-crypto") return {};
    if (id.endsWith("mobile-account-display-cache.native")) return { mobileAccountDisplayCache: { scope: async () => "cn-scope", clear: async () => undefined } };
    if (id.endsWith("mobile-conversation-drafts.native")) return { clearMobileConversationContinuity: async () => undefined };
    if (id.endsWith("mobile-account-query.native")) return { mobileAccountQueryClient: { clear: () => undefined } };
    if (id === "react-native") return { Platform: { OS: "ios" } };
    return originalLoad.call(Module, id, ...args);
  };
  globalThis.fetch = async input => {
    assert.equal(input, "https://api.lightvela.com/auth/session");
    return new Response(JSON.stringify({ data: { user_id: "cn-user" } }), { status: 200 });
  };
  try {
    const { createMobileLightVelaAccount } = require(path) as typeof import("../apps/workbench-expo/src/runtime/lightvela-account.native");
    const account = createMobileLightVelaAccount();
    await account.initialize();
    await account.selectRegion("cn");
    assert.equal(account.getSnapshot().region, "cn");
    assert.equal(store.get("vela.lightvela.region.v1"), "cn");
    account.dispose();

    store.set("vela.lightvela.session-token.v1", "cn-session");
    const restored = createMobileLightVelaAccount();
    await restored.initialize();
    assert.equal(restored.getSnapshot().phase, "authenticated");
    assert.equal(restored.getSnapshot().region, "cn");
    assert.deepEqual(restored.getAuthenticatedSession(), {
      region: "cn", token: "cn-session", credentialScope: "cn-scope",
    });
    await assert.rejects(restored.selectRegion("intl"), /Sign out before switching regions/);
    assert.equal(restored.getSnapshot().region, "cn");
    restored.dispose();
  } finally {
    loader._load = originalLoad;
    globalThis.fetch = originalFetch;
    delete require.cache[require.resolve(path)];
  }
});

test("a bodyless 401 clears the active account display scope", async () => {
  const store = new Map([
    ["vela.lightvela.session-token.v1", "fixture-session"],
    ["vela.lightvela.packaged-region.v1", "intl"],
    ["vela.lightvela.region.v1", "intl"],
  ]);
  const cleared: string[] = [];
  const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
  const originalLoad = loader._load;
  const originalFetch = globalThis.fetch;
  const require = createRequire(import.meta.url);
  const path = "../apps/workbench-expo/src/runtime/lightvela-account.native.ts";
  loader._load = (id, ...args) => {
    if (id === "expo-linking") return { getInitialURL: async () => null };
    if (id === "expo-secure-store") return {
      getItemAsync: async (key: string) => store.get(key) ?? null,
      setItemAsync: async (key: string, value: string) => { store.set(key, value); },
      deleteItemAsync: async (key: string) => { store.delete(key); },
    };
    if (id === "expo-web-browser" || id === "expo-crypto") return {};
    if (id === "react-native") return { Platform: { OS: "ios" } };
    if (id.endsWith("mobile-account-display-cache.native")) return { mobileAccountDisplayCache: { scope: async () => "fixture-scope", clear: async (region: string, token: string) => { cleared.push(`${region}:${token}`); } } };
    if (id.endsWith("mobile-conversation-drafts.native")) return { clearMobileConversationContinuity: async () => undefined };
    if (id.endsWith("mobile-account-query.native")) return { mobileAccountQueryClient: { clear: () => { cleared.push("query"); } } };
    return originalLoad.call(Module, id, ...args);
  };
  globalThis.fetch = async input => input === "https://api.lightvela.ai/auth/session"
    ? new Response("{}", { status: 200 }) : new Response(null, { status: 401 });
  try {
    const { createMobileLightVelaAccount } = require(path) as typeof import("../apps/workbench-expo/src/runtime/lightvela-account.native");
    const account = createMobileLightVelaAccount();
    await account.initialize();
    assert.ok(account.getAuthenticatedSession());
    await assert.rejects(account.request("/v1/instances"), /HTTP 401/);
    assert.equal(account.getSnapshot().phase, "anonymous");
    assert.equal(account.getAuthenticatedSession(), null);
    assert.equal(store.has("vela.lightvela.session-token.v1"), false);
    assert.deepEqual(cleared, ["query", "intl:fixture-session"]);
    account.dispose();
  } finally {
    loader._load = originalLoad;
    globalThis.fetch = originalFetch;
    delete require.cache[require.resolve(path)];
  }
});
