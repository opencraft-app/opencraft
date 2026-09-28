import assert from "node:assert/strict";
import test from "node:test";

import { IDBFactory } from "fake-indexeddb";
import {
  ExtensionContributionStore,
  ExtensionSettingsStore,
  MemoryExtensionSettingsStorage,
  createPersistentExtensionSettingsStorage,
} from "@opencraft/extension-runtime";
import { openIndexedDbExtensionPersistence } from "../apps/workbench-web/src/runtime/indexeddb-extension-persistence.ts";

const settingsId = "vela.settings-test.preferences";

function contributionBatch() {
  return {
    commands: [],
    views: [],
    navigation: [],
    sidebarCatalogs: [],
    settingsPages: [],
    workbenchSurfaces: [],
    themes: [],
    bots: [],
    settingsSchemas: [{
      id: settingsId,
      title: "Settings test",
      schemaVersion: 1,
      fields: [
        {
          key: "enabled",
          type: "boolean" as const,
          title: "Enabled",
          defaultValue: true,
        },
        {
          key: "port",
          type: "number" as const,
          title: "Port",
          defaultValue: 3000,
        },
        {
          key: "mode",
          type: "select" as const,
          title: "Mode",
          defaultValue: "auto",
          options: [
            { value: "auto", label: "Auto" },
            { value: "manual", label: "Manual" },
          ],
        },
      ],
    }],
  };
}

function registerSettings(
  contributions: ExtensionContributionStore,
  activationId: string,
) {
  const owner = {
    extensionId: "vela.settings-test",
    activationId,
    generation: 1,
  };
  contributions.prepare(owner, contributionBatch())();
  return owner;
}

test("settings store validates declarations, publishes writes, and resets to defaults", async () => {
  const contributions = new ExtensionContributionStore();
  registerSettings(contributions, "activation-1");
  const store = await ExtensionSettingsStore.open(
    contributions,
    new MemoryExtensionSettingsStorage(),
  );
  let publications = 0;
  const unsubscribe = store.subscribe(() => { publications += 1; });

  assert.equal(store.get(settingsId, "enabled"), true);
  assert.equal(store.get(settingsId, "port"), 3000);
  await store.set(settingsId, "port", 4173);
  assert.equal(store.get(settingsId, "port"), 4173);
  await assert.rejects(store.set(settingsId, "port", Number.NaN), /does not accept/u);
  await assert.rejects(store.set(settingsId, "mode", "unknown"), /does not accept/u);
  assert.equal(store.get(settingsId, "port"), 4173);
  await store.reset(settingsId, "port");
  assert.equal(store.get(settingsId, "port"), 3000);
  assert.equal(publications, 2);

  unsubscribe();
  await store.close();
  contributions.close();
});

test("unload hides schema without deleting saved plugin values", async () => {
  const contributions = new ExtensionContributionStore();
  const owner = registerSettings(contributions, "activation-1");
  const storage = new MemoryExtensionSettingsStorage();
  const store = await ExtensionSettingsStore.open(contributions, storage);
  await store.set(settingsId, "mode", "manual");

  contributions.removeOwner(owner);
  assert.throws(() => store.get(settingsId, "mode"), /is not registered/u);
  registerSettings(contributions, "activation-2");
  assert.equal(store.get(settingsId, "mode"), "manual");

  await store.close();
  contributions.close();
});

test("failed persistence never publishes an in-memory setting", async () => {
  const contributions = new ExtensionContributionStore();
  registerSettings(contributions, "activation-1");
  const storage = new MemoryExtensionSettingsStorage();
  storage.put = async () => {
    throw new Error("disk unavailable");
  };
  const store = await ExtensionSettingsStore.open(contributions, storage);
  let publications = 0;
  store.subscribe(() => { publications += 1; });

  await assert.rejects(store.set(settingsId, "port", 9000), /disk unavailable/u);
  assert.equal(store.get(settingsId, "port"), 3000);
  assert.equal(publications, 0);

  await store.close();
  contributions.close();
});

test("IndexedDB adapter restores settings after application restart", async () => {
  const factory = new IDBFactory();
  const databaseName = "vela-extension-settings-test";
  const firstContributions = new ExtensionContributionStore();
  registerSettings(firstContributions, "activation-1");
  const firstBackend = await openIndexedDbExtensionPersistence(databaseName, factory);
  const firstStorage = await createPersistentExtensionSettingsStorage(firstBackend);
  const first = await ExtensionSettingsStore.open(firstContributions, firstStorage);
  await first.set(settingsId, "port", 8899);
  await first.close();
  await firstBackend.close();
  firstContributions.close();

  const secondContributions = new ExtensionContributionStore();
  registerSettings(secondContributions, "activation-2");
  const secondBackend = await openIndexedDbExtensionPersistence(databaseName, factory);
  const secondStorage = await createPersistentExtensionSettingsStorage(secondBackend);
  const second = await ExtensionSettingsStore.open(secondContributions, secondStorage);
  assert.equal(second.get(settingsId, "port"), 8899);
  await second.close();
  await secondBackend.close();
  secondContributions.close();
});
