import assert from "node:assert/strict";
import test from "node:test";

import {
  ExtensionSupervisor,
  type InternalContributionAdapter,
} from "@opencraft/extension-runtime";
import type {
  PlatformAccountContribution,
  PlatformViewRendererContribution,
} from "@opencraft/extension-react";
import {
  createLightVelaPlatformExtension,
  LightVelaAccountService,
} from "@opencraft/plugin-lightvela-platform";
import { createLightVelaHermesExtension } from "@opencraft/plugin-lightvela-hermes";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

const noOpInternalAdapter: InternalContributionAdapter = {
  prepare() { return { commit: () => () => undefined }; },
};

test("LightVela platform owns the shared account surface independently of Hermes", async () => {
  let platformAccount: PlatformAccountContribution | null = null;
  const renderers = new Map<string, PlatformViewRendererContribution>();
  const adapters: Record<string, InternalContributionAdapter> = {
    authenticationProvider: noOpInternalAdapter,
    environmentSource: noOpInternalAdapter,
    hostConnectionProvider: {
      prepare() { return { commit: () => () => undefined }; },
    },
    platformViewRenderer: {
      prepare(_owner, value) {
        const contribution = value as PlatformViewRendererContribution;
        return {
          commit: () => {
            renderers.set(contribution.viewType, contribution);
            return () => { renderers.delete(contribution.viewType); };
          },
        };
      },
    },
    platformAccount: {
      prepare(_owner, value) {
        return {
          commit: () => {
            platformAccount = value as PlatformAccountContribution;
            return () => { platformAccount = null; };
          },
        };
      },
    },
  };
  const account = new LightVelaAccountService({ storage: new MemoryStorage() });
  const supervisor = new ExtensionSupervisor({
    platform: "web",
    internalContributions: adapters,
  });

  await supervisor.activate(createLightVelaPlatformExtension({ account }));

  const platformViewIds = supervisor.contributions.getSnapshot().views
    .map(({ contribution }) => contribution.id);
  assert.deepEqual(platformViewIds, [
    "lightvela.platform.sign-in",
    "lightvela.platform.environment-create",
    "lightvela.platform.account-view",
  ]);
  assert.equal(platformAccount?.id, "lightvela.platform.account");
  assert.equal(platformAccount?.viewId, "lightvela.platform.account-view");
  assert.equal(platformAccount?.authenticationProviderId, "lightvela.platform.account");
  assert.equal(platformAccount?.signInViewId, "lightvela.platform.sign-in");
  assert.equal(platformAccount?.environmentCreation?.viewId, "lightvela.platform.environment-create");
  assert.equal(typeof renderers.get("lightvela.platform.account")?.Component, "function");

  await supervisor.activate(createLightVelaHermesExtension({ account }));
  assert.equal(platformAccount?.id, "lightvela.platform.account");
  assert.equal(
    supervisor.contributions.getSnapshot().views.some(
      ({ contribution }) => contribution.id === "lightvela.hermes.account-view",
    ),
    false,
  );

  await supervisor.deactivate("lightvela.hermes");
  await supervisor.deactivate("lightvela.platform");
  assert.equal(platformAccount, null);
  assert.equal(renderers.size, 0);
  account.dispose();
  await supervisor.dispose();
});

test("an authenticated LightVela account can open Collaboration without a Hermes Bot", async () => {
  const storage = new MemoryStorage();
  storage.setItem("vela.lightvela.session-token.v1", "session");
  const account = new LightVelaAccountService({
    storage,
    apiBase: "https://api.lightvela.test",
    fetchImpl: async () => new Response(JSON.stringify({
      code: "OK",
      message: "ok",
      data: { items: [] },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  await account.refreshBots();
  let platformAccount: PlatformAccountContribution | null = null;
  const supervisor = new ExtensionSupervisor({
    platform: "web",
    internalContributions: {
      authenticationProvider: noOpInternalAdapter,
      environmentSource: noOpInternalAdapter,
      platformViewRenderer: noOpInternalAdapter,
      platformAccount: {
        prepare(_owner, value) {
          return {
            commit: () => {
              platformAccount = value as PlatformAccountContribution;
              return () => { platformAccount = null; };
            },
          };
        },
      },
    },
  });

  await supervisor.activate(createLightVelaPlatformExtension({ account }));

  assert.equal(platformAccount?.getSnapshot().phase, "authenticated");
  assert.equal(platformAccount?.getSnapshot().applicationIntervention, null);

  await supervisor.dispose();
  account.dispose();
});
