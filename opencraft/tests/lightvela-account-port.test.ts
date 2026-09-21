import assert from "node:assert/strict";
import test from "node:test";

import {
  ExtensionSupervisor,
  type InternalContributionAdapter,
} from "@opencraft/extension-runtime";
import {
  LIGHTVELA_TOKEN_KEY,
  LightVelaAccountService,
} from "@opencraft/plugin-lightvela-platform";
import { createLightVelaHermesExtension } from "@opencraft/plugin-lightvela-hermes";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

test("LightVela account performs authenticated raw collaboration requests", async () => {
  const storage = new MemoryStorage();
  storage.setItem(LIGHTVELA_TOKEN_KEY, "shared-session");
  let authorization: string | null = null;
  const account = new LightVelaAccountService({
    storage,
    apiBase: "https://api.lightvela.test",
    fetchImpl: async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({
        items: [{ id: "server-1", name: "Builders" }],
        nextCursor: null,
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await account.requestRaw<{
    readonly items: readonly { readonly id: string; readonly name: string }[];
    readonly nextCursor: string | null;
  }>("/v1/servers");

  assert.equal(authorization, "Bearer shared-session");
  assert.deepEqual(result, {
    items: [{ id: "server-1", name: "Builders" }],
    nextCursor: null,
  });
  account.dispose();
});

test("Hermes borrows an injected application-owned LightVela account", async () => {
  const storage = new MemoryStorage();
  const account = new LightVelaAccountService({ storage });
  let subscriptions = 0;
  let disposed = 0;
  const originalSubscribe = account.subscribe;
  account.subscribe = (listener) => {
    subscriptions += 1;
    return originalSubscribe(listener);
  };
  account.dispose = () => {
    disposed += 1;
  };
  const noOpAdapter: InternalContributionAdapter = {
    prepare() {
      return { commit: () => () => undefined };
    },
  };
  const supervisor = new ExtensionSupervisor({
    platform: "web",
    internalContributions: {
      hostConnectionProvider: noOpAdapter,
      platformViewRenderer: noOpAdapter,
      platformAccount: noOpAdapter,
    },
  });

  await supervisor.activate(createLightVelaHermesExtension({ account }));

  assert.equal(subscriptions > 0, true);
  await supervisor.deactivate("lightvela.hermes");
  assert.equal(disposed, 0);
  await supervisor.dispose();
});
