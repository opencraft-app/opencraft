import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { IDBFactory } from "fake-indexeddb";
import type { ExtensionManifestV1 } from "@opencraft/extension-contract";
import {
  ExtensionManager,
  ExtensionSupervisor,
  MemoryExtensionInstallationPersistence,
  createPersistentExtensionInstallations,
  provideExtensionInstallationRepository,
  type ExtensionInstallationPersistence,
  type ExtensionInstallationRecord,
  type ExtensionModuleLoader,
  type TrustedExtensionDefinition,
} from "@opencraft/extension-runtime";
import { openIndexedDbExtensionPersistence } from "../apps/workbench-web/src/runtime/indexeddb-extension-persistence.ts";

test("self-contained public example opens a host window and unload removes its entry and pending request", async () => {
  const { default: extension } = await import("../examples/extensions/hello.mjs");
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  await supervisor.activate(extension);
  assert.equal(supervisor.contributions.getSnapshot().navigation[0]!.contribution.id, "example.hello.entry");
  const request = supervisor.contributions.executeCommand("example.hello.open");
  assert.equal(supervisor.announcements.getSnapshot().announcements.length, 1);
  await supervisor.deactivate("example.hello");
  assert.deepEqual(await request, { kind: "dismissed", reason: "owner-disposed" });
  assert.equal(supervisor.contributions.getSnapshot().navigation.length, 0);
  assert.equal(supervisor.announcements.getSnapshot().announcements.length, 0);
  await supervisor.dispose();
});

function manifest(id: string, version = "1.0.0"): ExtensionManifestV1 {
  return {
    manifestVersion: 1,
    id,
    name: id,
    version,
    apiVersion: 1,
    trust: "trusted",
    platforms: ["web"],
    activationEvents: ["onStartupFinished"],
  };
}

function installation(id: string, enabled: boolean): ExtensionInstallationRecord {
  return {
    extensionId: id,
    source: { kind: "module-url", url: `https://plugins.test/${id}.js` },
    enabled,
    installedAt: 1,
    updatedAt: 1,
    lastResolvedManifest: manifest(id),
  };
}

async function repository(persistence: ExtensionInstallationPersistence) {
  const context = new Context();
  const fiber = context.plugin(provideExtensionInstallationRepository(persistence));
  await fiber;
  return { context, fiber, repository: context.extensionInstallations };
}

function loaderFor(
  definitions: Readonly<Record<string, TrustedExtensionDefinition>>,
): ExtensionModuleLoader {
  return {
    async load(source) {
      const definition = definitions[source.url];
      if (definition === undefined) throw new Error(`Missing module ${source.url}`);
      return definition;
    },
  };
}

test("optional built-in failure is recorded while another built-in activates", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  assert.equal(await supervisor.activateOptional({ manifest: manifest("vela.failed"), activate() { throw Error("unavailable"); } }), false);
  assert.equal(await supervisor.activateOptional({ manifest: manifest("vela.healthy"), activate() {} }), true);
  assert.equal(supervisor.getSnapshot().extensions.find(row => row.id === "vela.failed")!.status, "failed");
  assert.equal(supervisor.getSnapshot().extensions.find(row => row.id === "vela.healthy")!.status, "active");
  await supervisor.dispose();
});

test("optional module import and definition factory failures are isolated", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web", activationTimeoutMs: 10 });
  assert.equal(await supervisor.loadOptional("vela.import", async () => { throw Error("module unavailable"); }), false);
  assert.equal(await supervisor.loadOptional("vela.timeout", () => new Promise(() => {})), false);
  assert.equal(await supervisor.loadOptional("vela.factory", () => { throw Error("factory unavailable"); }), false);
  assert.equal(await supervisor.loadOptional("vela.healthy", () => ({ manifest: manifest("vela.healthy"), activate() {} })), true);
  assert.deepEqual(supervisor.getSnapshot().extensions.map(row => row.status), ["failed", "failed", "failed", "active"]);
  await supervisor.dispose();
});

test("cleanup failure reports failed instead of a phantom active installation and permits explicit retry", async () => {
  const seed = installation("vela.cleanup-failure", true);
  const runtime = await repository(new MemoryExtensionInstallationPersistence([seed]));
  const supervisor = new ExtensionSupervisor({ platform: "web", cleanupTimeoutMs: 10 });
  let hangs = true;
  const manager = new ExtensionManager({ installations: runtime.repository, supervisor,
    loader: { async load() { return { manifest: manifest(seed.extensionId), activate() {
      if (hangs) return () => new Promise<void>(() => {});
    } }; } },
  });
  await manager.restore();
  await assert.rejects(manager.reload(seed.extensionId), /Failed to deactivate/);
  assert.equal(manager.getSnapshot().extensions[0]!.status, "failed");
  assert.equal(runtime.repository.getSnapshot().records[0]!.enabled, true);
  hangs = false;
  await manager.reload(seed.extensionId);
  assert.equal(manager.getSnapshot().extensions[0]!.status, "active");
  await manager.dispose(); await supervisor.dispose(); await runtime.fiber.dispose();
});

test("persisted third-party identity cannot claim a built-in activation", async () => {
  const seed = installation("vela.builtin", true);
  const runtime = await repository(new MemoryExtensionInstallationPersistence([seed]));
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  let destroyed = false;
  await supervisor.activate({ manifest: manifest(seed.extensionId), activate() { return () => { destroyed = true; }; } });
  const manager = new ExtensionManager({ installations: runtime.repository, supervisor,
    loader: loaderFor({ [seed.source.url]: { manifest: manifest(seed.extensionId), activate() {} } }),
  });
  await manager.restore();
  assert.match(manager.getSnapshot().extensions[0]!.error!, /owned by a built-in/);
  await manager.dispose();
  assert.equal(destroyed, false);
  await supervisor.dispose();
  await runtime.fiber.dispose();
});

test("a module that never resolves cannot block another installation from restoring", async () => {
  const stuck = installation("vela.a-stuck", true);
  const good = installation("vela.z-good", true);
  const runtime = await repository(new MemoryExtensionInstallationPersistence([stuck, good]));
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  let finish!: (value: TrustedExtensionDefinition) => void;
  let lateActivated = false;
  const delayed = new Promise<TrustedExtensionDefinition>(resolve => { finish = resolve; });
  const manager = new ExtensionManager({
    installations: runtime.repository, supervisor, loadTimeoutMs: 10,
    loader: { load(source) { return source.url === stuck.source.url ? delayed : Promise.resolve({ manifest: manifest(good.extensionId), activate() {} }); } },
  });
  try {
    await manager.restore();
    assert.deepEqual(manager.getSnapshot().extensions.map(row => row.status), ["failed", "active"]);
    assert.match(manager.getSnapshot().extensions[0]!.error!, /module load exceeded/);
    finish({ manifest: manifest(stuck.extensionId), activate() { lateActivated = true; } });
    await delayed;
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(lateActivated, false);
    assert.equal(supervisor.getSnapshot().extensions.length, 1);
  } finally {
    await manager.dispose();
    await supervisor.dispose();
    await runtime.fiber.dispose();
  }
});

test("activation timeout revokes staged contributions and late API while allowing another plugin", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web", activationTimeoutMs: 10 });
  let finish!: () => void;
  const delayed = new Promise<void>(resolve => { finish = resolve; });
  let lateApi!: Parameters<TrustedExtensionDefinition["activate"]>[0];
  let disposed = 0;
  try {
    await assert.rejects(supervisor.activate({
      manifest: manifest("vela.slow"),
      async activate(api) {
        lateApi = api;
        api.commands.register({ id: "vela.slow.run", title: "Run" }, () => "wrong");
        await delayed;
        return () => { disposed += 1; };
      },
    }), /activation exceeded/);
    assert.equal(supervisor.contributions.getSnapshot().commands.length, 0);
    assert.throws(() => lateApi.commands.register({ id: "vela.slow.late", title: "Late" }, () => {}), /no longer accepting/);
    await supervisor.activate({ manifest: manifest("vela.healthy"), activate() {} });
    finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(disposed, 1);
    assert.equal(supervisor.contributions.getSnapshot().commands.length, 0);
    assert.equal(supervisor.getSnapshot().extensions.find(row => row.id === "vela.healthy")!.status, "active");
  } finally {
    finish();
    await supervisor.dispose();
  }
});

test("hung cleanup does not skip remaining disposers or block the next activation", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web", cleanupTimeoutMs: 10 });
  let cleaned = 0;
  try {
    await supervisor.activate({ manifest: manifest("vela.cleanup"), activate(api) {
      api.commands.register({ id: "vela.cleanup.run", title: "Run" }, () => "old");
      api.subscriptions.add(() => { cleaned += 1; });
      api.subscriptions.add(() => new Promise<void>(() => {}));
    } });
    await assert.rejects(supervisor.deactivate("vela.cleanup"), /Failed to deactivate/);
    assert.equal(cleaned, 1);
    assert.equal(supervisor.contributions.getSnapshot().commands.length, 0);
    await supervisor.activate({ manifest: manifest("vela.cleanup"), activate(api) {
      api.commands.register({ id: "vela.cleanup.run", title: "Run" }, () => "new");
    } });
    assert.equal(await supervisor.contributions.executeCommand("vela.cleanup.run"), "new");
  } finally {
    await supervisor.dispose();
  }
});

test("command finishing after retirement deadline cannot return a successful stale result", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web", cleanupTimeoutMs: 10 });
  let finish!: (value: string) => void;
  const delayed = new Promise<string>(resolve => { finish = resolve; });
  await supervisor.activate({ manifest: manifest("vela.drain"), activate(api) {
    api.commands.register({ id: "vela.drain.run", title: "Run" }, () => delayed);
  } });
  const running = supervisor.contributions.executeCommand("vela.drain.run");
  const rejected = assert.rejects(running, /no longer accepting/);
  await assert.rejects(supervisor.deactivate("vela.drain"), /Failed to deactivate/);
  finish("stale");
  await rejected;
  await supervisor.dispose();
});

test("late internal commit is retired after timeout and never publishes public contributions", async () => {
  let finish!: (dispose: () => void) => void;
  const delayed = new Promise<() => void>(resolve => { finish = resolve; });
  const events: string[] = [];
  const supervisor = new ExtensionSupervisor({ platform: "web", activationTimeoutMs: 10,
    internalContributions: {
      first: { prepare: () => ({ commit: () => { events.push("first"); return () => { events.push("retire-first"); }; } }) },
      delayed: { prepare: () => ({ commit: () => delayed }) },
    },
  });
  try {
    await assert.rejects(supervisor.activate({ manifest: manifest("vela.commit"), activate(api) {
      api.commands.register({ id: "vela.commit.run", title: "Run" }, () => "wrong");
      api.internal.register("first", {});
      api.internal.register("delayed", {});
    } }), /commit delayed exceeded/);
    assert.deepEqual(events, ["first", "retire-first"]);
    assert.equal(supervisor.contributions.getSnapshot().commands.length, 0);
    finish(() => { events.push("retire-late"); });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(events, ["first", "retire-first", "retire-late"]);
    await supervisor.activate({ manifest: manifest("vela.commit"), activate() {} });
  } finally {
    await supervisor.dispose();
  }
});

test("public lifetime signal cancels plugin work before cleanup and active subscriptions are retired", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  let api!: Parameters<TrustedExtensionDefinition["activate"]>[0];
  const events: string[] = [];
  await supervisor.activate({ manifest: manifest("vela.lifetime"), activate(value) {
    api = value;
    api.signal.addEventListener("abort", () => events.push("aborted"), { once: true });
  } });
  api.subscriptions.add(() => { events.push("cleanup"); });
  assert.equal(api.signal.aborted, false);
  await supervisor.deactivate("vela.lifetime");
  assert.deepEqual(events, ["aborted", "cleanup"]);
  assert.throws(() => api.subscriptions.add(() => {}), /no longer accepting/);
  await supervisor.dispose();
});

test("installation repository isolates corrupt rows and publishes only persisted writes", async () => {
  const persistence = new MemoryExtensionInstallationPersistence([
    installation("vela.valid", false),
    { extensionId: "bad", source: { kind: "module-url", url: "x" }, enabled: true },
  ]);
  const runtime = await repository(persistence);
  assert.deepEqual(runtime.repository.getSnapshot().records.map((item) => item.extensionId), ["vela.valid"]);
  assert.equal(runtime.repository.getSnapshot().loadErrors.length, 1);

  persistence.put = async () => { throw new Error("persistence unavailable"); };
  await assert.rejects(runtime.repository.put(installation("vela.other", true)), /persistence unavailable/u);
  assert.deepEqual(runtime.repository.getSnapshot().records.map((item) => item.extensionId), ["vela.valid"]);
  await runtime.fiber.dispose();
});

test("manager restores enabled plugins while isolating individual load failures", async () => {
  const good = installation("vela.good", true);
  const bad = installation("vela.bad", true);
  const runtime = await repository(new MemoryExtensionInstallationPersistence([good, bad]));
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  const manager = new ExtensionManager({
    installations: runtime.repository,
    supervisor,
    loader: loaderFor({
      [good.source.url]: { manifest: manifest("vela.good"), activate: () => undefined },
    }),
  });
  await manager.restore();
  assert.deepEqual(manager.getSnapshot().extensions.map((item) => [item.installation.extensionId, item.status]), [
    ["vela.bad", "failed"],
    ["vela.good", "active"],
  ]);
  await manager.dispose();
  await supervisor.dispose();
  await runtime.fiber.dispose();
});

test("enable persists only after activation; disable persists before unload", async () => {
  const events: string[] = [];
  const seed = installation("vela.order", false);
  const base = new MemoryExtensionInstallationPersistence([seed]);
  const persistence: ExtensionInstallationPersistence = {
    load: () => base.load(),
    put: async (value) => { events.push(`persist:${value.enabled}`); await base.put(value); },
    remove: (id) => base.remove(id),
  };
  const runtime = await repository(persistence);
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  const manager = new ExtensionManager({
    installations: runtime.repository,
    supervisor,
    loader: loaderFor({
      [seed.source.url]: {
        manifest: manifest("vela.order"),
        activate: () => {
          events.push("activate");
          return () => { events.push("dispose"); };
        },
      },
    }),
  });
  await manager.setEnabled("vela.order", true);
  assert.deepEqual(events, ["activate", "persist:true"]);
  events.length = 0;
  await manager.setEnabled("vela.order", false);
  assert.deepEqual(events, ["persist:false", "dispose"]);
  await manager.dispose();
  await supervisor.dispose();
  await runtime.fiber.dispose();
});

test("IndexedDB installation persistence survives a browser restart", async () => {
  const factory = new IDBFactory();
  const databaseName = "vela-extension-installations-test";
  const firstBackend = await openIndexedDbExtensionPersistence(databaseName, factory);
  const firstPersistence = await createPersistentExtensionInstallations(firstBackend);
  const first = await repository(firstPersistence);
  await first.repository.put(installation("vela.persisted", true));
  await first.fiber.dispose();
  await firstBackend.close();

  const secondBackend = await openIndexedDbExtensionPersistence(databaseName, factory);
  const secondPersistence = await createPersistentExtensionInstallations(secondBackend);
  const second = await repository(secondPersistence);
  assert.equal(second.repository.getSnapshot().records[0]?.extensionId, "vela.persisted");
  assert.equal(second.repository.getSnapshot().records[0]?.enabled, true);
  await second.fiber.dispose();
  await secondBackend.close();
});

test("failed replacement restores commands and preserves persisted enable intent and version", async () => {
  const seed = installation("vela.update", true);
  const persistence = new MemoryExtensionInstallationPersistence([seed]);
  const runtime = await repository(persistence);
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  let candidate: TrustedExtensionDefinition = {
    manifest: manifest(seed.extensionId),
    activate(api) {
      api.commands.register({ id: "vela.update.run", title: "Run" }, () => "old");
    },
  };
  const manager = new ExtensionManager({
    installations: runtime.repository, supervisor, loader: { async load() { return candidate; } },
  });
  try {
    await manager.restore();
    const oldIdentity = supervisor.getSnapshot().extensions[0]!.activationId;
    candidate = {
      manifest: manifest(seed.extensionId, "2.0.0"),
      activate(api) {
        api.commands.register({ id: "vela.update.run", title: "Broken" }, () => "new");
        throw new Error("candidate failed");
      },
    };
    await assert.rejects(manager.reload(seed.extensionId), /candidate failed/);
    assert.equal(await supervisor.contributions.executeCommand("vela.update.run"), "old");
    assert.notEqual(supervisor.getSnapshot().extensions[0]!.activationId, oldIdentity);
    assert.deepEqual(runtime.repository.getSnapshot().records[0], seed);
    assert.equal(manager.getSnapshot().extensions[0]!.status, "active");
    assert.match(manager.getSnapshot().extensions[0]!.error!, /candidate failed/);
    candidate = {
      manifest: manifest(seed.extensionId, "2.0.0"),
      activate(api) { api.commands.register({ id: "vela.update.run", title: "Run" }, () => "new"); },
    };
    await manager.reload(seed.extensionId);
    assert.equal(await supervisor.contributions.executeCommand("vela.update.run"), "new");
    assert.equal(runtime.repository.getSnapshot().records[0]!.lastResolvedManifest!.version, "2.0.0");
    assert.equal(manager.getSnapshot().extensions[0]!.error, undefined);
  } finally {
    await manager.dispose();
    await supervisor.dispose();
    await runtime.fiber.dispose();
  }
});

test("replacement persistence failure restores old instance and disabled reinstall stays disabled", async () => {
  const seed = installation("vela.persistfailure", true);
  const persistence = new MemoryExtensionInstallationPersistence([seed]);
  const runtime = await repository(persistence);
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  let version = "1.0.0";
  const manager = new ExtensionManager({
    installations: runtime.repository, supervisor,
    loader: { async load() { return { manifest: manifest(seed.extensionId, version), activate() {} }; } },
  });
  try {
    await manager.restore();
    version = "2.0.0";
    const put = persistence.put.bind(persistence);
    persistence.put = async () => { throw new Error("disk unavailable"); };
    await assert.rejects(manager.installModuleUrl("https://plugins.test/new.js"), /disk unavailable/);
    assert.equal(supervisor.getSnapshot().extensions[0]!.version, "1.0.0");
    assert.deepEqual(runtime.repository.getSnapshot().records[0], seed);
    persistence.put = put;
    await manager.setEnabled(seed.extensionId, false);
    await manager.installModuleUrl("https://plugins.test/new.js");
    assert.equal(runtime.repository.getSnapshot().records[0]!.enabled, false);
    assert.equal(supervisor.getSnapshot().extensions.length, 0);
  } finally {
    await manager.dispose();
    await supervisor.dispose();
    await runtime.fiber.dispose();
  }
});

test("future API installation survives restore and is rejected without activating or blocking another plugin", async () => {
  const future = { ...installation("vela.future", true), lastResolvedManifest: { ...manifest("vela.future"), apiVersion: 2 } };
  const good = installation("vela.supported", true);
  const runtime = await repository(new MemoryExtensionInstallationPersistence([future, good]));
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  let futureActivated = false;
  const manager = new ExtensionManager({
    installations: runtime.repository, supervisor,
    loader: loaderFor({
      [future.source.url]: { manifest: future.lastResolvedManifest, activate() { futureActivated = true; } },
      [good.source.url]: { manifest: manifest(good.extensionId), activate() {} },
    }),
  });
  try {
    await manager.restore();
    assert.equal(futureActivated, false);
    assert.equal(runtime.repository.getSnapshot().loadErrors.length, 0);
    assert.equal(manager.getSnapshot().extensions[0]!.status, "incompatible");
    assert.equal(manager.getSnapshot().extensions[1]!.status, "active");
    assert.deepEqual(runtime.repository.getSnapshot().records[0], future);
  } finally {
    await manager.dispose();
    await supervisor.dispose();
    await runtime.fiber.dispose();
  }
});
