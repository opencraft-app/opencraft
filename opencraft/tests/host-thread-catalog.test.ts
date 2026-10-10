import assert from "node:assert/strict";
import test from "node:test";
import { HostRuntimeRegistry, type AppServerWorkbenchRuntime, type HostConnectionProfile } from "@opencraft/workbench-runtime";
import type { SshConnectionView } from "@opencraft/app-host-protocol";
import { canReadHostThreadCatalog, readHostThreadCatalog, type ManagedHostCatalogSnapshot } from "../apps/workbench-web/src/runtime/host-thread-catalog.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const profile: HostConnectionProfile = {
  hostId: "ssh:fixture", displayName: "Fixture", providerId: "fixture", providerConfig: {}, providerConfigVersion: 1,
  hostKind: "remote-ssh", enabled: true, autoConnect: false, includeInSidebar: true, revision: 1,
  credentialRef: null, transportEndpoint: null, executionLocation: "Fixture", workspaceBrowseRoots: ["/remote"],
};
const row: SshConnectionView = { serverId: profile.hostId, displayName: "Fixture", workspaceBrowseRoots: ["/remote"],
  revision: 1, enabled: true, hostname: "fixture.invalid", port: 22, username: "fixture", fingerprint: `SHA256:${"a".repeat(43)}`, state: "open" };

function harness(initialProfile: HostConnectionProfile = profile) {
  let current: HostConnectionProfile | undefined = initialProfile;
  let snapshot: ManagedHostCatalogSnapshot = { available: true, authenticated: true, items: [row], legacyServers: [], refreshing: false, error: null };
  let authorizationEpoch = 0;
  const calls: string[] = [];
  let phase = "idle";
  let connectGate: Promise<void> = Promise.resolve(), listGate: Promise<void> = Promise.resolve();
  const runtime = {
    getSnapshot: () => ({ phase }),
    async connect() { calls.push("connect"); phase = "connecting"; await connectGate; phase = "ready"; },
    async dispose() { calls.push("dispose"); phase = "disposed"; },
    resources: { threads: { async list(params: unknown) { calls.push("thread/list");
      assert.deepEqual(params, { cursor: null, limit: 50 }); await listGate; return { data: [{ id: "same-native-id" }], nextCursor: null }; } } },
  } as unknown as AppServerWorkbenchRuntime;
  const registry = new HostRuntimeRegistry([{ descriptor: { hostId: profile.hostId, label: "Fixture", kind: "remote-ssh",
    transportEndpoint: null, executionLocation: "Fixture", workspaceBrowseRoots: ["/remote"] }, createRuntime: () => runtime }]);
  const source = { getSnapshot: () => snapshot, getAuthorizationEpoch: () => authorizationEpoch, subscribe: () => () => {}, refresh: async () => {} };
  return { calls, registry, source, read: () => readHostThreadCatalog({ profile: initialProfile, currentProfile: () => current, management: source, registry }),
    setCurrent: (value: HostConnectionProfile | undefined) => { current = value; },
    setSnapshot: (value: Partial<ManagedHostCatalogSnapshot>) => { snapshot = { ...snapshot, ...value }; },
    nextAuthorization: () => { authorizationEpoch++; },
    holdConnect: (gate: Promise<void>) => { connectGate = gate; }, holdList: (gate: Promise<void>) => { listGate = gate; } };
}

test("an enabled but idle SSH recipe does not dial merely to discover history", async () => {
  const h = harness(); h.setSnapshot({ items: [{ ...row, state: "idle" }] });
  await assert.rejects(h.read(), /不可读取会话/);
  assert.deepEqual(h.calls, []); assert.equal(h.registry.peekRuntime(profile.hostId), null);
  await h.registry.dispose();
});

test("an explicitly open backend admits a logical catalog reader with no Thread activation", async () => {
  const h = harness(), gate = deferred(); h.holdConnect(gate.promise);
  const first = h.read(), second = h.read();
  assert.deepEqual(h.calls, ["connect"]); gate.resolve();
  const pages = await Promise.all([first, second]);
  assert.equal(pages[0].data[0]?.id, "same-native-id");
  assert.deepEqual(h.calls, ["connect", "thread/list", "thread/list"]);
  await h.registry.dispose();
});

test("lock or delete during logical attachment prevents the subsequent Thread read", async () => {
  for (const change of ["lock", "delete"] as const) {
    const h = harness(), gate = deferred(); h.holdConnect(gate.promise);
    const pending = h.read();
    h.setSnapshot(change === "lock" ? { authenticated: false } : { items: [] });
    gate.resolve(); await assert.rejects(pending, /不可读取会话/);
    assert.deepEqual(h.calls, ["connect"]); await h.registry.dispose();
  }
});

test("revocation, disablement and recipe replacement fence late catalog replies", async () => {
  for (const change of ["lock", "disable", "revision", "remove"] as const) {
    const h = harness(), gate = deferred(); h.holdList(gate.promise);
    const pending = h.read(); await new Promise(resolve => setImmediate(resolve));
    assert.ok(h.calls.includes("thread/list"));
    if (change === "lock") h.setSnapshot({ authenticated: false });
    if (change === "disable") h.setCurrent({ ...profile, enabled: false });
    if (change === "revision") h.setCurrent({ ...profile, revision: 2 });
    if (change === "remove") h.setCurrent(undefined);
    gate.resolve(); await assert.rejects(pending, /不可读取会话/); await h.registry.dispose();
  }
});

test("logout followed by unlock cannot publish an old authorization's late history", async () => {
  const h = harness(), gate = deferred(); h.holdList(gate.promise);
  const pending = h.read(); await new Promise(resolve => setImmediate(resolve));
  h.nextAuthorization(); // The new session can be authenticated with the same public config.
  gate.resolve(); await assert.rejects(pending, /不可读取会话/); await h.registry.dispose();
});

test("local discovery, explicit logical selection and static SSH compatibility retain their admission rules", () => {
  const management = { available: true, authenticated: true, items: [{ ...row, state: "idle" as const }], legacyServers: [], refreshing: false, error: null };
  assert.equal(canReadHostThreadCatalog(profile, "ready", management), true);
  assert.equal(canReadHostThreadCatalog(profile, "idle", management), false);
  assert.equal(canReadHostThreadCatalog(profile, "ready", { ...management, authenticated: false }), false);
  assert.equal(canReadHostThreadCatalog(profile, "ready", { ...management, items: [] }), false);
  assert.equal(canReadHostThreadCatalog(profile, "ready", { ...management, items: [], legacyServers: [row] }), true);
  assert.equal(canReadHostThreadCatalog(profile, "idle", null), false);
  assert.equal(canReadHostThreadCatalog({ ...profile, hostKind: "local", autoConnect: true }, "idle", null), true);
});

test("one Server's open state cannot admit another Server's history", () => {
  const management = { available: true, authenticated: true, items: [row], legacyServers: [], refreshing: false, error: null };
  assert.equal(canReadHostThreadCatalog({ ...profile, hostId: "ssh:second" }, "idle", management), false);
  assert.equal(canReadHostThreadCatalog(profile, "idle", management), true);
});

test("SSH logout does not invalidate an unrelated local Host's in-flight catalog", async () => {
  const h = harness({ ...profile, hostKind: "local", autoConnect: true }), gate = deferred(); h.holdList(gate.promise);
  const pending = h.read(); await new Promise(resolve => setImmediate(resolve));
  h.nextAuthorization(); h.setSnapshot({ authenticated: false, items: [] });
  gate.resolve(); assert.equal((await pending).data[0]?.id, "same-native-id"); await h.registry.dispose();
});
