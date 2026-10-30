import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { indexedDB } from "fake-indexeddb";
import { parseWebDeploymentConfig, resolveWebDeploymentConfig, resolveLegacyWebsiteLocation } from "../../apps/workbench-web/src/runtime/web-deployment-config";

import { ExtensionSupervisor } from "@opencraft/extension-runtime";
import { PlatformViewRendererRegistry } from "@opencraft/extension-react";
import { createHeadlessServerExtension } from "@opencraft/plugin-builtin-agents";
import { createHyperNodeExtension } from "@opencraft/plugin-hypernode";
import {
  HOST_PROFILE_CONTRIBUTION_CHANNEL,
  HostConnectionProviderRegistry,
  type HostConnectionProfile,
} from "@opencraft/workbench-runtime";
import { IndexedDbHostConnectionProfileStore } from "../../apps/workbench-web/src/runtime/indexeddb-host-profile-store";
import { HostProfileContributionRegistry } from "../../apps/workbench-web/src/runtime/host-profile-contributions";
import { createPlatformViewRendererContributionAdapter } from "../../apps/workbench-web/src/runtime/platform-view-renderers";
import {
  BuiltinWebSocketHostConnectionExtension,
  createHostConnectionProviderContributionAdapter,
  WebSocketHostConnectionProvider,
} from "../../apps/workbench-web/src/runtime/websocket-host-connection-provider";

const browser = new JSDOM("<!doctype html>", { url: "https://ui.example/" });
Object.defineProperty(globalThis, "window", { configurable: true, value: browser.window });
test.after(() => { browser.window.close(); Reflect.deleteProperty(globalThis, "window"); });

const {
  createWebHostId,
  parseWebHostDefinitions,
  hostDefinitionProfile,
  refreshBundledHostProfiles,
  productDatabaseName,
  productStorageKey,
  activeThreadStorageKey,
  currentProductStorageKey,
  rememberedThreadId,
} = await import(
  "../../apps/workbench-web/src/runtime/appserver-runtime-context"
);

test("Web Host identity does not require Crypto.randomUUID", () => {
  assert.equal(createWebHostId(() => "http-fallback-id"), "host:http-fallback-id");
  assert.throws(() => createWebHostId(() => "  "), /empty identity/u);
});

test("the Workbench core does not fabricate a fallback Host", () => {
  assert.deepEqual(parseWebHostDefinitions(undefined), []);
});

test("named Web products cannot inherit another product's Host or Replica state", () => {
  assert.equal(productStorageKey("opencraft", "opencraft.active-host-id"), "opencraft.active-host-id");
  assert.equal(
    productStorageKey("fixture-product", "opencraft.active-host-id"),
    "fixture-product:opencraft.active-host-id",
  );
  assert.equal(productDatabaseName("opencraft", "opencraft-host-connections"), "opencraft-host-connections");
  assert.equal(
    productDatabaseName("fixture-product", "opencraft-host-connections"),
    "opencraft-host-connections-fixture-product",
  );
  assert.equal(
    productDatabaseName("fixture-product", "opencraft-workbench-replica"),
    "opencraft-workbench-replica-fixture-product",
  );
});

test("browser Host definitions preserve identity and reject ambiguous or credentialed URLs", () => {
  assert.deepEqual(parseWebHostDefinitions(JSON.stringify([
    {
      hostId: "ssh:dev",
      label: "Development",
      kind: "remote-ssh",
      transportEndpoint: "dev.example",
      executionLocation: "devbox",
      workspaceBrowseRoots: ["/workspace", "/srv/projects"],
      url: "wss://dev.example/rpc",
    },
    {
      hostId: "durable",
      label: "Durable",
      kind: "durable",
      url: "wss://durable.example/rpc",
    },
  ])), [
    {
      hostId: "ssh:dev",
      label: "Development",
      kind: "remote-ssh",
      transportEndpoint: "dev.example",
      executionLocation: "devbox",
      workspaceBrowseRoots: ["/workspace", "/srv/projects"],
      url: "wss://dev.example/rpc",
    },
    {
      hostId: "durable",
      label: "Durable",
      kind: "durable",
      transportEndpoint: "durable.example",
      executionLocation: null,
      workspaceBrowseRoots: [],
      url: "wss://durable.example/rpc",
    },
  ]);

  assert.throws(() => parseWebHostDefinitions(JSON.stringify([
    { hostId: "same", label: "One", kind: "local", url: "ws://one.example/rpc" },
    { hostId: "same", label: "Two", kind: "local", url: "ws://two.example/rpc" },
  ])), /Duplicate Host definition/u);
  assert.throws(() => parseWebHostDefinitions(JSON.stringify([
    { hostId: "secret", label: "Secret", kind: "remote-ssh", url: "wss://user:pass@node.example/rpc" },
  ])), /must not embed credentials/u);
  assert.throws(() => parseWebHostDefinitions(JSON.stringify([
    { hostId: "http", label: "HTTP", kind: "remote-control", url: "https://node.example/rpc" },
  ])), /must use ws: or wss:/u);
});

test("packaged Web Host resolves its same-origin AppServer endpoint at runtime", () => {
  const [host] = parseWebHostDefinitions(JSON.stringify([{
    hostId: "opencraft-server",
    label: "Server",
    kind: "durable",
    executionLocation: "This server",
    url: "/appserver",
  }]));
  assert.equal(host?.url, "wss://ui.example/appserver");
  assert.equal(host?.executionLocation, "This server");
});

test("same-origin Host paths use the page's WebSocket scheme and authority", () => {
  const definition = [{ hostId: "local", label: "Server", kind: "remote-control", url: "/appserver" }];
  assert.equal(
    parseWebHostDefinitions(JSON.stringify(definition))[0]?.url,
    "wss://ui.example/appserver",
  );
  const originalLocation = window.location.href;
  browser.reconfigure({ url: "http://server.example:8082/" });
  try {
    assert.equal(
      parseWebHostDefinitions(JSON.stringify(definition))[0]?.url,
      "ws://server.example:8082/appserver",
    );
  } finally {
    browser.reconfigure({ url: originalLocation });
  }
});

test("WebSocket connection provider enforces the browser security boundary", () => {
  const context = { platform: "web" as const, hostId: "host:test", profileRevision: 0 };
  assert.deepEqual(
    WebSocketHostConnectionProvider.validate(
      { url: "wss://node.example/appserver", protocols: ["example.v1"] },
      context,
    ),
    { url: "wss://node.example/appserver", protocols: ["example.v1"] },
  );
  assert.throws(
    () => WebSocketHostConnectionProvider.validate({ url: "ws://node.example/appserver" }, context),
    /requires a secure wss/u,
  );
  assert.throws(
    () => WebSocketHostConnectionProvider.validate({ url: "wss://user:secret@node.example" }, context),
    /must not be embedded/u,
  );
  assert.throws(
    () => WebSocketHostConnectionProvider.validate({ url: "ws://http://192.0.2.10:9989/rpc" }, context),
    /more than one protocol/u,
  );
  assert.throws(
    () => WebSocketHostConnectionProvider.validate({ url: "/appserver" }, context),
    /absolute ws: or wss:/u,
  );
});

for (const platform of ["web", "electron"] as const) {
test(`built-in WebSocket provider is owned and retired by one ${platform} extension activation`, async () => {
  const providers = new HostConnectionProviderRegistry();
  const extensions = new ExtensionSupervisor({
    platform,
    createActivationId: () => "websocket-activation",
    internalContributions: {
      hostConnectionProvider: createHostConnectionProviderContributionAdapter(providers),
    },
  });
  await extensions.activate(BuiltinWebSocketHostConnectionExtension);
  assert.deepEqual(providers.getSnapshot().providers.map(({ id, ownerId }) => ({ id, ownerId })), [{
    id: "opencraft.websocket",
    ownerId: "websocket-activation",
  }]);

  const lease = providers.acquire("opencraft.websocket", platform);
  let retired = false;
  const retirement = extensions.deactivate("opencraft.websocket-host").then(() => { retired = true; });
  for (let index = 0; index < 10 && providers.getSnapshot().providers.length > 0; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(retired, false);
  assert.deepEqual(providers.getSnapshot().providers, []);
  lease.release();
  await retirement;
  assert.equal(retired, true);
  await extensions.dispose();
  await providers.close();
});
}

test("HyperNode owns both its transport provider and ephemeral Host profile", async () => {
  const providers = new HostConnectionProviderRegistry();
  const profiles = new HostProfileContributionRegistry();
  const extensions = new ExtensionSupervisor({
    platform: "web",
    createActivationId: () => "hypernode-activation",
    internalContributions: {
      hostConnectionProvider: createHostConnectionProviderContributionAdapter(providers),
      [HOST_PROFILE_CONTRIBUTION_CHANNEL]: profiles.createAdapter(),
    },
  });
  await extensions.activate(createHyperNodeExtension({ url: "wss://node.example/appserver" }));
  assert.deepEqual(providers.getSnapshot().providers.map(({ id }) => id), ["opencraft.hypernode"]);
  assert.deepEqual(profiles.list().map(({ hostId, providerId }) => ({ hostId, providerId })), [{
    hostId: "hypernode",
    providerId: "opencraft.hypernode",
  }]);
  await extensions.deactivate("opencraft.hypernode");
  assert.deepEqual(providers.getSnapshot().providers, []);
  assert.deepEqual(profiles.list(), []);
  await extensions.dispose();
  await providers.close();
});

test("provider-only HyperNode activation preserves saved-recipe support without creating a target", async () => {
  const providers = new HostConnectionProviderRegistry();
  const profiles = new HostProfileContributionRegistry();
  const extensions = new ExtensionSupervisor({ platform: "web", internalContributions: {
    hostConnectionProvider: createHostConnectionProviderContributionAdapter(providers),
    [HOST_PROFILE_CONTRIBUTION_CHANNEL]: profiles.createAdapter(),
  } });
  await extensions.activate(createHyperNodeExtension({ url: "wss://node.example/appserver", includeDefaultProfile: false }));
  assert.deepEqual(providers.getSnapshot().providers.map(({ id }) => id), ["opencraft.hypernode"]);
  assert.deepEqual(profiles.list(), []);
  const lease = providers.acquire("opencraft.hypernode", "web");
  assert.deepEqual(lease.provider.validate({ url: "wss://saved.example/rpc" }, { platform: "web", hostId: "saved", profileRevision: 1 }), { url: "wss://saved.example/rpc" });
  lease.release();
  await extensions.dispose();
  await providers.close();
});

test("headless server inherits the packaged Linux browse root instead of claiming a Mac folder", async () => {
  const providers = new HostConnectionProviderRegistry();
  const profiles = new HostProfileContributionRegistry();
  const renderers = new PlatformViewRendererRegistry();
  const extensions = new ExtensionSupervisor({
    platform: "web",
    createActivationId: () => "server-connections-activation",
    internalContributions: {
      hostConnectionProvider: createHostConnectionProviderContributionAdapter(providers),
      [HOST_PROFILE_CONTRIBUTION_CHANNEL]: profiles.createAdapter(),
      platformViewRenderer: createPlatformViewRendererContributionAdapter(renderers),
    },
  });
  try {
    await extensions.activate(createHeadlessServerExtension({
      requestHost: async () => { throw new Error("No Host requests during activation"); },
      createTransport: () => { throw new Error("No transport during activation"); },
      workspaceBrowseRoots: ["/"],
      sshServers: [{ serverId: "ssh:dev", displayName: "Development", workspaceBrowseRoots: ["/remote/projects"] }],
    }));
    assert.deepEqual(profiles.list().find(({ hostId }) => hostId === "local-codex")?.workspaceBrowseRoots, ["/"]);
    const remote = profiles.list().find(({ hostId }) => hostId === "ssh:dev")!;
    assert.equal(remote.providerId, "opencraft.server-connections");
    assert.deepEqual(providers.getSnapshot().providers.map(provider => provider.id), ["opencraft.server-connections"]);
    assert.equal(remote.hostKind, "remote-ssh");
    assert.equal(remote.displayName, "Development");
    assert.deepEqual(remote.workspaceBrowseRoots, ["/remote/projects"]);
    assert.equal(remote.credentialRef, null);
    assert.deepEqual(remote.providerConfig, {});
    assert.equal(remote.autoConnect, false);
  } finally {
    await extensions.dispose();
    await providers.close();
  }
  assert.equal(profiles.list().length, 0);
});

test("an older bundled Host gains its Linux root without overwriting user profile fields", async () => {
  const [definition] = parseWebHostDefinitions(JSON.stringify([{
    hostId: "opencraft-server", label: "Server", kind: "durable", url: "/appserver",
    workspaceBrowseRoots: ["/"],
  }]));
  const databaseName = `headless-browse-root-${crypto.randomUUID()}`;
  const oldProfile: HostConnectionProfile = {
    hostId: definition!.hostId,
    displayName: "My Linux node",
    providerId: "opencraft.websocket",
    providerConfig: { url: definition!.url },
    providerConfigVersion: 1,
    hostKind: "durable",
    enabled: true,
    autoConnect: false,
    includeInSidebar: true,
    credentialRef: null,
    transportEndpoint: null,
    executionLocation: "This server",
    workspaceBrowseRoots: [],
    revision: 2,
  };
  const initial = await IndexedDbHostConnectionProfileStore.open({ databaseName, factory: indexedDB });
  await initial.put(oldProfile);
  initial.close();
  const reopened = await IndexedDbHostConnectionProfileStore.open({ databaseName, factory: indexedDB });
  try {
    await refreshBundledHostProfiles(reopened, [definition!]);
    const updated = reopened.getSnapshot().profiles[0]!;
    assert.deepEqual(updated.workspaceBrowseRoots, ["/"]);
    assert.equal(updated.displayName, "My Linux node");
    assert.equal(updated.revision, 3);
    await refreshBundledHostProfiles(reopened, [definition!]);
    assert.equal(reopened.getSnapshot().profiles[0]?.revision, 3);
    await reopened.put({ ...updated, workspaceBrowseRoots: ["/srv/projects"], revision: 4 });
    await refreshBundledHostProfiles(reopened, [definition!]);
    assert.deepEqual(reopened.getSnapshot().profiles[0]?.workspaceBrowseRoots, ["/srv/projects"]);
  } finally {
    reopened.close();
  }
});

test("Host profiles add missing deployment seeds without overwriting saved preferences", async () => {
  const seed: HostConnectionProfile = {
    hostId: "host:seed",
    displayName: "Seed",
    providerId: "opencraft.websocket",
    providerConfig: { url: "wss://seed.example/appserver" },
    providerConfigVersion: 1,
    hostKind: "remote-control",
    enabled: true,
    autoConnect: false,
    includeInSidebar: true,
    credentialRef: null,
    transportEndpoint: "seed.example",
    executionLocation: "seed.example",
    workspaceBrowseRoots: ["/workspace"],
    revision: 0,
  };
  const databaseName = `host-profile-test-${crypto.randomUUID()}`;
  const store = await IndexedDbHostConnectionProfileStore.open({
    databaseName,
    factory: indexedDB,
    seed: [seed],
  });
  try {
    assert.deepEqual(store.getSnapshot().profiles.map((profile) => profile.hostId), ["host:seed"]);
    await assert.rejects(store.put(seed), /revision must increase/u);
    await store.put({ ...seed, displayName: "Renamed", enabled: false, revision: 1 });
    assert.equal(store.getSnapshot().profiles[0]?.displayName, "Renamed");
  } finally {
    store.close();
  }

  const reopened = await IndexedDbHostConnectionProfileStore.open({
    databaseName,
    factory: indexedDB,
    seed: [seed, { ...seed, hostId: "host:added", displayName: "Added" }],
  });
  try {
    assert.deepEqual(reopened.getSnapshot().profiles.map((profile) => profile.hostId), ["host:added", "host:seed"]);
    assert.deepEqual(reopened.getSnapshot().profiles.find(profile => profile.hostId === "host:seed"), {
      ...seed, displayName: "Renamed", enabled: false, revision: 1, machineIdentity: null, agent: null,
    });
  } finally {
    reopened.close();
  }

  const restored = await IndexedDbHostConnectionProfileStore.open({ databaseName, factory: indexedDB });
  try {
    assert.equal(restored.getSnapshot().profiles.filter(profile => profile.hostId === "host:added").length, 1);
    assert.equal(await restored.remove("host:seed"), true);
    assert.equal(await restored.remove("host:seed"), false);
  } finally {
    restored.close();
  }
});

test("activation-owned Host profiles are visible without becoming durable configuration", async () => {
  const ephemeral: HostConnectionProfile = {
    hostId: "hypernode",
    displayName: "HyperNode",
    providerId: "opencraft.hypernode",
    providerConfig: { url: "wss://node.example/appserver" },
    providerConfigVersion: 1,
    hostKind: "remote-control",
    enabled: true,
    autoConnect: false,
    includeInSidebar: true,
    credentialRef: null,
    transportEndpoint: "node.example",
    executionLocation: "HyperNode",
    workspaceBrowseRoots: ["/workspace/projects"],
    revision: 0,
  };
  const databaseName = `host-profile-ephemeral-${crypto.randomUUID()}`;
  const first = await IndexedDbHostConnectionProfileStore.open({
    databaseName,
    factory: indexedDB,
    ephemeral: [ephemeral],
  });
  assert.deepEqual(first.getSnapshot().profiles.map(({ hostId }) => hostId), ["hypernode"]);
  first.close();

  const reopened = await IndexedDbHostConnectionProfileStore.open({ databaseName, factory: indexedDB });
  assert.deepEqual(reopened.getSnapshot().profiles, []);
  reopened.close();
});

const deploymentRuntime = {
  hosts: [
    { hostId: "local", label: "Server", kind: "remote-control", url: "/appserver" },
    { hostId: "local-codex", label: "Server", kind: "remote-control", url: "/codex-appserver" },
  ], builtinAgents: true, hypernode: false,
};
test("runtime deployment preserves stable Host IDs and activates built-in settings", () => {
  const resolved = resolveWebDeploymentConfig(parseWebDeploymentConfig(JSON.stringify(deploymentRuntime)), {});
  assert.deepEqual(JSON.parse(resolved.hosts!), deploymentRuntime.hosts);
  assert.equal(resolved.builtinAgents, true);
  assert.equal(resolved.hypernode, false);
});
test("explicit build configuration wins without merging runtime Hosts", () => {
  const hosts = '[{"hostId":"test"}]';
  assert.deepEqual(resolveWebDeploymentConfig(deploymentRuntime, { hosts, builtinAgents: "disabled", hypernode: "enabled" }), {
    hosts, builtinAgents: false, hypernode: true,
  });
  assert.equal(resolveWebDeploymentConfig(deploymentRuntime, { hosts: " " }).hosts, JSON.stringify(deploymentRuntime.hosts));
});
test("unconfigured Web has no implicit Host; explicit endpoints and deployment flags remain authoritative", () => {
  assert.equal(parseWebDeploymentConfig(null), null);
  assert.equal(resolveWebDeploymentConfig(null, { appServerUrl: "ws://localhost/rpc" }).hypernode, true);
  assert.deepEqual(resolveWebDeploymentConfig(null, {}), { hosts: undefined, builtinAgents: false, hypernode: false });
  assert.deepEqual(resolveWebDeploymentConfig(null, { builtinAgents: "enabled", hypernode: "disabled" }), {
    hosts: undefined, builtinAgents: true, hypernode: false,
  });
  assert.equal(resolveWebDeploymentConfig({ ...deploymentRuntime, hosts: [] }, {}).hosts, undefined);
});
test("present but malformed runtime data fails instead of silently losing Hosts", () => {
  for (const raw of ['bad', 'null', '[]', '{}', '{"hosts":[],"builtinAgents":"true","hypernode":false}']) {
    assert.throws(() => parseWebDeploymentConfig(raw));
  }
});
test("legacy thread and draft links retain resource identity on the canonical website Host", () => {
  assert.deepEqual(resolveLegacyWebsiteLocation({ kind: "thread", key: { hostId: "hypernode", threadId: "t" } } as never), {
    kind: "thread", key: { hostId: "local", threadId: "t" },
  });
  assert.deepEqual(resolveLegacyWebsiteLocation({ kind: "draft", hostId: "hypernode", draftId: "d" } as never), {
    kind: "draft", hostId: "local", draftId: "d",
  });
  assert.equal(resolveLegacyWebsiteLocation(null), null);
});


test("fixed embedded Thread memory is account/Profile scoped and never borrows unbound legacy selection", () => {
  const hostId="embedded-host:ins-fixture:profile:sales";
  const values=new Map([[activeThreadStorageKey(hostId),"unbound-old-thread"],[activeThreadStorageKey(hostId,"cn:account-a"),"account-a-thread"]]);
  const storage={getItem:(key:string)=>values.get(key)??null};
  assert.equal(rememberedThreadId(storage,hostId,"configured","cn:account-a"),"account-a-thread");
  assert.equal(rememberedThreadId(storage,hostId,"configured","cn:account-b"),null);
  assert.equal(rememberedThreadId(storage,"embedded-host:ins-fixture:profile:support","configured","cn:account-a"),null);
  assert.equal(values.get(activeThreadStorageKey(hostId)),"unbound-old-thread","old history/selection is not deleted or reassigned");
});


test("website machine labels validate display-only aliases without editing Host definitions", () => {
  const base = { hosts: [], builtinAgents: true, hypernode: false };
  assert.deepEqual(parseWebDeploymentConfig(JSON.stringify({ ...base, machineDisplayNames: { "ssh:test": " Server " } }))?.machineDisplayNames, { "ssh:test": "Server" });
  for (const machineDisplayNames of [null, [], "Server", { a: " " }, { a: 1 }, { a: "x".repeat(65) }, { a: "Server\n" }]) {
    assert.throws(() => parseWebDeploymentConfig(JSON.stringify({ ...base, machineDisplayNames })), /machine display names/);
  }
});


test("a saved same-instance relay endpoint is refreshed without resetting Host preferences", async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    getElementById(id: string) { return id === "opencraft-server-context" ? { textContent: JSON.stringify({
      id: "stable-lighthouse", name: "Lighthouse", basePath: "/servers/lighthouse", selectorPath: "/servers",
    }) } : null; },
  } });
  const databaseName = `relay-endpoint-${crypto.randomUUID()}`;
  const store = await IndexedDbHostConnectionProfileStore.open({ databaseName, factory: indexedDB });
  try {
    const [definition] = parseWebHostDefinitions(JSON.stringify([{
      hostId: "opencraft-server", label: "Server", kind: "durable", url: "/appserver", workspaceBrowseRoots: ["/"],
    }]));
    const saved = { ...hostDefinitionProfile(definition!), displayName: "My server", enabled: false,
      workspaceBrowseRoots: ["/srv/my-projects"], revision: 7,
      providerConfig: { url: "wss://ui.example/__opencraft_servers/stable-lighthouse/appserver", protocols: ["custom.v1"] } };
    await store.put(saved);
    const persisted = store.getSnapshot().profiles[0]!;
    await refreshBundledHostProfiles(store, [definition!]);
    const updated = store.getSnapshot().profiles[0]!;
    assert.equal((updated.providerConfig as { url: string }).url, "wss://ui.example/servers/lighthouse/appserver");
    assert.deepEqual(updated, { ...persisted, providerConfig: { ...saved.providerConfig, url: definition!.url }, revision: 8 });
    await refreshBundledHostProfiles(store, [definition!]);
    assert.equal(store.getSnapshot().profiles[0]!.revision, 8);
  } finally {
    store.close();
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
