import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { catalogMerkle, CATALOG_MERKLE_CURSOR, createCatalogMerklePager, isCatalogSnapshotHead } from "@opencraft/appserver-protocol";
import type { Thread, ThreadListResponse } from "@opencraft/appserver-protocol/generated/v2";
import { DirectorySnapshotIndex, DirectorySnapshotPages, SNAPSHOT_START } from "../../packages/app-host-server/src/thread-directory/snapshots";
import { reconcileThreadCatalog } from "../../apps/workbench-web/src/runtime/thread-catalog-recovery";
import { ThreadCatalogUpdates } from "../../apps/workbench-web/src/runtime/thread-catalog-updates";
import { ThreadCatalog } from "../../apps/local-agent-host/src/thread-catalog";

const row = (id: string, name = id, updatedAt = 1): Thread => ({ id, name, cwd: "/synthetic", preview: "", createdAt: 1, updatedAt,
  status: { type: "idle" }, ephemeral: false, turns: [] } as unknown as Thread);
const ready = { state: "ready", coverage: "complete" };
const base = (data: Thread[]): ThreadListResponse => ({ data, nextCursor: null, backwardsCursor: null,
  catalog: ready, catalogSnapshot: { version: 1, id: "old", checkpoints: [{ source: "old", revision: 1 }] } } as ThreadListResponse);
const cursor = (value: unknown) => CATALOG_MERKLE_CURSOR + JSON.stringify(value);
const fixture = (data: Thread[], catalog: unknown = ready) => {
  const index = new DirectorySnapshotIndex(), pager = new DirectorySnapshotPages();
  index.replace(data.map(row => ({ row, archived: false })));
  const read = async (cursor: string) => pager.list(cursor, false, 50, () => ({
    parts: [{ root: index.capture(false), merkle: index.captureMerkle(false), checkpoint: { source: "new", revision: 100000 } }], catalog,
  })) as ThreadListResponse;
  return { index, pager, read };
};

test("portable SHA-256 agrees with the independent platform implementation", () => {
  for (const value of ["", "abc", "汉字😀\ud800", "a".repeat(100000), ...Array.from({ length: 100 }, () => randomBytes(100).toString("base64"))])
    assert.equal(catalogMerkle.hash(value), createHash("sha256").update(value).digest("hex"));
});
test("stable metadata root is independent of arrival order, object key order and presentation", () => {
  const rows = Array.from({ length: 1000 }, (_, i) => row(String(i)));
  let incremental = catalogMerkle.empty;
  for (const value of [...rows].reverse()) incremental = catalogMerkle.set(incremental, value.id, value);
  const expected = catalogMerkle.build(rows);
  assert.equal(incremental.hash, expected.hash);
  const changedStatus = rows.map(r => ({ ...r, pinned: true, status: { type: "active", activeFlags: [] }, turns: [{ privateBody: true }] } as unknown as Thread));
  assert.equal(catalogMerkle.build(changedStatus).hash, expected.hash);
  const changed = catalogMerkle.set(expected, "0", row("0", "renamed", 999));
  assert.notEqual(changed.hash, expected.hash);
  assert.equal(catalogMerkle.set(changed, "0", rows[0]).hash, expected.hash);
});
test("twenty thousand missed revisions require current differences, not event replay", async () => {
  const data = Array.from({ length: 1000 }, (_, i) => row(`t-${i}`));
  const server = fixture(data), before = base(data);
  server.index.set(row("t-3", "final title", 20001), false);
  server.index.delete("t-9"); server.index.set(row("new", "new", 20002), false);
  let calls = 0, transferred = 0;
  const result = await reconcileThreadCatalog(before, async c => {
    calls++; const response = await server.read(c); transferred += response.data.length; return response;
  });
  assert.ok(result); assert.equal(result.nextCursor, null); assert.equal(result.data.length, 1000);
  assert.equal(result.data.find(r => r.id === "t-3")?.name, "final title");
  assert.ok(!result.data.some(r => r.id === "t-9")); assert.equal(result.data[0]?.id, "new");
  assert.ok(transferred < 40, `transferred ${transferred}`); assert.ok(calls <= 3);
});
test("unchanged reconnect transfers no directory rows; empty changed leaves remove deleted rows", async () => {
  const data = Array.from({ length: 100 }, (_, i) => row(`a-${i}`)), server = fixture(data);
  let calls = 0;
  const result = await reconcileThreadCatalog(base(data), async c => { calls++; const p = await server.read(c); assert.equal(p.data.length, 0); return p; });
  assert.equal(calls, 1); assert.equal(result?.data.length, 100);
  for (const r of data) server.index.delete(r.id);
  const empty = await reconcileThreadCatalog(base(data), server.read);
  assert.ok(empty); assert.equal(empty.data.length, 0);
});
test("captured root and checkpoints remain fixed while new notifications overlay recovered data", async () => {
  const data = Array.from({ length: 300 }, (_, i) => row(`b-${i}`)), server = fixture(data);
  server.index.set(row("b-1", "snapshot name"), false);
  const updates = new ThreadCatalogUpdates("h"); updates.enabled = true;
  const boundary = updates.getSnapshot(); let first = true;
  const recovered = await reconcileThreadCatalog(base(data), async c => {
    const response = await server.read(c);
    if (first) {
      first = false;
      server.index.set(row("b-1", "later name"), false);
      updates.receive({ version: 1, authority: "directory", source: "new", revision: 100001,
        change: { type: "patch", threadId: "b-1", name: "later name" } });
    }
    return response;
  });
  assert.equal(recovered?.data.find(r => r.id === "b-1")?.name, "snapshot name");
  updates.acknowledge(updates.markRead(recovered!, boundary), true);
  assert.equal(updates.project(recovered!)?.data.find(r => r.id === "b-1")?.name, "later name");
});
test("partial coverage, large differences and damaged checksums request snapshot fallback", async () => {
  const data = Array.from({ length: 300 }, (_, i) => row(`c-${i}`));
  assert.equal(await reconcileThreadCatalog(base(data), fixture(data, { state: "warming", coverage: "partial" }).read), null);
  assert.equal(await reconcileThreadCatalog(base(data), fixture(data.map(r => ({ ...r, name: "changed" }))).read), null);
  const server = fixture(data); server.index.set(row("c-1", "changed"), false);
  assert.equal(await reconcileThreadCatalog(base(data), async c => {
    const result = await server.read(c);
    if ((result as any).catalogMerkle.mode === "rows") result.data[0]!.name = "damaged";
    return result;
  }), null);
});
test("read handles reject expiry, foreign owners, wrong partitions and malformed budgets", () => {
  let now = 0, seq = 0;
  const Pager = createCatalogMerklePager(catalogMerkle), pages = new Pager(() => String(++seq), () => now);
  const capture = () => ({ root: catalogMerkle.empty, catalog: ready, checkpoints: [] });
  const head = pages.list(cursor({ root: "0".repeat(64) }), false, 50, capture), id = head.catalogSnapshot.id;
  const next = cursor({ id, buckets: [0] });
  assert.throws(() => pages.list(next, true, 50, capture), { code: -32086 });
  assert.throws(() => new Pager(() => "x").list(next, false, 50, capture), { code: -32086 });
  assert.throws(() => pages.list(cursor({ id, buckets: [0, 0] }), false, 50, capture));
  assert.throws(() => pages.list(cursor({ id, buckets: [256] }), false, 50, capture));
  now = 120001; assert.throws(() => pages.list(next, false, 50, capture), { code: -32086 });
  assert.equal(isCatalogSnapshotHead(cursor({ root: "0".repeat(64) })), true);
  assert.equal(isCatalogSnapshotHead(next), false);
});
test("file-backed Merkle reads remain inside the SQL reader worker", async t => {
  const { mkdtempSync, rmSync } = await import("node:fs"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const folder = mkdtempSync(join(tmpdir(), "catalog-merkle-")), store = new ThreadCatalog(join(folder, "catalog.sqlite"));
  t.after(() => { store.close(); rmSync(folder, { recursive: true, force: true }); });
  const data = Array.from({ length: 100 }, (_, i) => row(`file-${i}`));
  const directory = store.createProjection({ list: async p => ({ data: p.archived ? [] : data, nextCursor: null }) });
  await directory.refresh();
  const database = (store as any).database, originalPrepare = database.prepare, originalExec = database.exec;
  database.prepare = () => { throw Error("SQL on network thread"); }; database.exec = () => { throw Error("SQL on network thread"); };
  try {
    const result = await reconcileThreadCatalog(base(data), c => directory.list({ cursor: c, sortKey: "updated_at", limit: 50 }));
    assert.ok(result); assert.equal(result.data.length, 100);
  } finally { database.prepare = originalPrepare; database.exec = originalExec; }
});

test("unchanged metadata still refreshes a formerly active row and current active rows", async () => {
  const data = Array.from({ length: 100 }, (_, i) => row(`status-${i}`));
  const before = data.map(r => r.id === "status-1" ? { ...r, status: { type: "active", activeFlags: [] } } as Thread : r);
  const current = data.map(r => r.id === "status-2" ? { ...r, status: { type: "active", activeFlags: [] } } as Thread : r);
  const result = await reconcileThreadCatalog(base(before), fixture(current).read);
  assert.equal(result?.data.find(r => r.id === "status-1")?.status.type, "idle");
  assert.equal(result?.data.find(r => r.id === "status-2")?.status.type, "active");
});

test("multiple admitted source roots combine independently of partition insertion order", () => {
  const one = Array.from({ length: 200 }, (_, i) => row(`one-${i}`)), two = Array.from({ length: 200 }, (_, i) => row(`two-${i}`));
  const a = catalogMerkle.build(one), b = catalogMerkle.build(two);
  const merged = catalogMerkle.combine([a, b]);
  assert.equal(merged.hash, catalogMerkle.build([...two, ...one]).hash);
  const changed = catalogMerkle.set(a, "one-1", row("one-1", "updated"));
  const next = catalogMerkle.combine([changed, b], merged);
  assert.equal(next.hash, catalogMerkle.build([...one.filter(r => r.id !== "one-1"), row("one-1", "updated"), ...two]).hash);
  assert.ok(catalogMerkle.leaves(next).filter((n, i) => n === catalogMerkle.leaves(merged)[i]).length >= 255);
});

test("persisted replica survives reopen; partial writes and account changes cannot certify a baseline", async () => {
  const { IDBFactory, IDBKeyRange } = await import("fake-indexeddb");
  Object.assign(globalThis, { IDBKeyRange });
  const { ClientResources } = await import("../../packages/document-storage/src/client-resources");
  const { openIndexedDbClientResources } = await import("../../apps/workbench-web/src/runtime/indexeddb-client-resources");
  const { catalogReplicaResource, restoreCatalogReplica, saveCatalogReplica } = await import("../../apps/workbench-web/src/runtime/thread-catalog-replica-cache");
  const factory = new IDBFactory();
  let storage = await openIndexedDbClientResources("merkle-reopen", factory);
  let resources = new ClientResources(Promise.resolve(storage), "account-a");
  const parts = () => Array.from({ length: 8 }, (_, i) => resources.remote(catalogReplicaResource, `host-1:${i}`));
  let handles = parts(); await Promise.all(handles.map(r => r.ready));
  const data = Array.from({ length: 300 }, (_, i) => ({ ...row(`persist-${i}`), turns: [{ secret: "NEVER_SAVE" }], extra: { credential: "NEVER_SAVE" } } as unknown as Thread));
  await saveCatalogReplica(handles, base(data), { isCurrent: () => true });
  assert.ok(restoreCatalogReplica(handles));
  assert.ok(!JSON.stringify(handles.map(r => r.getSnapshot().value)).includes("NEVER_SAVE"));
  await resources.close();
  storage = await openIndexedDbClientResources("merkle-reopen", factory);
  resources = new ClientResources(Promise.resolve(storage), "account-a"); handles = parts();
  await Promise.all(handles.map(r => r.ready));
  const restored = restoreCatalogReplica(handles); assert.equal(restored?.data.length, 300);
  const server = fixture(data); server.index.delete("persist-1");
  const recovered = await reconcileThreadCatalog(restored!, server.read);
  assert.equal(recovered?.data.length, 299);
  const first = handles[0]!.getSnapshot().value!;
  await handles[0]!.observe({ ...first, generation: "f".repeat(64) }, { isCurrent: () => true });
  assert.equal(restoreCatalogReplica(handles), undefined);
  resources.setNamespace("account-b"); handles = parts(); await Promise.all(handles.map(r => r.ready));
  assert.equal(restoreCatalogReplica(handles), undefined);
  await resources.close();
});


test("a short screen-off return bypasses freshness TTL and coalesces network hints", async () => {
  const { QueryClient, QueryObserver } = await import("@tanstack/react-query");
  const { startCatalogReturnRecovery } = await import("../../apps/workbench-web/src/runtime/catalog-return-recovery");
  const priorDocument = globalThis.document, priorWindow = globalThis.window;
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" }), win = new EventTarget();
  Object.assign(globalThis, { document: doc, window: win });
  const client = new QueryClient(); let reads = 0;
  const observer = new QueryObserver(client, { queryKey: ["appserver", "h", "threads", "sidebar-pages"],
    meta: { requestCaller: "sidebar-catalog" }, staleTime: Infinity, queryFn: async () => ++reads });
  const unsubscribe = observer.subscribe(() => {});
  await observer.refetch(); const before = reads;
  const stop = startCatalogReturnRecovery(client), second = startCatalogReturnRecovery(client);
  try {
    doc.visibilityState = "hidden"; doc.dispatchEvent(new Event("visibilitychange")); win.dispatchEvent(new Event("online"));
    await new Promise(r => setTimeout(r, 0)); assert.equal(reads, before);
    doc.visibilityState = "visible"; doc.dispatchEvent(new Event("visibilitychange")); win.dispatchEvent(new Event("online"));
    await new Promise(r => setTimeout(r, 0)); assert.equal(reads, before + 1);
    stop(); second();
    doc.visibilityState = "hidden"; doc.dispatchEvent(new Event("visibilitychange"));
    doc.visibilityState = "visible"; doc.dispatchEvent(new Event("visibilitychange"));
    await new Promise(r => setTimeout(r, 0)); assert.equal(reads, before + 1);
  } finally { stop(); second(); unsubscribe(); client.clear(); Object.assign(globalThis, { document: priorDocument, window: priorWindow }); }
});


test("worker hashes the admitted reader projection, including authoritative access modes", async t => {
  const { mkdtempSync, rmSync } = await import("node:fs"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const { openServerDatabase } = await import("@opencraft/storage-node/server");
  const { ConversationHistoryWorker } = await import("../../packages/app-host-server/src/conversation-history-worker");
  const dir = mkdtempSync(join(tmpdir(), "merkle-admission-")), storage = await openServerDatabase(dir);
  const worker = new ConversationHistoryWorker(join(dir, "opencraft-server.sqlite"));
  t.after(async () => { await worker.close(); await storage.close(); rmSync(dir, { recursive: true, force: true }); });
  await worker.start(); const history = worker.create("local-codex");
  const data = Array.from({ length: 100 }, (_, i) => ({ ...row(`policy-${i}`), accessMode: "private" }));
  await history.importResult("thread/list", {}, { data, nextCursor: null }, await history.catalogRevision());
  const plain = await history.read("thread/list", { cursor: SNAPSHOT_START, limit: 1000 });
  const admission = Object.assign((id: string) => id !== "policy-0", { catalogReader: "reader-A", catalogPolicy: () => "shared" as const });
  const visible = { ...plain, data: plain.data.filter((r: Thread) => admission(r.id)).map((r: Thread) => ({ ...r, accessMode: "shared" })) } as ThreadListResponse;
  const recovered = await reconcileThreadCatalog(visible, c => history.read("thread/list", { cursor: c, limit: 50 }, admission) as Promise<ThreadListResponse>);
  assert.ok(recovered); assert.equal(recovered.data.length, 99);
  assert.ok(recovered.data.every(r => (r as any).accessMode === "shared"));
  const head = await history.read("thread/list", { cursor: cursor({ root: "0".repeat(64) }), limit: 50 }, admission);
  assert.equal(head.catalogMerkle.count, 99); assert.equal(head.catalogMerkle.projected, true);
  assert.equal(head.catalogMerkle.root, catalogMerkle.build(visible.data).hash);
  await assert.rejects(() => history.read("thread/list", { cursor: cursor({ id: head.catalogSnapshot.id, buckets: [0] }), limit: 50 },
    Object.assign((id: string) => admission(id), { catalogReader: "reader-B", catalogPolicy: () => "shared" as const })), { code: -32086 });
});
