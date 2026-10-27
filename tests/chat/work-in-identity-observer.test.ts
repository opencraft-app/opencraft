import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB } from "fake-indexeddb";
import { HostRuntimeRegistry, type HostConnectionProfile } from "@opencraft/workbench-runtime";
import { HostMachineIdentityObserver } from "../../apps/workbench-web/src/runtime/host-machine-identity";
import { IndexedDbHostConnectionProfileStore } from "../../apps/workbench-web/src/runtime/indexeddb-host-profile-store";
const machine = { machineId: "12345678-1234-4123-8123-123456789abc", name: "machine", platform: "linux" as const };
const profile: HostConnectionProfile = { hostId: "local", displayName: "OpenCraft", providerId: "fake", providerConfig: {}, providerConfigVersion: 1, hostKind: "local", enabled: true, autoConnect: false, includeInSidebar: true, credentialRef: null, transportEndpoint: null, executionLocation: null, workspaceBrowseRoots: [], revision: 0 };
function deferred() { let resolve!: (value: unknown) => void, reject!: (error: unknown) => void; const promise = new Promise<unknown>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
async function fixture() {
  const store = await IndexedDbHostConnectionProfileStore.open({ factory: indexedDB, databaseName: `identity-${crypto.randomUUID()}`, seed: [profile] });
  const registration = { descriptor: { hostId: "local", label: "OpenCraft", kind: "local" as const, transportEndpoint: null, executionLocation: null, workspaceBrowseRoots: [] }, createRuntime: () => ({ async connect() {}, async dispose() {} }) };
  const registry = new HostRuntimeRegistry([registration]); const observer = new HostMachineIdentityObserver(registry, store);
  return { store, registry, observer, registration, async close() { observer.dispose(); store.close(); await registry.dispose(); } };
}
for (const late of ["unsupported", "timeout", "old-success"]) test(`late probe ${late} cannot replace a normal connection's newer identity`, async () => {
  const f = await fixture(), held = deferred();
  try {
    const probe = f.observer.read(profile, () => held.promise);
    const nextMachine = { ...machine, machineId: "22345678-1234-4123-8123-123456789abc" };
    await f.observer.read(profile, () => Promise.resolve({ machine: nextMachine, agent: "Codex" }));
    if (late === "old-success") held.resolve({ machine, agent: "OpenCraft" });
    else held.reject(late === "unsupported" ? { code: -32601 } : new Error("timeout"));
    await probe;
    assert.deepEqual(f.store.getSnapshot().profiles[0]!.machineIdentity, nextMachine);
    assert.equal(f.store.getSnapshot().profiles[0]!.agent, "Codex");
  } finally { await f.close(); }
});

test("a deleted and re-registered Host rejects observations from the previous registration", async () => {
  const f = await fixture(), held = deferred();
  try {
    const old = f.observer.read(profile, () => held.promise);
    await f.registry.remove("local"); f.registry.register(f.registration);
    held.resolve({ machine, agent: "OpenCraft" }); await old;
    assert.equal(f.store.getSnapshot().profiles[0]!.machineIdentity, null);
  } finally { await f.close(); }
});

test("temporary failures keep the last report; current method-not-found clears it", async () => {
  const f = await fixture();
  try {
    await f.observer.read(profile, () => Promise.resolve({ machine, agent: "OpenCraft" }));
    await f.observer.read(profile, () => Promise.reject(new Error("disconnected")));
    assert.deepEqual(f.store.getSnapshot().profiles[0]!.machineIdentity, machine);
    await f.observer.read(profile, () => Promise.reject({ code: -32601 }));
    assert.equal(f.store.getSnapshot().profiles[0]!.machineIdentity, null);
  } finally { await f.close(); }
});
