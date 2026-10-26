import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { ClientResources, REMOTE_RESOURCE_LIMIT, type ClientResourcePersistence, type ClientResourceDefinition,
  type ClientResourceKey } from "../../packages/document-storage/src/client-resources.ts";
import { SqliteClientResources } from "../../packages/document-storage/src/client-resources-sqlite.ts";
import { openIndexedDbClientResources } from "../../apps/workbench-web/src/runtime/indexeddb-client-resources.ts";
import { cacheThreadCatalog, mergeCachedCatalogRows, restoreThreadCatalog, threadCatalogDisplayRows, threadCatalogResource } from "../../apps/workbench-web/src/runtime/thread-catalog-cache.ts";
import { sidebarThreadCatalogQueryKey } from "../../apps/workbench-web/src/runtime/thread-catalog-query.ts";

Object.assign(globalThis, { IDBKeyRange });
const key: ClientResourceKey = { namespace: "product/server/account-a", name: "draft", id: "thread-1", authority: "local" };
const record = (value: string, savedAt = 1) => ({ value, savedAt, version: 1 });
const currentFence = { isCurrent: () => true };
const draft: ClientResourceDefinition<string> = { name: "draft", authority: "local", version: 1,
  parse(value) { if (typeof value !== "string") throw new Error("Invalid draft"); return value; } };
const remote = { ...draft, name: "catalog", authority: "remote" as const };

for (const kind of ["sqlite", "indexeddb"] as const) {
  test(`${kind}: reopen, CAS, format fence, namespace isolation and protected originals`, async () => {
    const root = mkdtempSync(join(tmpdir(), "opencraft-client-resources-"));
    const factory = new IDBFactory();
    const open = () => kind === "sqlite" ? Promise.resolve(new SqliteClientResources(join(root, "client.sqlite")))
      : openIndexedDbClientResources("client", factory);
    let storage = await open();
    try {
      assert.equal(await storage.compareAndSet(key, 0, record("unsent original")), true);
      assert.equal(await storage.compareAndSet(key, 0, record("stale edit")), false);
      assert.equal((await storage.read(key))?.value, "unsent original");
      assert.equal(await storage.read({ ...key, namespace: "another-account" }), null);
      await storage.close(); storage = await open();
      assert.equal((await storage.read(key))?.value, "unsent original");
      assert.equal(await storage.compareAndSet(key, 1, { ...record("v2"), version: 2 }), true);
      await assert.rejects(storage.compareAndSet(key, 2, record("downgrade")));
      assert.equal((await storage.read(key))?.value, "v2");
      for (let index = 0; index < REMOTE_RESOURCE_LIMIT + 3; index++) {
        await storage.compareAndSet({ ...key, authority: "remote", id: `copy-${index}` }, 0, record("copy", index));
      }
      assert.equal(await storage.read({ ...key, authority: "remote", id: "copy-0" }), null);
      assert.equal((await storage.read(key))?.value, "v2");
      await storage.clearRemoteNamespace(key.namespace);
      assert.equal(await storage.read({ ...key, authority: "remote", id: `copy-${REMOTE_RESOURCE_LIMIT}` }), null);
      assert.equal((await storage.read(key))?.value, "v2");
      await assert.rejects(storage.compareAndSet(key, 2, record("x".repeat(1024 * 1024 + 1))));
      assert.equal((await storage.read(key))?.value, "v2");
    } finally { await storage.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test(`${kind}: shared local owner requires durable success and explicit conflict resolution`, async () => {
    const root = mkdtempSync(join(tmpdir(), "opencraft-client-owner-"));
    const storage = kind === "sqlite" ? new SqliteClientResources(join(root, "client.sqlite"))
      : await openIndexedDbClientResources("owners", new IDBFactory());
    const one = new ClientResources(Promise.resolve(storage), "account-a");
    const two = new ClientResources(Promise.resolve({ ...storage, read: storage.read.bind(storage),
      compareAndSet: storage.compareAndSet.bind(storage), clearRemoteNamespace: storage.clearRemoteNamespace.bind(storage), listLocalKeys: storage.listLocalKeys.bind(storage), clearLocalResource: storage.clearLocalResource.bind(storage), close() {} }), "account-a");
    try {
      const first = one.local(draft, "draft-1"), stale = two.local(draft, "draft-1");
      await Promise.all([first.ready, stale.ready]);
      await first.commit("saved input", 0, currentFence);
      assert.equal(first.getSnapshot().revision, 1);
      await assert.rejects(stale.commit("retain my edit", 0, currentFence), /conflict/);
      assert.equal(stale.getSnapshot().value, null);
      await stale.reload();
      assert.equal(stale.getSnapshot().value, "saved input");
      await stale.commit("merged input", 1, currentFence);
      await first.reload();
      assert.equal(first.getSnapshot().value, "merged input");
      assert.throws(() => one.remote(draft, "draft-1"), /authority mismatch/);
    } finally { await two.close(); await one.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

test("remote projection survives a new offline application and a failed refresh; complete empty response replaces it", async () => {
  const factory = new IDBFactory();
  const first = new ClientResources(openIndexedDbClientResources("catalog", factory), "server/account-a");
  const cached = first.remote(threadCatalogResource, "host:revision-1");
  await cached.ready;
  await cached.observe(cacheThreadCatalog([{ id: "saved", title: "Saved title", project: "project", lineage: "root", updatedAt: 42,
    status: "running", time: "Now", pinned: true }], true), currentFence);
  await first.close();
  const offline = new ClientResources(openIndexedDbClientResources("catalog", factory), "server/account-a");
  try {
    const restored = offline.remote(threadCatalogResource, "host:revision-1");
    await restored.ready;
    assert.equal(restored.getSnapshot().value?.rows[0]?.title, "Saved title");
    assert.equal(restoreThreadCatalog(restored.getSnapshot().value)[0]?.status, "ready");
    const otherHost = offline.remote(threadCatalogResource, "host:revision-2");
    await otherHost.ready; assert.equal(otherHost.getSnapshot().value, null);
    const partial = [{ ...restoreThreadCatalog(restored.getSnapshot().value)[0]!, id: "new" }];
    assert.deepEqual(mergeCachedCatalogRows(partial, restored.getSnapshot().value, false).map(row => row.id), ["new", "saved"]);
    assert.deepEqual(threadCatalogDisplayRows(partial, restored.getSnapshot().value, false).map(row => [row.thread.id, row.confirmed]), [["new", true], ["saved", false]]);
    assert.equal(threadCatalogDisplayRows(undefined, restored.getSnapshot().value, false)[0]?.confirmed, false);
    assert.deepEqual(mergeCachedCatalogRows([], restored.getSnapshot().value, true), []);
    await restored.observe(cacheThreadCatalog([], true), currentFence);
    assert.deepEqual(restored.getSnapshot().value?.rows, []);
  } finally { await offline.close(); }
});

test("quota failure rejects local commit, but a remote observation remains usable with a visible persistence error", async () => {
  const quota = new Error("QuotaExceededError");
  const storage: ClientResourcePersistence = { read: async () => null, compareAndSet: async () => { throw quota; }, clearRemoteNamespace: async () => {}, listLocalKeys: async () => [], clearLocalResource: async () => {}, close() {} };
  const resources = new ClientResources(Promise.resolve(storage), "account");
  const local = resources.local(draft, "draft"), copy = resources.remote(remote, "list");
  await Promise.all([local.ready, copy.ready]);
  await assert.rejects(local.commit("keep this input", 0, currentFence), error => error === quota);
  assert.equal(local.getSnapshot().value, null);
  assert.equal(local.getSnapshot().error, quota);
  await copy.observe("fresh server data", currentFence);
  assert.equal(copy.getSnapshot().value, "fresh server data");
  assert.equal(copy.getSnapshot().error, quota);
  await resources.close();
});

test("scope revocation clears memory immediately and orders cleanup after an in-flight write", async () => {
  const events: string[] = [];
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const storage: ClientResourcePersistence = {
    read: async () => null,
    compareAndSet: async key => { events.push(`write:${key.namespace}`); entered(); await gate; events.push("committed"); return true; },
    clearRemoteNamespace: async namespace => { events.push(`clear:${namespace}`); }, listLocalKeys: async () => [], clearLocalResource: async () => {}, close() {},
  };
  const resources = new ClientResources(Promise.resolve(storage), "a");
  const old = resources.remote(remote, "catalog"); await old.ready;
  const pending = old.observe("old-account-title", currentFence); await started;
  resources.setNamespace("b");
  assert.equal(old.getSnapshot().value, null);
  await assert.rejects(old.observe("late old title", currentFence), /revoked/);
  const current = resources.remote(remote, "catalog");
  release(); await pending; await current.ready;
  assert.equal(current.getSnapshot().value, null);
  assert.deepEqual(events, ["write:a", "committed", "clear:a"]);
  assert.notDeepEqual(sidebarThreadCatalogQueryKey("h", { revision: 1, authorizationEpoch: null, clientEpoch: 0 }),
    sidebarThreadCatalogQueryKey("h", { revision: 1, authorizationEpoch: null, clientEpoch: 1 }));
  await resources.close();
});

test("fence rejection happens before a remote projection is published or a local write is accepted", async () => {
  const storage: ClientResourcePersistence = {
    read: async () => null, compareAndSet: async () => true,
    clearRemoteNamespace: async () => {}, listLocalKeys: async () => [], clearLocalResource: async () => {}, close() {},
  };
  const resources = new ClientResources(Promise.resolve(storage), "account");
  const remoteResource = resources.remote(remote, "catalog");
  const localResource = resources.local(draft, "draft");
  await Promise.all([remoteResource.ready, localResource.ready]);
  const revoked = { isCurrent: () => false };
  await assert.rejects(remoteResource.observe("late", revoked), /scope changed/);
  assert.equal(remoteResource.getSnapshot().value, null);
  await assert.rejects(localResource.commit("late", 0, revoked), /scope changed/);
  assert.equal(localResource.getSnapshot().value, null);
  await resources.close();
});
