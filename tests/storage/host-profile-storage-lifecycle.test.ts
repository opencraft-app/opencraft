import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { IDBFactory } from "fake-indexeddb";
import { BrowserStorageError } from "../../apps/workbench-web/src/runtime/browser-storage-error";
import { IndexedDbHostConnectionProfileStore } from "../../apps/workbench-web/src/runtime/indexeddb-host-profile-store";
import type { HostConnectionProfile } from "@opencraft/workbench-runtime";

const profile: HostConnectionProfile = {
  hostId: "saved-host", displayName: "Saved server", providerId: "opencraft.websocket",
  providerConfig: { url: "wss://saved.example/appserver" }, providerConfigVersion: 1,
  hostKind: "durable", enabled: true, autoConnect: false, includeInSidebar: true,
  credentialRef: null, transportEndpoint: null, executionLocation: "Saved server",
  workspaceBrowseRoots: ["/workspace"], revision: 4, machineIdentity: null, agent: null,
};

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

test("an old page blocking v1 -> v2 fails visibly; retry preserves the saved profile", async () => {
  const factory = new IDBFactory();
  const legacyRequest = factory.open("profiles", 1);
  legacyRequest.onupgradeneeded = () => legacyRequest.result.createObjectStore("profiles", { keyPath: "hostId" });
  const legacy = await result(legacyRequest);
  const write = legacy.transaction("profiles", "readwrite");
  const committed = new Promise<void>((resolve, reject) => {
    write.oncomplete = () => resolve(); write.onabort = () => reject(write.error);
  });
  write.objectStore("profiles").put(profile);
  await committed;
  try {
    await assert.rejects(IndexedDbHostConnectionProfileStore.open({ databaseName: "profiles", factory }),
      (error: unknown) => error instanceof BrowserStorageError && error.reason === "blocked"
        && error.storageDiagnostics?.oldVersion === 1
        && error.storageDiagnostics?.newVersion === 2);
  } finally { legacy.close(); }
  // The rejected request's delayed upgrade is aborted before the retry runs.
  const retry = await IndexedDbHostConnectionProfileStore.open({ databaseName: "profiles", factory });
  assert.equal(retry.getSnapshot().profiles[0]?.displayName, "Saved server");
  assert.equal(retry.getSnapshot().profiles[0]?.revision, 4);
  retry.close();
});

test("an active profile store releases its connection for a later schema upgrade", async () => {
  const factory = new IDBFactory();
  const store = await IndexedDbHostConnectionProfileStore.open({ databaseName: "profiles", factory, seed: [profile] });
  const upgrade = factory.open("profiles", 3);
  const upgraded = await result(upgrade);
  try {
    await assert.rejects(store.put({ ...profile, revision: 5 }), /store is closed/);
    const rows = await result(upgraded.transaction("profiles").objectStore("profiles").getAll());
    assert.equal(rows[0].revision, 4);
  } finally { upgraded.close(); }
});

test("a pending open has a deadline and a late database handle is closed", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const request = new EventTarget() as IDBOpenDBRequest;
  const factory = { open: () => request } as unknown as IDBFactory;
  const opening = IndexedDbHostConnectionProfileStore.open({ factory });
  const rejection = assert.rejects(opening,
    (error: unknown) => error instanceof BrowserStorageError && error.reason === "timeout"
      && error.storageDiagnostics?.stage === "opening"
      && error.storageDiagnostics?.requestedVersion === 2
      && !JSON.stringify(error.storageDiagnostics).includes("saved.example"));
  context.mock.timers.tick(10_000);
  await rejection;
  let closed = 0;
  Object.defineProperty(request, "result", { value: { close: () => { ++closed; } } });
  request.dispatchEvent(new Event("success"));
  assert.equal(closed, 1);
});

test("unavailable browser storage enters the same recoverable failure boundary", async () => {
  const cause = new DOMException("Storage disabled", "SecurityError");
  await assert.rejects(IndexedDbHostConnectionProfileStore.open({
    factory: { open: () => { throw cause; } } as unknown as IDBFactory,
  }), (error: unknown) => error instanceof BrowserStorageError
    && error.reason === "unavailable" && error.cause === cause);
});

test("a timed-out request cannot later create or migrate object stores", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const request = new EventTarget() as IDBOpenDBRequest;
  const opening = IndexedDbHostConnectionProfileStore.open({ factory: { open: () => request } as unknown as IDBFactory });
  const rejected = assert.rejects(opening, BrowserStorageError);
  context.mock.timers.tick(10_000);
  await rejected;
  let aborted = 0;
  Object.defineProperty(request, "transaction", { value: { abort: () => { ++aborted; } } });
  request.dispatchEvent(new Event("upgradeneeded"));
  assert.equal(aborted, 1);
});

test("failed initial profile loading releases the database for a clean retry", async () => {
  const factory = new IDBFactory();
  const duplicate = { ...profile, displayName: "Duplicate activation" };
  await assert.rejects(IndexedDbHostConnectionProfileStore.open({ factory, seed: [profile], ephemeral: [duplicate] }), /conflicts/);
  const deletion = factory.deleteDatabase("opencraft-host-connections");
  await result(deletion);
  await setImmediate();
});

// A browser can stall during migration as well as before its first IDB event.
test("timeout identifies a migration that started, without exposing profile data", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const request = new EventTarget() as IDBOpenDBRequest;
  Object.defineProperty(request, "result", { value: { objectStoreNames: { contains: () => true } } });
  const opening = IndexedDbHostConnectionProfileStore.open({ databaseName: "fixture-schema-upgrade", factory: { open: () => request } as unknown as IDBFactory });
  const rejected = assert.rejects(opening, (error: unknown) => error instanceof BrowserStorageError
    && error.storageDiagnostics?.stage === "upgrading"
    && error.storageDiagnostics.oldVersion === 1
    && error.storageDiagnostics.newVersion === 2);
  const upgrade = new Event("upgradeneeded");
  Object.assign(upgrade, { oldVersion: 1, newVersion: 2 });
  request.dispatchEvent(upgrade);
  context.mock.timers.tick(10_000);
  await rejected;
});
