import assert from "node:assert/strict";
import test from "node:test";

import { ExtensionSupervisor, resolveHostModelSettingsPage } from "@opencraft/extension-runtime";
import { HOST_PROFILE_CONTRIBUTION_CHANNEL } from "@opencraft/workbench-runtime";
import { createBuiltinAgentsExtension, createHeadlessModelServicesExtension } from "../../plugins/builtin-agents/src/index";

test("Web can activate built-in model and Codex settings without desktop Host registration", async () => {
  const renderedViews: string[] = [];
  const supervisor = new ExtensionSupervisor({
    platform: "web",
    internalContributions: {
      platformViewRenderer: {
        prepare(_owner, value) {
          const view = value as { readonly viewType: string };
          return {
            commit() {
              renderedViews.push(view.viewType);
              return () => undefined;
            },
          };
        },
      },
    },
  });
  try {
    await supervisor.activate(createBuiltinAgentsExtension({
      platform: "web",
      requestHost: async () => { throw new Error("Host request is unnecessary for registration"); },
    }));
    const pages = supervisor.contributions.getSnapshot().settingsPages.map(({ contribution }) => contribution);
    assert.deepEqual(pages.map(({ id }) => id).sort(), [
      "opencraft.builtin-agents.codex-accounts",
      "opencraft.builtin-agents.model-services",
    ]);
    assert.ok(pages.every(({ platforms }) => platforms?.includes("web")));
    assert.ok(pages.every(page => page.modelConfiguration === true));
    assert.deepEqual(Object.fromEntries(pages.map(({ id, targetHostId }) => [id, targetHostId])), {
      "opencraft.builtin-agents.model-services": "local",
      "opencraft.builtin-agents.codex-accounts": "local-codex",
    });
    assert.deepEqual(renderedViews.sort(), [
      "opencraft.builtin-agents.codex-accounts",
      "opencraft.builtin-agents.model-services",
    ]);
  } finally {
    await supervisor.dispose();
  }
});

test("Electron retains daemon Host registration and explicit configuration owners", async () => {
  const providerIds: string[] = [];
  const hostIds: string[] = [];
  const supervisor = new ExtensionSupervisor({
    platform: "electron",
    internalContributions: {
      platformViewRenderer: { prepare() { return { commit: () => () => undefined }; } },
      hostConnectionProvider: {
        prepare(_owner, value) {
          const provider = value as { readonly id: string };
          return { commit() { providerIds.push(provider.id); return () => undefined; } };
        },
      },
      [HOST_PROFILE_CONTRIBUTION_CHANNEL]: {
        prepare(_owner, value) {
          const contribution = value as { readonly profile: { readonly hostId: string } };
          return { commit() { hostIds.push(contribution.profile.hostId); return () => undefined; } };
        },
      },
    },
  });
  try {
    await supervisor.activate(createBuiltinAgentsExtension({
      requestHost: async () => { throw new Error("Host request is unnecessary for registration"); },
      createTransport: () => { throw new Error("Transport is unnecessary for registration"); },
    }));
    const pages = supervisor.contributions.getSnapshot().settingsPages.map(({ contribution }) => contribution);
    assert.equal(pages.length, 2);
    assert.ok(pages.every(({ platforms }) => platforms?.includes("electron")));
    assert.ok(pages.every(page => page.modelConfiguration === true));
    assert.deepEqual(Object.fromEntries(pages.map(({ id, targetHostId }) => [id, targetHostId])), {
      "opencraft.builtin-agents.model-services": "local",
      "opencraft.builtin-agents.codex-accounts": "local-codex",
    });
    assert.deepEqual(providerIds, ["opencraft.builtin-agents"]);
    assert.deepEqual(hostIds.sort(), ["local", "local-codex"]);
  } finally {
    await supervisor.dispose();
  }
});

test("a server deployment contributes exactly one Codex page beside model services", async () => {
  const { createHeadlessServerExtension, createHeadlessModelServicesExtension } = await import("../../plugins/builtin-agents/src/index");
  const supervisor = new ExtensionSupervisor({
    platform: "web",
    internalContributions: {
      platformViewRenderer: { prepare() { return { commit: () => () => undefined }; } },
      hostConnectionProvider: { prepare() { return { commit: () => () => undefined }; } },
      [HOST_PROFILE_CONTRIBUTION_CHANNEL]: { prepare() { return { commit: () => () => undefined }; } },
    },
  });
  const requestHost = async () => { throw new Error("Registration must not read account data"); };
  try {
    await supervisor.activate(createBuiltinAgentsExtension({ platform: "web", requestHost, includeCodexAccounts: false }));
    await supervisor.activate(createHeadlessModelServicesExtension({ requestHost, hostId: "opencraft-server" }));
    await supervisor.activate(createHeadlessServerExtension({ requestHost, workspaceBrowseRoots: ["/"],
      createTransport: () => { throw new Error("Registration must not connect"); } }));
    const pages = supervisor.contributions.getSnapshot().settingsPages.map(({ contribution }) => contribution);
    const accounts = pages.filter(page => page.titleMessage?.id === "settings.contributions.codexAccounts");
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]!.id, "opencraft.server-connections.codex-accounts");
    assert.equal(accounts[0]!.group, "Server");
    assert.equal(accounts[0]!.targetHostId, undefined);
    assert.ok(pages.some(page => page.id === "opencraft.headless-model-services" && page.group === accounts[0]!.group));
    assert.ok(!supervisor.contributions.getSnapshot().views.some(({ contribution }) => contribution.id === "opencraft.builtin-agents.codex-accounts-view"));
  } finally { await supervisor.dispose(); }
});


test("headless model setup resolves the actual server owner and advertises readiness without RPC at registration", async () => {
 const supervisor=new ExtensionSupervisor({platform:"web",internalContributions:{platformViewRenderer:{prepare(){return {commit:()=>()=>undefined}}}}});
 try{
  await supervisor.activate(createHeadlessModelServicesExtension({hostId:"opencraft-server",requestHost:async()=>{throw Error("No configuration RPC expected")},fetcher:async()=>new Response("{}",{status:404})}));
  const pages=supervisor.contributions.getSnapshot().settingsPages.map(({contribution})=>contribution);
  const page=resolveHostModelSettingsPage(pages,"opencraft-server","web");
  assert.equal(page?.id,"opencraft.headless-model-services");assert.equal(page.modelReadiness,true);
  assert.equal(resolveHostModelSettingsPage(pages,"another-host","web"),undefined);
 }finally{await supervisor.dispose()}
});
