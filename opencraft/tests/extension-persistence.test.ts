import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IDBFactory } from "fake-indexeddb";
import { SqliteDocumentStore as DesktopExtensionDataStore } from "@opencraft/document-storage/sqlite";
import { openIndexedDbExtensionPersistence } from "../apps/workbench-web/src/runtime/indexeddb-extension-persistence.ts";
import { createPersistentExtensionSettingsStorage, type ExtensionPersistence } from "@opencraft/extension-runtime";

for (const kind of ["sqlite", "indexeddb"] as const) {
  test(`${kind}: durable CAS, atomic document, tombstone revision and quota`, async () => {
    const root = await mkdtemp(join(tmpdir(), "oc-extension-store-"));
    const factory = new IDBFactory();
    const open = async (): Promise<ExtensionPersistence> => {
      if (kind === "indexeddb") return openIndexedDbExtensionPersistence(root, factory);
      const store = new DesktopExtensionDataStore(join(root, "data.sqlite"));
      return { read: async s => store.read(s), compareAndSet: async (...args) => store.compareAndSet(...args), subscribe: () => () => {}, close: () => store.close() };
    };
    let a: ExtensionPersistence | undefined, b: ExtensionPersistence | undefined;
    try {
      a = await open(); b = await open();
      const key = "plugin/test.extension/state";
      assert.equal(await a.read(key), null);
      assert.equal((await a.compareAndSet(key, 0, 1, { x: 1 })).updated, true);
      const conflict = await b.compareAndSet(key, 0, 1, { x: 2 });
      assert.equal(conflict.updated, false); assert.deepEqual(conflict.record?.value, { x: 1 });
      assert.equal((await b.compareAndSet(key, 1, 1, {})).updated, true);
      assert.equal((await a.compareAndSet(key, 0, 1, { resurrect: true })).updated, false);
      await assert.rejects(a.compareAndSet(key, 2, 1, { huge: "x".repeat(1024 * 1024) }), /quota/);
      assert.equal((await a.read(key))?.revision, 2);
      await assert.rejects(a.compareAndSet(key, 2, 1, { n: Number.NaN }), /JSON/);
      await a.close(); a = await open();
      assert.deepEqual(await a.read(key), { revision: 2, version: 1, value: {} });
      assert.equal(await a.read("plugin/other.extension/state"), null);
      await a.compareAndSet(key, 2, 2, { upgraded: true });
      await assert.rejects(a.compareAndSet(key, 3, 1, {}));
      assert.deepEqual((await a.read(key))?.value, { upgraded: true });
    } finally { await a?.close(); await b?.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("SQLite rejects changed or newer migration history without changing existing rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-extension-history-")), path = join(root, "data.sqlite");
  try {
    const store = new DesktopExtensionDataStore(path); store.compareAndSet("test/value", 0, 1, "preserved"); store.close();
    const tamper = new DatabaseSync(path); tamper.exec("UPDATE schema_migrations SET checksum='changed'"); tamper.close();
    assert.throws(() => new DesktopExtensionDataStore(path), /migration history/);
    const read = new DatabaseSync(path, { readOnly: true });
    assert.equal(read.prepare("SELECT value_json FROM extension_records").get()?.value_json, '"preserved"'); read.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("IndexedDB closes on versionchange, rejects stale operations and preserves rows", async () => {
  const factory = new IDBFactory(), store = await openIndexedDbExtensionPersistence("upgrade", factory);
  await store.compareAndSet("test/value", 0, 1, 9);
  await new Promise<void>((resolve, reject) => {
    const req = factory.open("upgrade", 2);
    req.onsuccess = () => { req.result.close(); resolve(); }; req.onerror = () => reject(req.error);
  });
  await assert.rejects(store.read("test/value"), /reload required/);
  await assert.rejects(openIndexedDbExtensionPersistence("upgrade", factory), /version/i);
  store.close();
});

test("settings baseline imports once; concurrent stores reject stale writes and newer payload", async () => {
  const factory = new IDBFactory(), backend = await openIndexedDbExtensionPersistence("legacy", factory);
  const record = { key: "test.settings\u0000mode", contributionId: "test.settings", fieldKey: "mode", value: "old" };
  try {
    let imports = 0;
    const a = await createPersistentExtensionSettingsStorage(backend, async () => { imports++; return [record]; });
    const b = await createPersistentExtensionSettingsStorage(backend, async () => { imports++; return []; });
    assert.equal(imports, 1);
    assert.deepEqual(await a.load(), [record]);
    await a.put({ ...record, value: "new" });
    await assert.rejects(b.put({ ...record, value: "stale" }), /another window/);
    assert.equal((await b.load())[0]?.value, "new");
    await a.remove(record.key);
    const reopened = await createPersistentExtensionSettingsStorage(backend, async () => [record]);
    assert.deepEqual(await reopened.load(), []);
    const latest = await backend.read("system/settings");
    await backend.compareAndSet("system/settings", latest!.revision, 2, { future: true });
    await assert.rejects(createPersistentExtensionSettingsStorage(backend), /Unsupported/);
    assert.deepEqual((await backend.read("system/settings"))?.value, { future: true });
  } finally { backend.close(); }
});
