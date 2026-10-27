import assert from "node:assert/strict";
import test from "node:test";
import { changesThreadCatalog, mergeThreadCatalogPages, threadCatalogPhase, sidebarThreadCatalogQueryKey, managedCatalogDiscoveryPhase, catalogCachedAt } from "../../apps/workbench-web/src/runtime/thread-catalog-query.js";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { QueryClient } from "@tanstack/react-query";
test("thread metadata changes and completed work invalidate catalog queries, not token deltas", () => {
  assert.equal(changesThreadCatalog("thread/name/updated"), true);
  assert.equal(changesThreadCatalog("thread/archived"), true);
  assert.equal(changesThreadCatalog("thread/unarchived"), true);
  assert.equal(changesThreadCatalog("turn/completed"), true);
  assert.equal(changesThreadCatalog("thread/status/changed"), true);
  assert.equal(changesThreadCatalog("thread/pins/updated"), true);
  assert.equal(changesThreadCatalog("item/agentMessage/delta"), false);
});

test("older pin backfill remains unique when later recent pages contain the same thread", () => {
  const pinned = { id: "old", pinned: true };
  assert.deepEqual(mergeThreadCatalogPages([
    { data: [pinned, { id: "recent", pinned: false }] },
    { data: [{ id: "old", pinned: false }, { id: "other", pinned: false }] },
  ]), [pinned, { id: "recent", pinned: false }, { id: "other", pinned: false }]);
});

test("connection discovery failure is observable even before there are any Host profiles", () => {
  assert.equal(managedCatalogDiscoveryPhase(null), null);
  assert.equal(managedCatalogDiscoveryPhase({ available: null, refreshing: true, error: null }), "loading");
  assert.equal(managedCatalogDiscoveryPhase({ available: null, refreshing: false, error: "failed" }), "error");
  assert.equal(managedCatalogDiscoveryPhase({ available: null, refreshing: true, error: "failed" }), "loading");
  assert.equal(managedCatalogDiscoveryPhase({ available: true, refreshing: false, error: "failed" }), "error");
  assert.equal(managedCatalogDiscoveryPhase({ available: true, refreshing: true, error: null }), null, "background status reads must be visually quiet");
  assert.equal(managedCatalogDiscoveryPhase({ available: true, refreshing: false, error: null }), null, "locked or empty success is not failure");
  assert.equal(managedCatalogDiscoveryPhase({ available: false, refreshing: false, error: null }), null, "a backend without SSH stays unchanged");
});

test("catalog loading, error and empty success stay distinct; revoked queries cannot paint", () => {
  assert.equal(threadCatalogPhase({ admitted: false, status: "pending", isFetching: false }), "unavailable");
  assert.equal(threadCatalogPhase({ admitted: false, status: "success", isFetching: false }), "unavailable");
  assert.equal(threadCatalogPhase({ admitted: true, status: "pending", isFetching: false }), "loading");
  assert.equal(threadCatalogPhase({ admitted: true, status: "error", isFetching: false }), "error");
  assert.equal(threadCatalogPhase({ admitted: true, status: "error", isFetching: true }), "loading");
  assert.equal(threadCatalogPhase({ admitted: true, status: "success", isFetching: false }), "ready");
  const scope = { revision: 1, authorizationEpoch: 2 };
  assert.notDeepEqual(sidebarThreadCatalogQueryKey("ssh:a", scope), sidebarThreadCatalogQueryKey("ssh:b", scope));
});

test("cached history belongs to one recipe and authorization incarnation, not just a Host ID", () => {
  const client = new QueryClient();
  const key = sidebarThreadCatalogQueryKey("ssh:a", { revision: 1, authorizationEpoch: 2 });
  client.setQueryData(key, { data: ["old-private-history"] });
  assert.equal(client.getQueryData(sidebarThreadCatalogQueryKey("ssh:a", { revision: 1, authorizationEpoch: 3 })), undefined);
  assert.equal(client.getQueryData(sidebarThreadCatalogQueryKey("ssh:a", { revision: 2, authorizationEpoch: 2 })), undefined);
  const local = sidebarThreadCatalogQueryKey("local", { revision: 1, authorizationEpoch: null });
  client.setQueryData(local, { data: ["local-history"] });
  assert.deepEqual(client.getQueryData(local), { data: ["local-history"] });
  client.clear();
});

test("SSH runtime uses indexed catalog reads for initial and paged callers; repair remains explicit", async () => {
  for (const hostKind of ["remote-ssh", "local", "durable"] as const) {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const transport = new MemoryTransport({ receive(frame, peer) {
      const request = JSON.parse(frame);
      if (request.id === undefined) return;
      requests.push(request);
      const result = request.method === "initialize"
        ? { userAgent: "catalog-test", platform: "linux", codexHome: "/synthetic" }
        : { data: [], nextCursor: null };
      peer.send(JSON.stringify({ id: request.id, result }));
    } });
    const runtime = createAppServerWorkbenchRuntime({ hostId: hostKind, hostKind, transport, autoReconnect: false });
    try {
      await runtime.connect();
      await runtime.resources.threads.list({ cursor: null, limit: 50 });
      await runtime.resources.threads.list({ cursor: "page-two", limit: 30 });
      await runtime.resources.threads.list({ archived: true, limit: 1 });
      await runtime.resources.threads.list({ useStateDbOnly: false });
      const lists = requests.filter(request => request.method === "thread/list");
      assert.equal(lists.length, 4);
      for (const request of lists.slice(0, 3)) {
        assert.equal(request.params.useStateDbOnly, hostKind === "remote-ssh" ? true : undefined);
        assert.equal(request.params.modelProviders, undefined, "Do not widen provider filtering");
        assert.equal(request.params.sourceKinds, undefined, "Do not widen source filtering");
      }
      assert.equal(lists[1]!.params.cursor, "page-two");
      assert.equal(lists[2]!.params.archived, true);
      assert.equal(lists[3]!.params.useStateDbOnly, false);
      assert.equal(requests.some(request => ["thread/start", "thread/resume", "turn/start", "turn/steer"].includes(request.method)), false);
    } finally { await runtime.dispose(); }
  }
});


test("durable catalog failure exposes saved-data state only with valid metadata", () => {
  assert.equal(catalogCachedAt({data:[]}),undefined);
  assert.equal(catalogCachedAt({catalog:{state:"error",lastSuccessAt:123}}),123);
  assert.equal(catalogCachedAt({catalog:{state:"ready",lastSuccessAt:123}}),undefined);
  assert.equal(catalogCachedAt({catalog:{state:"error",lastSuccessAt:null}}),undefined);
  assert.equal(catalogCachedAt({catalog:{state:"error",lastSuccessAt:-1}}),undefined);
});


test("successful empty pages with a cursor are still loading, and failed continuation is retryable", () => {
  assert.equal(threadCatalogPhase({ admitted: true, status: "success", isFetching: false, partial: true }), "loading");
  assert.equal(threadCatalogPhase({ admitted: true, status: "error", isFetching: false, partial: true }), "error");
});
