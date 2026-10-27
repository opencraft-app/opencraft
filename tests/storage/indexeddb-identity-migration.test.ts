import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { IndexedDbSidebarLayoutStorage } from "../../apps/workbench-web/src/runtime/indexeddb-sidebar-layout-storage";
import { isBrowserStorageFailure } from "../../apps/workbench-web/src/runtime/browser-storage-error";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbIdentityError, migrateIndexedDbIdentity } from "@opencraft/indexeddb-storage";

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = transaction.onerror = () => reject(transaction.error); });
}
async function seed(factory: IDBFactory, name: string) {
  const request = factory.open(name, 1);
  request.onupgradeneeded = () => {
    const store = request.result.createObjectStore("rows", { keyPath: "id" });
    store.createIndex("by-owner", "owner", { unique: false });
    store.put({ id: "one", owner: "account/opaque", value: "remembered" });
    request.result.createObjectStore("out-of-line").put({ opaque: true }, ["server", 1]);
  };
  const db = await result(request); db.close();
}
const migration = (factory: IDBFactory) => ({ factory, name: "opencraft-owned", formerName: "former-owned", formerWriterVersion: 1 });

test("known database migration preserves inline/out-of-line keys, indexes and historical records", async () => {
  const factory = new IDBFactory(); await seed(factory, "former-owned");
  await migrateIndexedDbIdentity(migration(factory));
  const current = await result(factory.open("opencraft-owned", 1));
  try {
    assert.deepEqual(await result(current.transaction("rows").objectStore("rows").index("by-owner").get("account/opaque")), { id: "one", owner: "account/opaque", value: "remembered" });
    assert.deepEqual(await result(current.transaction("out-of-line").objectStore("out-of-line").get(["server", 1])), { opaque: true });
    assert.equal(current.objectStoreNames.contains("__opencraft_identity_handoff"), false);
    const tx = current.transaction("rows", "readwrite"), done = complete(tx); tx.objectStore("rows").clear(); await done;
  } finally { current.close(); }
  await assert.rejects(result(factory.open("former-owned", 1)), error => error instanceof DOMException && error.name === "VersionError");
  const source = await result(factory.open("former-owned"));
  try { assert.equal((await result(source.transaction("rows").objectStore("rows").get("one"))).value, "remembered"); }
  finally { source.close(); }
  await migrateIndexedDbIdentity(migration(factory));
  const reopened = await result(factory.open("opencraft-owned"));
  try { assert.equal(await result(reopened.transaction("rows").objectStore("rows").count()), 0, "cleared current data must not reimport history"); }
  finally { reopened.close(); }
});

test("missing sources are never created and existing current data remains authoritative", async () => {
  const factory = new IDBFactory(); await migrateIndexedDbIdentity(migration(factory));
  assert.deepEqual(await factory.databases(), []);
  await seed(factory, "opencraft-owned"); await seed(factory, "former-owned");
  await migrateIndexedDbIdentity(migration(factory));
  const old = await result(factory.open("former-owned", 1)); old.close();
});

test("an old window blocking handoff fails before destination creation; late upgrade is cancelled and retry preserves data", async () => {
  const factory = new IDBFactory(); await seed(factory, "former-owned");
  const old = await result(factory.open("former-owned", 1));
  await assert.rejects(migrateIndexedDbIdentity({ ...migration(factory), timeoutMs: 25 }), error => error instanceof IndexedDbIdentityError && error.reason === "blocked");
  assert.equal((await factory.databases()).some(db => db.name === "opencraft-owned"), false);
  old.close(); await setImmediate(); await setImmediate();
  const unchanged = await result(factory.open("former-owned", 1)); unchanged.close();
  await migrateIndexedDbIdentity(migration(factory));
  assert.equal((await factory.databases()).some(db => db.name === "opencraft-owned"), true);
});

test("failed destination creation rolls back all copied stores and retries from the sealed source", async () => {
  const factory = new IDBFactory(); await seed(factory, "former-owned");
  const failingFactory = { open(name: string, version?: number) {
    const request = factory.open(name, version);
    if (name === "opencraft-owned" && version !== undefined) request.addEventListener("upgradeneeded", () => request.transaction?.abort());
    return request;
  } } as IDBFactory;
  await assert.rejects(migrateIndexedDbIdentity(migration(failingFactory)));
  assert.equal((await factory.databases()).some(db => db.name === "opencraft-owned"), false);
  await migrateIndexedDbIdentity(migration(factory));
  const current = await result(factory.open("opencraft-owned"));
  try { assert.equal(await result(current.transaction("rows").objectStore("rows").count()), 1); }
  finally { current.close(); }
});

test("concurrent migration callers produce one destination without duplicate records", async () => {
  const factory = new IDBFactory(); await seed(factory, "former-owned");
  await Promise.all([migrateIndexedDbIdentity(migration(factory)), migrateIndexedDbIdentity(migration(factory))]);
  const current = await result(factory.open("opencraft-owned"));
  try { assert.equal(await result(current.transaction("rows").objectStore("rows").count()), 1); }
  finally { current.close(); }
});


test("a blocker released before the deadline allows the original migration to finish", async () => {
  const factory = new IDBFactory(); await seed(factory, "former-owned");
  const old = await result(factory.open("former-owned", 1));
  old.onversionchange = () => { setTimeout(() => old.close(), 10); };
  try {
    await migrateIndexedDbIdentity({ ...migration(factory), timeoutMs: 1_000 });
    const current = await result(factory.open("opencraft-owned"));
    try { assert.equal((await result(current.transaction("rows").objectStore("rows").get("one"))).value, "remembered"); }
    finally { current.close(); }
  } finally { old.close(); }
});

test("an expired probe closes a late database handle without retaining a lock", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const request = new EventTarget() as IDBOpenDBRequest;
  let closes = 0;
  Object.defineProperty(request, "result", { value: { close() { ++closes; } } });
  const factory = { open: () => request } as unknown as IDBFactory;
  const opening = migrateIndexedDbIdentity(migration(factory));
  const rejected = assert.rejects(opening, error => error instanceof IndexedDbIdentityError && error.reason === "timeout");
  context.mock.timers.tick(10_000);
  await rejected;
  request.dispatchEvent(new Event("success"));
  assert.equal(closes, 1);
});


test("an active Sidebar releases its handle so a newer page can migrate without losing rows", async () => {
  const factory = new IDBFactory();
  const sidebar = await IndexedDbSidebarLayoutStorage.open({ factory, databaseName: "former-sidebar" });
  const document = { schemaVersion: 2 as const, pinnedEntityKeys: ["thread/remembered"], ownership: "user" as const };
  await sidebar.save("fixture", document);
  try {
    await migrateIndexedDbIdentity({ factory, name: "current-sidebar", formerName: "former-sidebar", formerWriterVersion: 1, timeoutMs: 100 });
    await assert.rejects(sidebar.load("fixture"), /closed/);
    const reopened = await IndexedDbSidebarLayoutStorage.open({ factory, databaseName: "current-sidebar" });
    try { assert.deepEqual(await reopened.load("fixture"), document); }
    finally { reopened.close(); }
  } finally { sidebar.close(); }
});

test("React storage recovery recognizes raw identity migration failures", () => {
  assert.equal(isBrowserStorageFailure(new IndexedDbIdentityError("timeout")), true);
  assert.equal(isBrowserStorageFailure(new IndexedDbIdentityError("blocked", "upgrading")), true);
  assert.equal(isBrowserStorageFailure(new Error("broken module evaluation")), false);
});
