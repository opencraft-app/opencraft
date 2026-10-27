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
import { openIndexedDbExtensionPersistence } from "../../apps/workbench-web/src/runtime/indexeddb-extension-persistence.ts";

test("self-contained public example opens a host window and unload removes its entry and pending request", async () => {
  const { default: extension } = await import("../../examples/extensions/hello.mjs");
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

function barrier() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

test("manager retirement closes installation admission before owned cleanup", async () => {
  const seed = installation("opencraft.owned", true);
  const runtime = await repository(new MemoryExtensionInstallationPersistence([seed]));
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  const entered = barrier(), cleanup = barrier();
  let candidateLoads = 0, candidateStarts = 0;
  const manager = new ExtensionManager({ installations: runtime.repository, supervisor, loader: {
    async load(source) {
      if (source.url === seed.source.url) return { manifest: manifest(seed.extensionId), activate() {
        return async () => { entered.release(); await cleanup.wait; };
      } };
      candidateLoads++;
      return { manifest: manifest("opencraft.too-late"), activate() { candidateStarts++; } };
    },
  } });
  try {
    await manager.restore();
    const retiring = manager.dispose();
    await entered.wait;
    const [candidate] = await Promise.allSettled([manager.installModuleUrl("https://plugins.test/late.js")]);
    cleanup.release(); await retiring;
    const remaining = supervisor.getSnapshot().extensions.filter(row => row.status === "active");
    assert.equal(candidate.status, "rejected", "retirement cannot admit a new installation during cleanup");
    assert.equal(candidateLoads, 0);
    assert.equal(candidateStarts, 0);
    assert.deepEqual(remaining, []);
    assert.equal(runtime.repository.getSnapshot().records[0]!.enabled, true, "retirement preserves saved intent");
  } finally {
    cleanup.release(); await manager.dispose().catch(() => undefined); await supervisor.dispose(); await runtime.fiber.dispose();
  }
});

test("manager retirement shares cleanup failure and still retires every owned extension", async () => {
  const good = installation("opencraft.a-good", true), bad = installation("opencraft.z-bad", true);
  const runtime = await repository(new MemoryExtensionInstallationPersistence([good, bad]));
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  const entered = barrier(), cleanup = barrier();
  const failure = new Error("managed cleanup failed");
  const events: string[] = [];
  const manager = new ExtensionManager({ installations: runtime.repository, supervisor,
    loader: loaderFor({
      [good.source.url]: { manifest: manifest(good.extensionId), activate() { return () => { events.push("good"); }; } },
      [bad.source.url]: { manifest: manifest(bad.extensionId), activate() { return async () => {
        events.push("bad"); entered.release(); await cleanup.wait; throw failure;
      }; } },
    }),
  });
  const contains = (error: unknown): boolean => error === failure || error instanceof AggregateError && error.errors.some(contains);
  try {
    await manager.restore();
    const first = Promise.allSettled([manager.dispose()]);
    await entered.wait;
    const second = Promise.allSettled([manager.dispose()]);
    cleanup.release();
    const outcomes = [...await first, ...await second, ...await Promise.allSettled([manager.dispose()])];
    assert.deepEqual(events, ["bad", "good"]);
    assert.equal(supervisor.getSnapshot().extensions.some(row => row.status === "active"), false);
    for (const outcome of outcomes) {
      assert.equal(outcome.status, "rejected", "no disposal caller can lose an owned cleanup failure");
      if (outcome.status === "rejected") assert.ok(contains(outcome.reason));
    }
    assert.deepEqual(runtime.repository.getSnapshot().records.map(row => row.enabled), [true, true]);
  } finally {
    cleanup.release(); await manager.dispose().catch(() => undefined); await supervisor.dispose(); await runtime.fiber.dispose();
  }
});

test("manager retirement drains entered loading, rejects queued work and preserves foreign owners", async () => {
  const runtime = await repository(new MemoryExtensionInstallationPersistence());
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  let foreignCleanups = 0, ownedCleanups = 0, loads = 0, finished = false;
  await supervisor.activate({ manifest: manifest("opencraft.foreign"), activate() {
    return () => { foreignCleanups++; };
  } });
  const entered = barrier(), loading = barrier();
  const manager = new ExtensionManager({ installations: runtime.repository, supervisor, loader: {
    async load() {
      loads++; entered.release(); await loading.wait;
      return { manifest: manifest("opencraft.admitted"), activate() { return () => { ownedCleanups++; }; } };
    },
  } });
  try {
    const admitted = manager.installModuleUrl("https://plugins.test/admitted.js");
    await entered.wait;
    const queued = Promise.allSettled([manager.installModuleUrl("https://plugins.test/queued.js")]);
    const retirement = manager.dispose().then(() => { finished = true; });
    await Promise.resolve(); await Promise.resolve();
    const premature = finished;
    loading.release();
    const installation = await admitted;
    const [queuedResult] = await queued;
    await retirement;
    assert.equal(premature, false);
    assert.equal(queuedResult.status, "rejected");
    assert.equal(loads, 1);
    assert.equal(ownedCleanups, 1);
    assert.equal(foreignCleanups, 0, "Manager does not own unrelated Supervisor activations");
    assert.deepEqual(supervisor.getSnapshot().extensions.filter(row => row.status === "active").map(row => row.id), ["opencraft.foreign"]);
    assert.equal(installation.enabled, true);
    assert.equal(runtime.repository.getSnapshot().records[0]!.enabled, true);
    // Saved intent is usable by a fresh manager over the same repository.
    const replacement = new ExtensionManager({ installations: runtime.repository, supervisor,
      loader: loaderFor({ [installation.source.url]: { manifest: manifest("opencraft.admitted"), activate() {} } }),
    });
    await replacement.restore();
    assert.equal(replacement.getSnapshot().extensions[0]!.status, "active");
    await replacement.dispose();
  } finally {
    loading.release(); await manager.dispose().catch(() => undefined); await supervisor.dispose(); await runtime.fiber.dispose();
  }
});

test("optional built-in failure is recorded while another built-in activates", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  assert.equal(await supervisor.activateOptional({ manifest: manifest("opencraft.failed"), activate() { throw Error("unavailable"); } }), false);
  assert.equal(await supervisor.activateOptional({ manifest: manifest("opencraft.healthy"), activate() {} }), true);
  assert.equal(supervisor.getSnapshot().extensions.find(row => row.id === "opencraft.failed")!.status, "failed");
  assert.equal(supervisor.getSnapshot().extensions.find(row => row.id === "opencraft.healthy")!.status, "active");
  await supervisor.dispose();
});

test("optional module import and definition factory failures are isolated", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web", activationTimeoutMs: 10 });
  assert.equal(await supervisor.loadOptional("opencraft.import", async () => { throw Error("module unavailable"); }), false);
  assert.equal(await supervisor.loadOptional("opencraft.timeout", () => new Promise(() => {})), false);
  assert.equal(await supervisor.loadOptional("opencraft.factory", () => { throw Error("factory unavailable"); }), false);
  assert.equal(await supervisor.loadOptional("opencraft.healthy", () => ({ manifest: manifest("opencraft.healthy"), activate() {} })), true);
  assert.deepEqual(supervisor.getSnapshot().extensions.map(row => row.status), ["failed", "failed", "failed", "active"]);
  await supervisor.dispose();
});

test("cleanup failure reports failed instead of a phantom active installation and permits explicit retry", async () => {
  const seed = installation("opencraft.cleanup-failure", true);
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
  const seed = installation("opencraft.builtin", true);
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
  const stuck = installation("opencraft.a-stuck", true);
  const good = installation("opencraft.z-good", true);
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
      manifest: manifest("opencraft.slow"),
      async activate(api) {
        lateApi = api;
        api.commands.register({ id: "opencraft.slow.run", title: "Run" }, () => "wrong");
        await delayed;
        return () => { disposed += 1; };
      },
    }), /activation exceeded/);
    assert.equal(supervisor.contributions.getSnapshot().commands.length, 0);
    assert.throws(() => lateApi.commands.register({ id: "opencraft.slow.late", title: "Late" }, () => {}), /no longer accepting/);
    await supervisor.activate({ manifest: manifest("opencraft.healthy"), activate() {} });
    finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(disposed, 1);
    assert.equal(supervisor.contributions.getSnapshot().commands.length, 0);
    assert.equal(supervisor.getSnapshot().extensions.find(row => row.id === "opencraft.healthy")!.status, "active");
  } finally {
    finish();
    await supervisor.dispose();
  }
});

test("hung cleanup does not skip remaining disposers or block the next activation", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web", cleanupTimeoutMs: 10 });
  let cleaned = 0;
  try {
    await supervisor.activate({ manifest: manifest("opencraft.cleanup"), activate(api) {
      api.commands.register({ id: "opencraft.cleanup.run", title: "Run" }, () => "old");
      api.subscriptions.add(() => { cleaned += 1; });
      api.subscriptions.add(() => new Promise<void>(() => {}));
    } });
    await assert.rejects(supervisor.deactivate("opencraft.cleanup"), /Failed to deactivate/);
    assert.equal(cleaned, 1);
    assert.equal(supervisor.contributions.getSnapshot().commands.length, 0);
    await supervisor.activate({ manifest: manifest("opencraft.cleanup"), activate(api) {
      api.commands.register({ id: "opencraft.cleanup.run", title: "Run" }, () => "new");
    } });
    assert.equal(await supervisor.contributions.executeCommand("opencraft.cleanup.run"), "new");
  } finally {
    await supervisor.dispose();
  }
});

test("command finishing after retirement deadline cannot return a successful stale result", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web", cleanupTimeoutMs: 10 });
  let finish!: (value: string) => void;
  const delayed = new Promise<string>(resolve => { finish = resolve; });
  await supervisor.activate({ manifest: manifest("opencraft.drain"), activate(api) {
    api.commands.register({ id: "opencraft.drain.run", title: "Run" }, () => delayed);
  } });
  const running = supervisor.contributions.executeCommand("opencraft.drain.run");
  const rejected = assert.rejects(running, /no longer accepting/);
  await assert.rejects(supervisor.deactivate("opencraft.drain"), /Failed to deactivate/);
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
    await assert.rejects(supervisor.activate({ manifest: manifest("opencraft.commit"), activate(api) {
      api.commands.register({ id: "opencraft.commit.run", title: "Run" }, () => "wrong");
      api.internal.register("first", {});
      api.internal.register("delayed", {});
    } }), /commit delayed exceeded/);
    assert.deepEqual(events, ["first", "retire-first"]);
    assert.equal(supervisor.contributions.getSnapshot().commands.length, 0);
    finish(() => { events.push("retire-late"); });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(events, ["first", "retire-first", "retire-late"]);
    await supervisor.activate({ manifest: manifest("opencraft.commit"), activate() {} });
  } finally {
    await supervisor.dispose();
  }
});

test("public lifetime signal cancels plugin work before cleanup and active subscriptions are retired", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  let api!: Parameters<TrustedExtensionDefinition["activate"]>[0];
  const events: string[] = [];
  await supervisor.activate({ manifest: manifest("opencraft.lifetime"), activate(value) {
    api = value;
    api.signal.addEventListener("abort", () => events.push("aborted"), { once: true });
  } });
  api.subscriptions.add(() => { events.push("cleanup"); });
  assert.equal(api.signal.aborted, false);
  await supervisor.deactivate("opencraft.lifetime");
  assert.deepEqual(events, ["aborted", "cleanup"]);
  assert.throws(() => api.subscriptions.add(() => {}), /no longer accepting/);
  await supervisor.dispose();
});

test("installation repository isolates corrupt rows and publishes only persisted writes", async () => {
  const persistence = new MemoryExtensionInstallationPersistence([
    installation("opencraft.valid", false),
    { extensionId: "bad", source: { kind: "module-url", url: "x" }, enabled: true },
  ]);
  const runtime = await repository(persistence);
  assert.deepEqual(runtime.repository.getSnapshot().records.map((item) => item.extensionId), ["opencraft.valid"]);
  assert.equal(runtime.repository.getSnapshot().loadErrors.length, 1);

  persistence.put = async () => { throw new Error("persistence unavailable"); };
  await assert.rejects(runtime.repository.put(installation("opencraft.other", true)), /persistence unavailable/u);
  assert.deepEqual(runtime.repository.getSnapshot().records.map((item) => item.extensionId), ["opencraft.valid"]);
  await runtime.fiber.dispose();
});

test("manager restores enabled plugins while isolating individual load failures", async () => {
  const good = installation("opencraft.good", true);
  const bad = installation("opencraft.bad", true);
  const runtime = await repository(new MemoryExtensionInstallationPersistence([good, bad]));
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  const manager = new ExtensionManager({
    installations: runtime.repository,
    supervisor,
    loader: loaderFor({
      [good.source.url]: { manifest: manifest("opencraft.good"), activate: () => undefined },
    }),
  });
  await manager.restore();
  assert.deepEqual(manager.getSnapshot().extensions.map((item) => [item.installation.extensionId, item.status]), [
    ["opencraft.bad", "failed"],
    ["opencraft.good", "active"],
  ]);
  await manager.dispose();
  await supervisor.dispose();
  await runtime.fiber.dispose();
});

test("enable persists only after activation; disable persists before unload", async () => {
  const events: string[] = [];
  const seed = installation("opencraft.order", false);
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
        manifest: manifest("opencraft.order"),
        activate: () => {
          events.push("activate");
          return () => { events.push("dispose"); };
        },
      },
    }),
  });
  await manager.setEnabled("opencraft.order", true);
  assert.deepEqual(events, ["activate", "persist:true"]);
  events.length = 0;
  await manager.setEnabled("opencraft.order", false);
  assert.deepEqual(events, ["persist:false", "dispose"]);
  await manager.dispose();
  await supervisor.dispose();
  await runtime.fiber.dispose();
});

test("IndexedDB installation persistence survives a browser restart", async () => {
  const factory = new IDBFactory();
  const databaseName = "opencraft-extension-installations-test";
  const firstBackend = await openIndexedDbExtensionPersistence(databaseName, factory);
  const firstPersistence = await createPersistentExtensionInstallations(firstBackend);
  const first = await repository(firstPersistence);
  await first.repository.put(installation("opencraft.persisted", true));
  await first.fiber.dispose();
  await firstBackend.close();

  const secondBackend = await openIndexedDbExtensionPersistence(databaseName, factory);
  const secondPersistence = await createPersistentExtensionInstallations(secondBackend);
  const second = await repository(secondPersistence);
  assert.equal(second.repository.getSnapshot().records[0]?.extensionId, "opencraft.persisted");
  assert.equal(second.repository.getSnapshot().records[0]?.enabled, true);
  await second.fiber.dispose();
  await secondBackend.close();
});

test("failed replacement restores commands and preserves persisted enable intent and version", async () => {
  const seed = installation("opencraft.update", true);
  const persistence = new MemoryExtensionInstallationPersistence([seed]);
  const runtime = await repository(persistence);
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  let candidate: TrustedExtensionDefinition = {
    manifest: manifest(seed.extensionId),
    activate(api) {
      api.commands.register({ id: "opencraft.update.run", title: "Run" }, () => "old");
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
        api.commands.register({ id: "opencraft.update.run", title: "Broken" }, () => "new");
        throw new Error("candidate failed");
      },
    };
    await assert.rejects(manager.reload(seed.extensionId), /candidate failed/);
    assert.equal(await supervisor.contributions.executeCommand("opencraft.update.run"), "old");
    assert.notEqual(supervisor.getSnapshot().extensions[0]!.activationId, oldIdentity);
    assert.deepEqual(runtime.repository.getSnapshot().records[0], seed);
    assert.equal(manager.getSnapshot().extensions[0]!.status, "active");
    assert.match(manager.getSnapshot().extensions[0]!.error!, /candidate failed/);
    candidate = {
      manifest: manifest(seed.extensionId, "2.0.0"),
      activate(api) { api.commands.register({ id: "opencraft.update.run", title: "Run" }, () => "new"); },
    };
    await manager.reload(seed.extensionId);
    assert.equal(await supervisor.contributions.executeCommand("opencraft.update.run"), "new");
    assert.equal(runtime.repository.getSnapshot().records[0]!.lastResolvedManifest!.version, "2.0.0");
    assert.equal(manager.getSnapshot().extensions[0]!.error, undefined);
  } finally {
    await manager.dispose();
    await supervisor.dispose();
    await runtime.fiber.dispose();
  }
});

test("replacement persistence failure restores old instance and disabled reinstall stays disabled", async () => {
  const seed = installation("opencraft.persistfailure", true);
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
  const future = { ...installation("opencraft.future", true), lastResolvedManifest: { ...manifest("opencraft.future"), apiVersion: 2 } };
  const good = installation("opencraft.supported", true);
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

test("optional built-in stays discoverable without loading, can enable and disable, and preserves intent across restart", async () => {
  const persistence = new MemoryExtensionInstallationPersistence();
  let loads = 0, releases = 0;
  const definition: TrustedExtensionDefinition = {
    manifest: manifest("example.optional"),
    activate(api) {
      api.views.register({ id: "example.optional.view", title: "Optional", viewType: "example.optional" });
      api.navigation.register({ id: "example.optional.entry", title: "Optional", surface: "sidebar-primary", target: { kind: "view", viewId: "example.optional.view" } });
      api.subscriptions.add(() => { releases++; });
    },
  };
  async function open(defaultEnabled: boolean) {
    const runtime = await repository(persistence);
    const supervisor = new ExtensionSupervisor({ platform: "web" });
    const manager = new ExtensionManager({ installations: runtime.repository, supervisor, loader: loaderFor({}),
      builtins: [{ manifest: definition.manifest, defaultEnabled, async load() { loads++; return definition; } }],
    });
    await manager.restore();
    return { runtime, supervisor, manager, async close() { await manager.dispose(); await supervisor.dispose(); await runtime.fiber.dispose(); } };
  }
  let current = await open(false);
  assert.equal(loads, 0);
  assert.equal(current.manager.getSnapshot().extensions[0].status, "disabled");
  assert.equal(current.supervisor.contributions.getSnapshot().navigation.length, 0);
  await current.manager.setEnabled(definition.manifest.id, true);
  assert.equal(loads, 1);
  assert.equal(current.supervisor.contributions.getSnapshot().navigation.length, 1);
  await current.close();
  current = await open(false);
  assert.equal(loads, 2);
  assert.equal(current.supervisor.contributions.getSnapshot().navigation.length, 1);
  await assert.rejects(current.manager.reload(definition.manifest.id), /update with the application/);
  await assert.rejects(current.manager.remove(definition.manifest.id), /not removed/);
  await current.manager.setEnabled(definition.manifest.id, false);
  assert.equal(current.supervisor.contributions.getSnapshot().navigation.length, 0);
  assert.equal(releases, 2);
  await current.close();
  current = await open(true);
  assert.equal(loads, 2, "new product default must not override the user's disabled choice");
  assert.equal(current.manager.getSnapshot().extensions[0].installation.enabled, false);
  await current.close();
});

test("built-in load failures are isolated and bundled IDs cannot be replaced by URL installs", async () => {
  const runtime = await repository(new MemoryExtensionInstallationPersistence());
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  let fail = true;
  const builtinManifest = manifest("example.optional");
  const manager = new ExtensionManager({ installations: runtime.repository, supervisor,
    loader: loaderFor({ "https://plugins.test/collision": { manifest: builtinManifest, activate() {} } }),
    builtins: [{ manifest: builtinManifest, defaultEnabled: true, async load() {
      if (fail) throw new Error("optional unavailable");
      return { manifest: builtinManifest, activate() {} };
    } }],
  });
  await manager.restore();
  assert.equal(manager.getSnapshot().extensions[0].status, "failed");
  assert.equal(manager.getSnapshot().extensions[0].installation.enabled, true);
  await assert.rejects(manager.installModuleUrl("https://plugins.test/collision"), /reserved/);
  fail = false;
  await manager.setEnabled(builtinManifest.id, true);
  assert.equal(manager.getSnapshot().extensions[0].status, "active");
  await manager.dispose(); await supervisor.dispose(); await runtime.fiber.dispose();
});

test("restoring a saved built-in intent needs no writable storage and presents current bundled metadata", async () => {
  const seed: ExtensionInstallationRecord = { extensionId: "example.optional", source: { kind: "builtin" }, enabled: false,
    installedAt: 1, updatedAt: 1, lastResolvedManifest: manifest("example.optional", "1.0.0") };
  let writes = 0, loads = 0;
  class ReadOnlyPersistence extends MemoryExtensionInstallationPersistence {
    override async put(): Promise<void> { writes++; throw new DOMException("Storage full", "QuotaExceededError"); }
  }
  const runtime = await repository(new ReadOnlyPersistence([seed]));
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  const manager = new ExtensionManager({ installations: runtime.repository, supervisor, loader: loaderFor({}),
    builtins: [{ manifest: manifest("example.optional", "2.0.0"), defaultEnabled: true, async load() { loads++; throw Error("must not load"); } }],
  });
  await manager.restore();
  assert.equal(writes, 0);
  assert.equal(loads, 0);
  assert.equal(manager.getSnapshot().extensions[0].installation.enabled, false);
  assert.equal(manager.getSnapshot().extensions[0].installation.lastResolvedManifest?.version, "2.0.0");
  assert.deepEqual(manager.getSnapshot().discoveryErrors, []);
  assert.deepEqual(runtime.repository.getSnapshot().records[0], seed, "startup must preserve durable user intent without rewriting metadata");
  await manager.dispose(); await supervisor.dispose(); await runtime.fiber.dispose();
});

for (const failure of [new DOMException("Storage full", "QuotaExceededError"), new Error("Extension record collection changed in another client")]) {
  test(`built-in discovery isolates ${failure.name}: ${failure.message} and restores unrelated extensions`, async () => {
    class FailingPersistence extends MemoryExtensionInstallationPersistence {
      override async put(): Promise<void> { throw failure; }
    }
    const external = installation("example.external", true);
    const runtime = await repository(new FailingPersistence([external]));
    const supervisor = new ExtensionSupervisor({ platform: "web" });
    let externalLoads = 0, builtinLoads = 0;
    const manager = new ExtensionManager({ installations: runtime.repository, supervisor,
      loader: { async load() { externalLoads++; return { manifest: manifest(external.extensionId), activate() {} }; } },
      builtins: [{ manifest: manifest("example.optional"), defaultEnabled: false, async load() { builtinLoads++; throw Error("must not load"); } }],
    });
    await manager.restore();
    assert.equal(externalLoads, 1);
    assert.equal(builtinLoads, 0);
    assert.equal(manager.getSnapshot().extensions.find(row => row.installation.extensionId === external.extensionId)?.status, "active");
    assert.deepEqual(manager.getSnapshot().discoveryErrors, [{ extensionId: "example.optional", message: failure.message }]);
    await manager.dispose(); await supervisor.dispose(); await runtime.fiber.dispose();
  });
}


test("removed built-ins stay dormant without affecting installed extensions and retain reintroduction intent", async () => {
  for (const enabled of [true, false]) {
    const removed = { ...installation("example.removed", enabled), source: { kind: "builtin" as const } };
    const external = installation("example.installed", true);
    const runtime = await repository(new MemoryExtensionInstallationPersistence([removed, external]));
    const supervisor = new ExtensionSupervisor({ platform: "web" });
    const loads: string[] = [];
    const manager = new ExtensionManager({ installations: runtime.repository, supervisor, loader: { async load(source) {
      loads.push(source.url);
      return { manifest: manifest(external.extensionId), activate() {} };
    } } });
    try {
      assert.deepEqual(manager.getSnapshot().extensions.map(item => item.installation.extensionId), [external.extensionId]);
      await manager.restore();
      assert.deepEqual(loads, [external.source.url]);
      assert.deepEqual(manager.getSnapshot().extensions.map(item => [item.installation.extensionId, item.status]), [[external.extensionId, "active"]]);
      assert.deepEqual(manager.getSnapshot().discoveryErrors, []);
      assert.equal(runtime.repository.getSnapshot().records.find(item => item.extensionId === removed.extensionId)?.enabled, enabled);
    } finally { await manager.dispose(); await supervisor.dispose(); }
    let starts = 0;
    const returningSupervisor = new ExtensionSupervisor({ platform: "web" });
    const returning = new ExtensionManager({ installations: runtime.repository, supervisor: returningSupervisor,
      loader: loaderFor({ [external.source.url]: { manifest: manifest(external.extensionId), activate() {} } }),
      builtins: [{ manifest: manifest(removed.extensionId), defaultEnabled: !enabled, async load() {
        return { manifest: manifest(removed.extensionId), activate() { starts++; } };
      } }],
    });
    try {
      await returning.restore();
      assert.equal(starts, enabled ? 1 : 0, "reintroduction preserves the saved choice");
    } finally { await returning.dispose(); await returningSupervisor.dispose(); await runtime.fiber.dispose(); }
  }
});

test('restoration activates dependencies before lexically earlier dependents and retains independent plugins', async () => {
  const persistence = new MemoryExtensionInstallationPersistence();
  const owner = await repository(persistence);
  const activated: string[] = [];
  const supervisor = new ExtensionSupervisor({ platform: 'web' });
  const definitions = ['a.companion', 'z.provider', 'independent'].map(id => ({
    manifest: { ...manifest(id), ...(id === 'a.companion' ? { dependencies: ['z.provider'] } : {}) },
    activate() { activated.push(id); },
  }));
  const manager = new ExtensionManager({ installations: owner.repository, supervisor, loader: loaderFor({}),
    builtins: definitions.map(definition => ({ manifest: definition.manifest, defaultEnabled: true, async load() { return definition; } })),
  });
  try {
    // A release can remove the provider's former dependency on its companion.
    // Saved discovery metadata must not recreate the obsolete cycle.
    await owner.repository.put({ ...installation('z.provider', true), source: { kind: 'builtin' },
      lastResolvedManifest: { ...manifest('z.provider'), dependencies: ['a.companion'] } });
    await manager.restore();
    assert.equal(manager.getSnapshot().extensions.every(item => item.status === 'active'), true);
    assert.ok(activated.indexOf('z.provider') < activated.indexOf('a.companion'));
  } finally { await manager.dispose(); await supervisor.dispose(); await owner.fiber.dispose(); }
});
