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
