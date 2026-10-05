import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopConnection } from "../plugins/cloud-desktop/src/contract";
import type { DesktopRfbSession, RfbDesktopAdapter } from "../plugins/cloud-desktop/src/rfb";
import type { LightVelaAccountSnapshot } from "../plugins/lightvela-platform/src/account/lightvela-account-service";
import { LightVelaDesktopBackend, type LightVelaDesktopBinding, type LightVelaDesktopViewerAttachment,
  type LightVelaDesktopViewerPort } from "../plugins/lightvela-platform/src/desktop";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function fixture() {
  let binding: LightVelaDesktopBinding | null = { target: { conversationId: "thread:a", serverId: "server:a",
    environmentId: "env:a", principalId: "account:a" }, instanceId: "instance/a", region: "cn", viewingAllowed: true, revision: "binding:1" };
  let state = { session: { status: "authenticated", epoch: 1 }, region: "cn", authGeneration: 1,
    details: { profile: { id: "account:a" } }, activeBotId: "wrong-active-bot" } as LightVelaAccountSnapshot;
  const accounts = new Set<() => void>(), directories = new Set<() => void>();
  const calls: string[] = [];
  const requests: { path: string; method: string; signal?: AbortSignal | null }[] = [];
  let resource: unknown = { resource_id: "instance/a", generation_id: "prepare:1", state: "prepared" };
  const account = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { accounts.add(listener); return () => { accounts.delete(listener); }; },
    async request<T>(path: string, init?: RequestInit): Promise<T> {
      requests.push({ path, method: init?.method ?? "GET", signal: init?.signal }); return resource as T;
    },
  };
  const directory = { resolve: () => binding,
    subscribe: (listener: () => void) => { directories.add(listener); return () => { directories.delete(listener); }; } };
  const session: DesktopRfbSession = { openChannel: () => { throw new Error("external transport boundary"); },
    close: () => { calls.push("session:close"); } };
  const connection: DesktopConnection = { getSnapshot: () => ({ videoReady: true, inputReady: true, controlAvailable: false, ended: false }),
    subscribe: () => () => {}, requestControl: async () => { throw new Error("observe only"); },
    close: () => { calls.push("connection:close"); } };
  const media: RfbDesktopAdapter = { connect: async received => { assert.equal(received, session); calls.push("media:connect"); return connection; },
    surfaces: { mount: () => { throw new Error("product must not mount UI"); } } };
  const grant: LightVelaDesktopViewerAttachment = { target: binding.target, instanceId: "instance/a", resourceId: "instance/a",
    preparationGenerationId: "prepare:1", incarnation: "physical:7",
    open: async () => { calls.push("viewer:open"); return session; }, release: () => { calls.push("viewer:release"); } };
  const viewer: LightVelaDesktopViewerPort = { acquire: async (received, resource) => {
    assert.equal(received.instanceId, "instance/a"); assert.equal(resource.preparationGenerationId, "prepare:1");
    calls.push("viewer:acquire"); return grant;
  } };
  return { account, directory, viewer, media, grant, session, connection, calls, requests, accounts, directories,
    target: binding.target, binding,
    backend: () => new LightVelaDesktopBackend({ account, directory, viewer, media, pollIntervalMs: 1 }),
    resource(value: unknown) { resource = value; },
    bind(value: LightVelaDesktopBinding | null) { binding = value; for (const listener of directories) listener(); },
    accountState(patch: Partial<LightVelaAccountSnapshot>) { state = { ...state, ...patch }; for (const listener of accounts) listener(); },
  };
}

test("Vela without an authorized viewer port advertises nothing and never prepares", async () => {
  const f = fixture(); const backend = new LightVelaDesktopBackend({ account: f.account, directory: f.directory, media: f.media });
  assert.equal(backend.resolveTarget("thread:a"), null);
  await assert.rejects(backend.prepare(f.target, new AbortController().signal));
  assert.deepEqual(f.requests, []); backend.dispose();
  assert.equal(f.accounts.size, 0); assert.equal(f.directories.size, 0);
});

test("Vela resolves exact binding, not active Bot, prepares once and preserves physical identity", async () => {
  const f = fixture(), backend = f.backend();
  assert.equal(backend.resolveTarget("thread:b"), null);
  const attachment = await backend.prepare(f.target, new AbortController().signal);
  assert.equal(attachment.incarnation, "physical:7"); assert.notEqual(attachment.incarnation, "prepare:1");
  assert.deepEqual(f.requests.map(({path, method}) => ({path, method})), [
    { path: "/v1/instances/instance%2Fa/desktop/resource", method: "POST" },
  ]);
  assert.equal(await attachment.connect(new AbortController().signal), f.connection);
  assert.deepEqual(f.calls, ["viewer:acquire", "viewer:open", "media:connect"]);
  attachment.release(); attachment.release(); backend.dispose();
  assert.deepEqual(f.calls.slice(-2), ["connection:close", "viewer:release"]);
});

test("Vela polls pure observation, never repeats POST, and rejects changed preparation epoch", async () => {
  const f = fixture(), backend = f.backend();
  f.resource({ resource_id: "instance/a", generation_id: "prepare:1", state: "preparing" });
  const request = f.account.request;
  f.account.request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    if (init?.method === "GET") f.resource({ resource_id: "instance/a", generation_id: "prepare:2", state: "prepared" });
    return request<T>(path, init);
  };
  await assert.rejects(backend.prepare(f.target, new AbortController().signal));
  assert.deepEqual(f.requests.map(r => r.method), ["POST", "GET"]);
  assert.deepEqual(f.calls, []); backend.dispose();
});

test("Vela rejects wrong principals, permissions, regions and targets before mutation", async () => {
  const f = fixture(), backend = f.backend();
  f.bind({ ...f.binding!, viewingAllowed: false }); assert.equal(backend.resolveTarget("thread:a"), null);
  f.bind({ ...f.binding!, region: "intl" }); assert.equal(backend.resolveTarget("thread:a"), null);
  f.bind({ ...f.binding!, target: { ...f.target, principalId: "other-account" } });
  assert.equal(backend.resolveTarget("thread:a"), null);
  f.bind(f.binding!);
  await assert.rejects(backend.prepare({ ...f.target, serverId: "wrong-server" }, new AbortController().signal));
  assert.deepEqual(f.requests, []); backend.dispose();
});

test("Vela same-account reauthentication fences late attachment acquisition", async () => {
  const f = fixture(), backend = f.backend(); const pending = deferred<LightVelaDesktopViewerAttachment>();
  const entered = deferred<void>(); let signal!: AbortSignal;
  f.viewer.acquire = (_binding, _resource, received) => { signal = received; entered.resolve(); return pending.promise; };
  const operation = backend.prepare(f.target, new AbortController().signal); await entered.promise;
  f.accountState({ authGeneration: 2 }); assert.equal(signal.aborted, true);
  pending.resolve(f.grant); await assert.rejects(operation);
  assert.deepEqual(f.calls, ["viewer:release"]); backend.dispose();
});

test("Vela credential scope replacement retires an existing viewer", async () => {
  const f = fixture(), backend = f.backend();
  const attachment = await backend.prepare(f.target, new AbortController().signal);
  await attachment.connect(new AbortController().signal);
  f.accountState({ credentialScope: "successor-credential-scope" });
  assert.deepEqual(f.calls.slice(-2), ["connection:close", "viewer:release"]);
  await assert.rejects(attachment.connect(new AbortController().signal)); backend.dispose();
});

test("Vela physical binding revision change closes existing viewers even when target is stable", async () => {
  const f = fixture(), backend = f.backend();
  const attachment = await backend.prepare(f.target, new AbortController().signal);
  await attachment.connect(new AbortController().signal);
  f.bind({ ...f.binding!, revision: "binding:2" });
  assert.deepEqual(backend.resolveTarget("thread:a"), f.target);
  assert.deepEqual(f.calls.slice(-2), ["connection:close", "viewer:release"]);
  await assert.rejects(attachment.connect(new AbortController().signal)); backend.dispose();
});

test("Vela late transport opening after attachment release closes only that session", async () => {
  const f = fixture(), backend = f.backend(); const pending = deferred<DesktopRfbSession>();
  f.grant.open = () => pending.promise;
  const attachment = await backend.prepare(f.target, new AbortController().signal);
  const connecting = attachment.connect(new AbortController().signal);
  attachment.release(); pending.resolve(f.session); await assert.rejects(connecting);
  assert.deepEqual(f.calls, ["viewer:acquire", "viewer:release", "session:close"]); backend.dispose();
});

for (const replacement of [
  { incarnation: "" }, { preparationGenerationId: "different" }, { instanceId: "other" },
  { target: { conversationId: "thread:b", serverId: "server:a", principalId: "account:a", environmentId: "env:a" } },
]) test(`Vela rejects mismatched attachment ${Object.keys(replacement)[0]} and releases it`, async () => {
  const f = fixture(), backend = f.backend();
  f.viewer.acquire = async () => ({ ...f.grant, ...replacement });
  await assert.rejects(backend.prepare(f.target, new AbortController().signal));
  assert.deepEqual(f.calls, ["viewer:release"]); backend.dispose();
});

test("Vela invalid DTOs fail at product boundary; unknown POST failure is never retried", async () => {
  const f = fixture(), backend = f.backend();
  f.resource({ resource_id: "other", generation_id: "prepare:1", state: "prepared" });
  await assert.rejects(backend.prepare(f.target, new AbortController().signal));
  assert.equal(f.calls.includes("viewer:acquire"), false);
  f.account.request = async () => { throw new Error("unknown request outcome"); };
  await assert.rejects(backend.prepare(f.target, new AbortController().signal));
  assert.equal(f.requests.length, 1); backend.dispose();
});

test("Vela dispose aborts pending preparation and unsubscribes without owning the account", async () => {
  const f = fixture(), backend = f.backend(); const pending = deferred<unknown>(); const entered = deferred<void>();
  let signal!: AbortSignal;
  f.account.request = <T>(_path: string, init?: RequestInit): Promise<T> => {
    signal = init!.signal!; entered.resolve(); return pending.promise as Promise<T>;
  };
  const operation = backend.prepare(f.target, new AbortController().signal); await entered.promise;
  backend.dispose(); backend.dispose(); assert.equal(signal.aborted, true);
  pending.resolve({ resource_id: "instance/a", generation_id: "prepare:1", state: "prepared" });
  await assert.rejects(operation); assert.equal(f.accounts.size, 0); assert.equal(f.directories.size, 0);
  assert.deepEqual(f.calls, []);
});
