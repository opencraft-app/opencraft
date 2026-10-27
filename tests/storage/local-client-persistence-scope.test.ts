import assert from "node:assert/strict";
import test from "node:test";
import { LocalClientPersistenceScope } from "../../apps/workbench-web/src/runtime/local-client-persistence-scope";
import { PlatformAccountContributionRegistry } from "../../apps/workbench-web/src/runtime/platform-account-contributions";
import type { PlatformAccountSnapshot } from "@opencraft/extension-react";

const owner = { extensionId: "fixture.account", activationId: "fixture", generation: 1 };
const anonymous: PlatformAccountSnapshot = { revision: 0, phase: "anonymous", name: null, avatarUrl: null, planLabel: null, usageRemainingPercent: null, error: null };

test("public local caches are stable across application recreation and partitioned by server", () => {
  const accounts = new PlatformAccountContributionRegistry();
  const first = new LocalClientPersistenceScope(accounts, "server:a:local");
  const saved = first.getSnapshot(); first.dispose();
  const reopened = new LocalClientPersistenceScope(accounts, "server:a:local");
  const other = new LocalClientPersistenceScope(accounts, "server:b:local");
  assert.deepEqual(reopened.getSnapshot(), saved);
  assert.notEqual(other.getSnapshot().namespace, saved.namespace);
  reopened.dispose(); other.dispose();
});

test("account changes synchronously fence a local cache; profile refresh does not", async () => {
  const accounts = new PlatformAccountContributionRegistry();
  const scope = new LocalClientPersistenceScope(accounts);
  const listeners = new Set<() => void>();
  let snapshot = anonymous;
  const contribution = { id: "fixture.account", viewId: "fixture.view", getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }, async refresh() {} };
  const prepared = await accounts.createAdapter().prepare(owner, contribution);
  const release = await prepared.commit();
  const observations: string[] = [];
  scope.subscribe(() => observations.push(scope.getSnapshot().namespace));
  const publish = (value: PlatformAccountSnapshot) => { snapshot = value; for (const listener of listeners) listener(); };
  publish({ ...anonymous, phase: "authenticated", readStateScope: "account-a", identity: { id: "id-a", handle: "a" } });
  const active = scope.getSnapshot();
  assert.equal(observations.at(-1), active.namespace);
  publish({ ...snapshot, revision: 2, name: "Updated profile" });
  assert.equal(scope.getSnapshot(), active);
  assert.equal(observations.length, 1);
  publish({ ...snapshot, phase: "anonymous", readStateScope: null });
  assert.notEqual(scope.getSnapshot().namespace, active.namespace, "explicit null cannot fall back to the old identity");
  const retiredCallbacks = [...listeners];
  release();
  const retired = scope.getSnapshot();
  snapshot = { ...snapshot, readStateScope: "late-retired-account" };
  for (const callback of retiredCallbacks) callback();
  assert.equal(scope.getSnapshot(), retired, "queued callbacks from a retired account cannot change the new partition");
  const count = observations.length;
  scope.dispose();
  assert.equal(listeners.size, 0);
  release();
  assert.equal(observations.length, count, "disposed owner receives no registry or account changes");
});

test("offline discovery restores only a remembered local partition; explicit logout clears it", async () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const accounts = new PlatformAccountContributionRegistry();
  const listeners = new Set<() => void>();
  let snapshot: PlatformAccountSnapshot = { ...anonymous, phase: "authenticated", readStateScope: "account-a", identity: { id: "a", handle: "a" } };
  const contribution = { id: "fixture.account", viewId: "fixture.view", getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }, async refresh() {} };
  const prepared = await accounts.createAdapter().prepare(owner, contribution); const release = await prepared.commit();
  const first = new LocalClientPersistenceScope(accounts, "server:a", storage);
  const namespace = first.getSnapshot().namespace; assert.equal(first.isVerified(), true); first.dispose();
  release();
  const reopened = new LocalClientPersistenceScope(accounts, "server:a", storage);
  assert.equal(reopened.getSnapshot().namespace, namespace); assert.equal(reopened.isVerified(), false);
  snapshot = { ...anonymous, phase: "error" };
  const rebound = await accounts.createAdapter().prepare(owner, contribution); const stop = await rebound.commit();
  assert.equal(reopened.getSnapshot().namespace, namespace); assert.equal(reopened.isVerified(), false);
  snapshot = { ...anonymous, phase: "authenticated", readStateScope: "account-a", identity: { id: "a", handle: "a" } };
  for (const listener of listeners) listener();
  assert.equal(reopened.getSnapshot().namespace, namespace); assert.equal(reopened.isVerified(), true);
  snapshot = { ...anonymous, readStateScope: null }; for (const listener of listeners) listener();
  assert.notEqual(reopened.getSnapshot().namespace, namespace); assert.equal(reopened.isVerified(), false);
  assert.equal(values.size, 0); reopened.dispose(); stop();
});
