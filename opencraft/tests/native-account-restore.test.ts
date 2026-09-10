import assert from "node:assert/strict";
import test from "node:test";
import Module, { createRequire } from "node:module";

test("stale native callback does not suppress an existing valid session", async () => {
  const store = new Map([["vela.lightvela.session-token.v1", "fixture-session"]]);
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
    return originalLoad.call(Module, id, ...args);
  };
  globalThis.fetch = async () => new Response(JSON.stringify({ data: { items: [{ instance_id: "test", status: "running", created_at: "" }] } }), { status: 200 });
  try {
    const { createMobileLightVelaAccount } = require(path) as typeof import("../apps/workbench-expo/src/runtime/lightvela-account.native");
    const account = createMobileLightVelaAccount();
    await account.initialize();
    assert.equal(account.getSnapshot().phase, "authenticated");
    assert.equal(store.get("vela.lightvela.session-token.v1"), "fixture-session");
    account.dispose();
  } finally {
    loader._load = originalLoad;
    globalThis.fetch = originalFetch;
    delete require.cache[require.resolve(path)];
  }
});
