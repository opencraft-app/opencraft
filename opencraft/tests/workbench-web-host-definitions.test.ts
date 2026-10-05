import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB } from "fake-indexeddb";

import { ExtensionSupervisor } from "@opencraft/extension-runtime";
import { PlatformViewRendererRegistry } from "@opencraft/extension-react";
import { createHeadlessCodexExtension } from "@opencraft/plugin-builtin-agents";
import { createHyperNodeExtension } from "@opencraft/plugin-hypernode";
import {
  HOST_PROFILE_CONTRIBUTION_CHANNEL,
  HostConnectionProviderRegistry,
  type HostConnectionProfile,
} from "@opencraft/workbench-runtime";
import { IndexedDbHostConnectionProfileStore } from "../apps/workbench-web/src/runtime/indexeddb-host-profile-store";
import { HostProfileContributionRegistry } from "../apps/workbench-web/src/runtime/host-profile-contributions";
import { createPlatformViewRendererContributionAdapter } from "../apps/workbench-web/src/runtime/platform-view-renderers";
import {
  BuiltinWebSocketHostConnectionExtension,
  createHostConnectionProviderContributionAdapter,
  WebSocketHostConnectionProvider,
} from "../apps/workbench-web/src/runtime/websocket-host-connection-provider";

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { location: { href: "https://ui.example/", protocol: "https:" } },
});

const {
  createWebHostId,
  parseWebHostDefinitions,
  refreshBundledHostBrowseRoots,
  productDatabaseName,
  productStorageKey,
  activeThreadStorageKey,
  currentProductStorageKey,
  rememberedThreadId,
} = await import(
  "../apps/workbench-web/src/runtime/appserver-runtime-context"
);

test("Web Host identity does not require Crypto.randomUUID", () => {
  assert.equal(createWebHostId(() => "http-fallback-id"), "host:http-fallback-id");
  assert.throws(() => createWebHostId(() => "  "), /empty identity/u);
});

test("the Workbench core does not fabricate a fallback Host", () => {
  assert.deepEqual(parseWebHostDefinitions(undefined, "wss://node.example/rpc"), []);
});

test("named Web products cannot inherit another product's Host or Replica state", () => {
  assert.equal(productStorageKey("opencraft", "vela.active-host-id"), "vela.active-host-id");
  assert.equal(
    productStorageKey("lightvela-web", "vela.active-host-id"),
    "lightvela-web:vela.active-host-id",
  );
  assert.equal(productDatabaseName("opencraft", "vela-host-connections"), "vela-host-connections");
  assert.equal(
    productDatabaseName("lightvela-web", "vela-host-connections"),
    "vela-host-connections-lightvela-web",
  );
  assert.equal(
    productDatabaseName("lightvela-web", "vela-workbench-replica"),
    "vela-workbench-replica-lightvela-web",
  );
});

test("embedded Host startup cannot restore another Host's legacy conversation", () => {
  const hostId = "embedded:current-profile";
  const preferences = new Map<string, string>([
    [currentProductStorageKey("vela.active-thread-id"), "thread:other-profile"],
  ]);
  const storage = { getItem: (key: string) => preferences.get(key) ?? null };

  assert.equal(rememberedThreadId(storage, hostId, "configured"), null);
  assert.equal(rememberedThreadId(storage, hostId, "environment"), "thread:other-profile");

  preferences.set(activeThreadStorageKey(hostId), "thread:current-profile");
  assert.equal(rememberedThreadId(storage, hostId, "configured"), "thread:current-profile");
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
  ]), "wss://fallback.example/rpc"), [
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
  ]), "wss://fallback.example/rpc"), /Duplicate Host definition/u);
  assert.throws(() => parseWebHostDefinitions(JSON.stringify([
    { hostId: "secret", label: "Secret", kind: "remote-ssh", url: "wss://user:pass@node.example/rpc" },
  ]), "wss://fallback.example/rpc"), /must not embed credentials/u);
  assert.throws(() => parseWebHostDefinitions(JSON.stringify([
    { hostId: "http", label: "HTTP", kind: "remote-control", url: "https://node.example/rpc" },
  ]), "wss://fallback.example/rpc"), /must use ws: or wss:/u);
});

test("packaged Web Host resolves its same-origin AppServer endpoint at runtime", () => {
  const [host] = parseWebHostDefinitions(JSON.stringify([{
    hostId: "opencraft-server",
    label: "OpenCraft Server",
    kind: "durable",
    executionLocation: "This server",
    url: "/appserver",
  }]), "wss://ui.example/appserver");
  assert.equal(host?.url, "wss://ui.example/appserver");
  assert.equal(host?.executionLocation, "This server");
});

test("WebSocket connection provider enforces the browser security boundary", () => {
  const context = { platform: "web" as const, hostId: "host:test", profileRevision: 0 };
  assert.deepEqual(
    WebSocketHostConnectionProvider.validate(
      { url: "wss://node.example/appserver", protocols: ["vela.v1"] },
      context,
    ),
    { url: "wss://node.example/appserver", protocols: ["vela.v1"] },
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
    id: "vela.websocket",
    ownerId: "websocket-activation",
  }]);

  const lease = providers.acquire("vela.websocket", platform);
  let retired = false;
  const retirement = extensions.deactivate("vela.websocket-host").then(() => { retired = true; });
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
  assert.deepEqual(providers.getSnapshot().providers.map(({ id }) => id), ["vela.hypernode"]);
  assert.deepEqual(profiles.list().map(({ hostId, providerId }) => ({ hostId, providerId })), [{
    hostId: "hypernode",
    providerId: "vela.hypernode",
  }]);
  await extensions.deactivate("vela.hypernode");
  assert.deepEqual(providers.getSnapshot().providers, []);
  assert.deepEqual(profiles.list(), []);
  await extensions.dispose();
  await providers.close();
});

test("headless Codex inherits the packaged Linux browse root instead of claiming a Mac folder", async () => {
  const providers = new HostConnectionProviderRegistry();
  const profiles = new HostProfileContributionRegistry();
  const renderers = new PlatformViewRendererRegistry();
  const extensions = new ExtensionSupervisor({
    platform: "web",
    createActivationId: () => "headless-codex-activation",
    internalContributions: {
      hostConnectionProvider: createHostConnectionProviderContributionAdapter(providers),
      [HOST_PROFILE_CONTRIBUTION_CHANNEL]: profiles.createAdapter(),
      platformViewRenderer: createPlatformViewRendererContributionAdapter(renderers),
    },
  });
  try {
    await extensions.activate(createHeadlessCodexExtension({
      requestHost: async () => { throw new Error("No Host requests during activation"); },
      createTransport: () => { throw new Error("No transport during activation"); },
      workspaceBrowseRoots: ["/"],
      sshServers: [{ serverId: "ssh:dev", displayName: "Development", workspaceBrowseRoots: ["/remote/projects"] }],
    }));
    assert.deepEqual(profiles.list().find(({ hostId }) => hostId === "local-codex")?.workspaceBrowseRoots, ["/"]);
    const remote = profiles.list().find(({ hostId }) => hostId === "ssh:dev")!;
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
    hostId: "opencraft-server", label: "OpenCraft Server", kind: "durable", url: "/appserver",
    workspaceBrowseRoots: ["/"],
  }]), "wss://node.example/appserver");
  const databaseName = `headless-browse-root-${crypto.randomUUID()}`;
  const oldProfile: HostConnectionProfile = {
    hostId: definition!.hostId,
    displayName: "My Linux node",
    providerId: "vela.websocket",
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
    await refreshBundledHostBrowseRoots(reopened, [definition!]);
    const updated = reopened.getSnapshot().profiles[0]!;
    assert.deepEqual(updated.workspaceBrowseRoots, ["/"]);
    assert.equal(updated.displayName, "My Linux node");
    assert.equal(updated.revision, 3);
    await refreshBundledHostBrowseRoots(reopened, [definition!]);
    assert.equal(reopened.getSnapshot().profiles[0]?.revision, 3);
    await reopened.put({ ...updated, workspaceBrowseRoots: ["/srv/projects"], revision: 4 });
    await refreshBundledHostBrowseRoots(reopened, [definition!]);
    assert.deepEqual(reopened.getSnapshot().profiles[0]?.workspaceBrowseRoots, ["/srv/projects"]);
  } finally {
    reopened.close();
  }
});

test("Host profiles seed once, publish after durable writes, and enforce revision order", async () => {
  const seed: HostConnectionProfile = {
    hostId: "host:seed",
    displayName: "Seed",
    providerId: "vela.websocket",
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
    await store.put({ ...seed, displayName: "Renamed", revision: 1 });
    assert.equal(store.getSnapshot().profiles[0]?.displayName, "Renamed");
  } finally {
    store.close();
  }

  const reopened = await IndexedDbHostConnectionProfileStore.open({
    databaseName,
    factory: indexedDB,
    seed: [{ ...seed, hostId: "host:ignored" }],
  });
  try {
    assert.deepEqual(reopened.getSnapshot().profiles.map((profile) => profile.hostId), ["host:seed"]);
    assert.equal(await reopened.remove("host:seed"), true);
    assert.equal(await reopened.remove("host:seed"), false);
  } finally {
    reopened.close();
  }
});

test("activation-owned Host profiles are visible without becoming durable configuration", async () => {
  const ephemeral: HostConnectionProfile = {
    hostId: "hypernode",
    displayName: "HyperNode",
    providerId: "vela.hypernode",
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
