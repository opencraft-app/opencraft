import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteClientResources } from "@opencraft/document-storage/client-resources-sqlite";
import { createDesktopClientResourcePort } from "../../apps/workbench-electron/src/client-resource-port.js";

const key = { namespace: "account-a", name: "thread-catalog", id: "host-1", authority: "remote" } as const;
const record = { version: 2, savedAt: 1, value: { rows: [], complete: true } };

test("desktop port rejects unsupported domains, local authority and malformed IPC before opening storage", () => {
  const port = createDesktopClientResourcePort(() => { throw new Error("Storage must not open"); });
  for (const input of [null, [], {}, { ...key, name: "drafts" }, { ...key, authority: "local" }, { ...key, namespace: "" }, { ...key, id: 1 }]) {
    assert.throws(() => port.read(input), TypeError);
    assert.throws(() => port.compareAndSet(input, 0, record), TypeError);
  }
  for (const value of [null, [], {}, { ...record, version: 1 }, { ...record, value: undefined }, { ...record, savedAt: -1 }]) {
    assert.throws(() => port.compareAndSet(key, 0, value), TypeError);
  }
  assert.throws(() => port.compareAndSet(key, -1, record), TypeError);
  assert.throws(() => port.compareAndSet(key, "0", record), TypeError);
  for (const namespace of [null, {}, "", "a".repeat(4097)]) assert.throws(() => port.clearRemoteNamespace(namespace), TypeError);
});

test("desktop catalog port retains CAS and restart recovery; cleanup cannot delete originals or other domains/accounts", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-desktop-resource-port-"));
  const path = join(root, "resources.sqlite");
  let store = new SqliteClientResources(path);
  const port = createDesktopClientResourcePort(() => store);
  const original = { ...key, authority: "local" } as const;
  const otherDomain = { ...key, name: "other-projection" };
  const otherAccount = { ...key, namespace: "account-b" };
  try {
    await store.compareAndSet(original, 0, record);
    await store.compareAndSet(otherDomain, 0, record);
    await port.compareAndSet(otherAccount, 0, record);
    assert.equal(await port.compareAndSet(key, 0, record), true);
    assert.equal(await port.compareAndSet(key, 0, record), false);
    store.close();
    store = new SqliteClientResources(path);
    assert.deepEqual(await port.read(key), { ...record, revision: 1 });
    assert.throws(() => port.compareAndSet(original, 1, { ...record, value: null }), TypeError);
    await port.clearRemoteNamespace(key.namespace);
    assert.equal(await port.read(key), null);
    assert.deepEqual(await store.read(original), { ...record, revision: 1 });
    assert.deepEqual(await store.read(otherDomain), { ...record, revision: 1 });
    assert.deepEqual(await port.read(otherAccount), { ...record, revision: 1 });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop local ports admit only implemented original domains and explicit domain cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-desktop-local-port-"));
  const store = new SqliteClientResources(join(root, "resources.sqlite"));
  const port = createDesktopClientResourcePort(() => store);
  try {
    for (const name of ["conversation-draft", "composer-draft", "conversation-outbox"]) {
      const identity = { ...key, name, authority: "local" };
      assert.equal(await port.compareAndSet(identity, 0, { version: 1, savedAt: 1, value: "original" }), true);
      assert.equal((await port.read(identity))?.value, "original");
      assert.throws(() => port.compareAndSet(identity, 1, { version: 1, savedAt: 1, value: { token: "not a local document" } }), TypeError);
    }
    await port.clearRemoteNamespace(key.namespace);
    assert.equal((await port.listLocalKeys(key.namespace, "conversation-draft")).length, 1);
    await port.clearLocalResource(key.namespace, "conversation-draft");
    assert.equal((await port.listLocalKeys(key.namespace, "conversation-draft")).length, 0);
    assert.equal((await port.listLocalKeys(key.namespace, "composer-draft")).length, 1);
    assert.throws(() => port.clearLocalResource(key.namespace, "thread-catalog"), TypeError);
    assert.throws(() => port.listLocalKeys(key.namespace, "arbitrary"), TypeError);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
