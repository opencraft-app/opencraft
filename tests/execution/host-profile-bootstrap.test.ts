import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import type { HostConnectionProfile } from "@opencraft/workbench-runtime";
import { openHostProfiles } from "../../apps/workbench-web/src/runtime/host-profile-bootstrap";
import { BrowserStorageError } from "../../apps/workbench-web/src/runtime/browser-storage-error";

const deployment: HostConnectionProfile = {
  hostId: "deployed", displayName: "Server", providerId: "opencraft.websocket",
  providerConfig: { url: "wss://deployed.invalid/appserver" }, providerConfigVersion: 1,
  hostKind: "durable", enabled: true, autoConnect: true, includeInSidebar: true,
  credentialRef: null, transportEndpoint: null, executionLocation: "Server",
  workspaceBrowseRoots: [], revision: 0, machineIdentity: null, agent: null,
};
const result = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});

test("a hosted no-event open still exposes deployment connections without pretending to save", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const request = new EventTarget() as IDBOpenDBRequest;
  const opening = openHostProfiles({ factory: { open: () => request } as unknown as IDBFactory,
    seed: [deployment], allowDeploymentRecovery: true });
  context.mock.timers.tick(10_000);
  const { store, storageError } = await opening;
  try {
    assert.ok(storageError);
    assert.equal(storageError?.reason, "timeout");
    assert.equal(storageError.storageDiagnostics?.stage, "opening");
    assert.deepEqual(store.getSnapshot().profiles, [deployment]);
    await assert.rejects(store.put({ ...deployment, displayName: "Unsaved", revision: 1 }), /暂时无法修改/);
    await assert.rejects(store.remove(deployment.hostId), /暂时无法修改/);
    assert.equal(store.getSnapshot().profiles[0]?.displayName, "Server");
    let closed = 0;
    Object.defineProperty(request, "result", { value: { close: () => ++closed } });
    request.dispatchEvent(new Event("success"));
    assert.equal(closed, 1, "a late result must not overwrite the recovery projection");
  } finally { store.close(); }
});

test("blocked hosted recovery never overwrites saved profiles and reload restores them", async () => {
  const factory = new IDBFactory();
  const legacy = factory.open("profiles", 1);
  legacy.onupgradeneeded = () => legacy.result.createObjectStore("profiles", { keyPath: "hostId" });
  const db = await result(legacy);
  const saved = { ...deployment, displayName: "My existing configuration", revision: 7 };
  const transaction = db.transaction("profiles", "readwrite");
  const committed = new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error); });
  transaction.objectStore("profiles").put(saved); await committed;
  const recovered = await openHostProfiles({ factory, databaseName: "profiles", seed: [deployment], allowDeploymentRecovery: true });
  assert.equal(recovered.storageError?.reason, "blocked");
  recovered.store.close(); db.close();
  const retry = await openHostProfiles({ factory, databaseName: "profiles", seed: [deployment], allowDeploymentRecovery: true });
  try {
    assert.equal(retry.storageError, null);
    assert.equal(retry.store.getSnapshot().profiles[0]?.displayName, saved.displayName);
    assert.equal(retry.store.getSnapshot().profiles[0]?.revision, 7);
  } finally { retry.store.close(); }
});

test("standalone and hostless clients retain visible storage failure", async () => {
  const factory = { open: () => { throw new DOMException("Unavailable", "SecurityError"); } } as unknown as IDBFactory;
  for (const options of [{ seed: [deployment], allowDeploymentRecovery: false }, { seed: [], allowDeploymentRecovery: true }]) {
    await assert.rejects(openHostProfiles({ factory, ...options }), BrowserStorageError);
  }
});

test("invalid stored configuration is not hidden by hosted recovery", async () => {
  const factory = new IDBFactory();
  const req = factory.open("profiles", 2);
  req.onupgradeneeded = () => { req.result.createObjectStore("profiles", { keyPath: "hostId" }); req.result.createObjectStore("machines"); };
  const db = await result(req);
  const transaction = db.transaction("profiles", "readwrite");
  const committed = new Promise<void>(resolve => { transaction.oncomplete = () => resolve(); });
  transaction.objectStore("profiles").put({ hostId: "invalid" }); await committed; db.close();
  await assert.rejects(openHostProfiles({ factory, databaseName: "profiles", seed: [deployment], allowDeploymentRecovery: true }), TypeError);
});
