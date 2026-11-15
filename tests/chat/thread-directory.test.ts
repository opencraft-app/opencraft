import assert from "node:assert/strict";
import test from "node:test";
import { ThreadCatalog } from "../../apps/local-agent-host/src/thread-catalog.js";
import { ThreadLifecycle } from "../../apps/local-agent-host/src/thread-lifecycle.js";
import { EngineThreadDirectory } from "../../apps/local-agent-host/src/engine-thread-directory.js";
const row = (id: string, at = 1, name = id) => ({ id, cwd: "/fixture", createdAt: 1, updatedAt: at, name, preview: "preview", status: { type: "idle" as const }, ephemeral: false, turns: [] });
const query = { sortKey: "updated_at", limit: 50 };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

test("DSH 222 rows / five UI pages scan once, without writing authoritative records; unchanged sync emits nothing", async t => {
  const store = new ThreadCatalog(); t.after(() => store.close());
  let calls = 0, events = 0;
  const metrics: any[] = [];
  const rows = Array.from({ length: 222 }, (_, i) => row(`t${i}`, 1000 - i));
  const directory = store.attachDirectory({ list: async p => {
    calls++; const offset = Number(p.cursor ?? 0);
    return { data: rows.slice(offset, offset + 200), nextCursor: offset + 200 < rows.length ? String(offset + 200) : null };
  }, measured: metric => metrics.push(metric), changed: () => { events++; } });
  const lifecycle = new ThreadLifecycle(store, async () => ({ released: true }), () => {});
  const delegate = async () => { throw new Error("UI paging must not call native source"); };
  let cursor = null, count = 0;
  do { const page = await lifecycle.dispatch("thread/list", { ...query, cursor }, "reader", delegate); count += page.data.length; cursor = page.nextCursor; } while (cursor != null);
  assert.equal(count, 222); assert.equal(calls, 2);
  assert.equal(store.list(false).length, 0, "projection synchronization cannot write authority documents");
  const before = events; await directory.refresh(); assert.equal(events, before, "same metadata produces no content notification");
  assert.equal(calls, 4);
  assert.equal(metrics.at(-1).changed, 0); assert.equal(metrics.at(-1).noop, 222);
});

test("manual title/config/archive survive a stale scan and rebuilding the disposable projection", async t => {
  const store = new ThreadCatalog(); t.after(() => store.close());
  store.upsert(row("a"), { configuration: { model: "selected", permissions: { preset: "readOnly" } } });
  const gate = deferred<any>();
  const directory = store.attachDirectory({ list: () => gate.promise, changed: () => {} });
  const job = directory.refresh(); store.rename("a", "manual"); store.archive("a", true);
  gate.resolve({ data: [row("a", 1, "native old title")], nextCursor: null }); await job;
  assert.equal((await directory.list({ ...query, archived: false })).data.length, 0);
  assert.equal((await directory.list({ ...query, archived: true })).data[0]?.name, "manual");
  await directory.refresh();
  assert.equal((await directory.list({ ...query, archived: true })).data[0]?.name, "manual");
  assert.deepEqual(store.configuration("a"), { model: "selected", permissions: { preset: "readOnly" } });
});

test("dirty burst coalesces reads, changed metadata upserts once, deletion fences late reads", async t => {
  const store = new ThreadCatalog(); t.after(() => store.close()); let reads = 0, events = 0;
  let read: () => Promise<any> = async () => ({ thread: row("a", 2) });
  const directory = store.attachDirectory({ list: async () => ({ data: [row("a")], nextCursor: null }), readMetadata: async () => { reads++; return read(); }, changed: () => { events++; } });
  await directory.refresh(); const before = events;
  for (let n = 0; n < 10; n++) directory.markDirty("a");
  await directory.flush(); assert.equal(reads, 1); assert.equal(events, before + 1);
  directory.markDirty("a"); await directory.flush(); assert.equal(events, before + 1, "identical metadata is a no-op");
  const gate = deferred<any>(); read = () => gate.promise;
  directory.markDirty("a"); const job = directory.flush(); directory.observe("thread/deleted", { threadId: "a" });
  gate.resolve({ thread: row("a", 100) }); await job;
  assert.equal((await directory.list(query)).data.length, 0);
});

test("engine partitions show a ready source while a sibling warms; paging does not rescan either source", async t => {
  const gate = deferred<any>(); let calls = 0;
  const directory = new EngineThreadDirectory([
    { id: "fast", owns: id => id.startsWith("fast:"), read: async () => ({}), list: async p => { calls++; return { data: p.archived ? [] : Array.from({ length: 222 }, (_, i) => row(`fast:${i}`, 1000 - i)), nextCursor: null }; } },
    { id: "slow", owns: id => id.startsWith("slow:"), read: async () => ({}), list: async p => p.archived ? { data: [], nextCursor: null } : gate.promise },
  ], () => {}); t.after(() => directory.close());
  const first = await directory.list(query); assert.equal(first.data.length, 50); assert.equal(first.catalog.coverage, "partial");
  let cursor = first.nextCursor, count = first.data.length;
  while (cursor) { const page = await directory.list({ ...query, cursor }); count += page.data.length; cursor = page.nextCursor; }
  assert.equal(count, 222); assert.equal(calls, 2);
  gate.resolve({ data: [row("slow:a", 2000)], nextCursor: null });
  await new Promise(resolve => setTimeout(resolve, 5));
  const complete = await directory.list(query); assert.equal(complete.data[0].id, "slow:a"); assert.equal(complete.catalog.coverage, "complete");
});

test("incomplete source coverage never becomes absence; execution status received before discovery survives metadata reads", async t => {
  const store = new ThreadCatalog(); t.after(() => store.close());
  let response: any = { data: [row("a")], nextCursor: null };
  const directory = store.createProjection({ list: async p => p.archived ? { data: [], nextCursor: null } : response,
    readMetadata: async () => ({ thread: row("a", 2) }), changed: () => {} });
  directory.observe("thread/status/changed", { threadId: "a", status: { type: "active", activeFlags: ["waitingOnApproval"] } });
  await directory.refresh();
  directory.markDirty("a"); await directory.flush();
  assert.deepEqual((await directory.list(query)).data[0]?.status, { type: "active", activeFlags: ["waitingOnApproval"] });
  response = { data: [], nextCursor: null, catalog: { state: "warming", coverage: "unknown" } };
  await assert.rejects(directory.refresh());
  assert.equal((await directory.list(query)).data[0]?.id, "a");
  assert.equal((await directory.list(query)).catalog.coverage, "partial");
});

test("cold nonblocking reads expose unknown coverage, and cursors cannot cross projection incarnations", async t => {
  const gate = deferred<any>(); const stores = [new ThreadCatalog(), new ThreadCatalog()]; t.after(() => stores.forEach(store => store.close()));
  const cold = stores[0]!.createProjection({ nonblockingCold: true, archivePartitioned: false, list: () => gate.promise, changed: () => {} });
  const page = await cold.list(query); assert.deepEqual(page.data, []); assert.equal(page.catalog.coverage, "unknown");
  gate.resolve({ data: [row("a", 2), row("b", 1)], nextCursor: null }); await cold.refresh();
  const first = await cold.list({ ...query, limit: 1 });
  const other = stores[1]!.createProjection({ archivePartitioned: false, list: async () => ({ data: [row("a", 2), row("b", 1)], nextCursor: null }), changed: () => {} });
  await other.refresh(); await assert.rejects(other.list({ ...query, cursor: first.nextCursor }), /cursor/);
});


test("a failed unpartitioned DSH source degrades active and archived coverage together", async t => {
  const store = new ThreadCatalog(); t.after(() => store.close()); let offline = false;
  store.upsert(row("archived")); store.archive("archived", true);
  const directory = store.attachDirectory({ list: async () => {
    if (offline) throw Error("offline"); return { data: [row("archived"), row("active")], nextCursor: null };
  }, changed: () => {} });
  await directory.refresh(); offline = true; await assert.rejects(directory.refresh());
  for (const archived of [false, true]) {
    const page = await directory.list({ ...query, archived });
    assert.equal(page.catalog.state, "error"); assert.equal(page.catalog.coverage, "partial"); assert.equal(page.data.length, 1);
  }
});


test("temporary threads never enter dirty retries, and deletion during a failed read retires pending work", async t => {
  const store = new ThreadCatalog(); t.after(() => store.close()); let reads = 0;
  const gate = deferred<any>();
  const directory = store.createProjection({ archivePartitioned: false,
    list: async () => ({ data: [row("durable")], nextCursor: null }),
    readMetadata: async () => { reads++; await gate.promise; throw Error("unavailable"); }, changed: () => {} });
  await directory.refresh();
  directory.observe("thread/started", { thread: { ...row("temporary"), ephemeral: true } });
  for (let n = 0; n < 10; n++) directory.observe("turn/completed", { threadId: "temporary" });
  await directory.flush(); assert.equal(reads, 0);
  directory.markDirty("durable"); const pending = directory.flush();
  directory.observe("thread/deleted", { threadId: "durable" }); gate.resolve(null); await pending;
  await directory.flush(); assert.equal(reads, 1);
});

test("full-summary-only sources refresh metadata once per dirty batch, and canonical facts fence stale reads", async t => {
  const store = new ThreadCatalog(); t.after(() => store.close()); let batches = 0;
  const directory = store.createProjection({ archivePartitioned: false,
    list: async () => ({ data: [row("a"), row("b")], nextCursor: null }),
    readMetadataBatch: async ids => { batches++; return new Map(ids.map(id => [id, { thread: row(id, 2, "fresh source title") }])); },
    changed: () => {} });
  await directory.refresh();
  for (let i = 0; i < 10; i++) { directory.markDirty("a"); directory.markDirty("b"); }
  await directory.flush(); assert.equal(batches, 1);
  assert.deepEqual((await directory.list(query)).data.map(t => t.name), ["fresh source title", "fresh source title"]);
  const event = { version: 1, source: "native", revision: 2, change: { type: "upsert", thread: row("a", 3, "canonical title") } };
  directory.observe("opencraft/thread-catalog/changed", event);
  directory.observe("opencraft/thread-catalog/changed", { ...event, revision: 1, change: { type: "upsert", thread: row("a", 1, "late title") } });
  assert.equal((await directory.list(query)).data[0]?.name, "canonical title");
});


test("large projection flush yields outside transactions and preserves intervening manual edits", async t => {
  const store = new ThreadCatalog(); t.after(() => store.close());
  store.upsert(row("t350"));
  const rows = Array.from({ length: 400 }, (_, i) => row(`t${i}`, 1000 - i));
  const directory = store.attachDirectory({ list: async () => ({ data: rows, nextCursor: null }), changed: () => {} });
  const interleaved = new Promise<void>((resolve, reject) => setImmediate(() => {
    try {
      assert.ok(store.get("t0"), "the first short batch committed");
      assert.equal(store.get("t399"), null, "remaining batches yield to sockets/timers");
      store.rename("t350", "manual during synchronization"); resolve();
    } catch (e) { reject(e); }
  }));
  await directory.refresh(); await interleaved;
  assert.equal(store.get("t350")?.name, "manual during synchronization");
  assert.equal((await directory.list({ ...query, limit: 1000 })).data.length, 400);
});


test("native project grouping survives the directory SQL projection and updates without a new recency timestamp", async t => {
  const store = new ThreadCatalog(); t.after(() => store.close());
  let name = "Original group";
  const directory = store.attachDirectory({ list: async () => ({ data: [{ ...row("imported"), nativeProject: { source: "codex", id: "p", name, position: 2 } }], nextCursor: null }) });
  let result = await directory.list(query);
  assert.equal((result.data[0] as any).nativeProject.name, name);
  name = "Renamed group"; await directory.refresh(); result = await directory.list(query);
  assert.equal((result.data[0] as any).nativeProject.name, name);
});
