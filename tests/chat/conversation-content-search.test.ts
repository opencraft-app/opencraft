import assert from "node:assert/strict";
import test from "node:test";
import { createAppServerContentSearchSource, isUnsupportedSearch, mergeConversationSearchResults, serializeContentSearch } from "../../apps/workbench-web/src/runtime/conversation-content-search";

test("native method-not-found and explicit DSH rejection retain titles; transport failures remain failures", () => {
  assert.equal(isUnsupportedSearch({ code: -32601 }), true);
  assert.equal(isUnsupportedSearch({ code: -32603, message: "Method not supported by OpenCraft DSH host: thread/search" }), true);
  assert.equal(isUnsupportedSearch({ code: -32603, message: "Storage unavailable" }), false);
  assert.equal(isUnsupportedSearch(new Error("Disconnected")), false);
});

test("same thread IDs on different Servers survive; body results enrich title matches", () => {
  const row = { id: "same", title: "Title", updatedAt: 1, connectionHostId: "a", serverOrigin: { label: "A" } };
  const merged = mergeConversationSearchResults([row, { ...row, connectionHostId: "b" }], [{ ...row, snippet: "Body only", searchTerm: "Body" }]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.snippet, "Body only");
  assert.equal(merged[1]?.connectionHostId, "b");
});

test("native scans serialize and obsolete queued input never reaches the Server", async () => {
  const serialize = serializeContentSearch();
  const obsolete = new AbortController();
  let release!: () => void;
  const first = serialize(new AbortController().signal, () => new Promise<void>(resolve => { release = resolve; }));
  await Promise.resolve(); await Promise.resolve();
  const second = serialize(obsolete.signal, async () => { assert.fail("obsolete query executed"); });
  const rejected = assert.rejects(second, { name: "AbortError" });
  obsolete.abort(); release(); await first; await rejected;
  assert.equal(await serialize(new AbortController().signal, async () => "latest"), "latest");
});

test("body search forwards cursors and readonly filters, extracts locators and fences revoked results", async () => {
  const calls: any[] = [];
  let revoked = false;
  let revokeDuringRead = false;
  const source = createAppServerContentSearchSource({ key: "scope", hostId: "a", label: "A", available: true, supported: true,
    assertCurrent: () => { if (revoked) throw new Error("revoked"); },
    protocol: { request: async (method: any, params: any, options: any): Promise<any> => {
      calls.push({ method, params, options });
      if (revokeDuringRead) revoked = true;
      return method === "thread/search" ? { data: [{ thread: { id: "old" }, snippet: "正文独有" }], nextCursor: "next" }
        : { data: [{ turnId: "old-turn", itemId: "answer", turnCursor: "native" }], nextCursor: null };
    } },
    project: thread => ({ id: thread.id, title: "Unrelated title", updatedAt: 1, connectionHostId: "a", serverOrigin: { label: "A" } }),
  });
  const signal = new AbortController().signal;
  const result = await source.search("正文", "older", signal);
  assert.equal(result.nextCursor, "next"); assert.equal(result.matches[0]?.snippet, "正文独有");
  assert.deepEqual(calls[0], { method: "thread/search", params: { searchTerm: "正文", cursor: "older", limit: 30, archived: false, sortKey: "updated_at", sortDirection: "desc" }, options: { timeoutMs: 120_000 } });
  const target = await source.locate("正文", "old", signal);
  assert.equal(target?.itemId, "answer");
  assert.deepEqual(calls[1].options, { timeoutMs: 120_000 });
  revokeDuringRead = true;
  await assert.rejects(source.search("正文", null, signal), /revoked/);
  const count = calls.length;
  await assert.rejects(source.search("正文", null, signal), /revoked/);
  assert.equal(calls.length, count);
  assert.ok(calls.every(call => ["thread/search", "thread/searchOccurrences"].includes(call.method)));
});


test("search waits for navigation readiness after activation, and releases on cancellation", async () => {
  const { waitForSearchNavigationAnchor } = await import("../../apps/workbench-web/src/runtime/conversation-search-navigation");
  const listeners = new Set<() => void>();
  const anchor = { id: "old", turnKey: "old-turn", itemId: "prompt", order: 0, label: "", isLoaded: false, isHeartbeat: false };
  let snapshot = { revision: 0, phase: "empty" as "empty" | "ready", generation: "g", completeness: "partial" as const, anchors: [] as typeof anchor[], error: null };
  const source = { getSnapshot: () => snapshot, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    prepare: async () => {}, prepareTarget: async () => null, loadPreview: async () => null, dispose: () => {} };
  const abort = new AbortController();
  let settled = false;
  const pending = waitForSearchNavigationAnchor(source, { turnId: "old-turn", itemId: "answer" }, abort.signal).then(value => { settled = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(settled, false); assert.equal(listeners.size, 1);
  snapshot = { ...snapshot, revision: 1, phase: "ready", anchors: [anchor] };
  for (const fn of listeners) fn();
  assert.equal(await pending, anchor); assert.equal(listeners.size, 0);
  snapshot = { ...snapshot, phase: "empty", anchors: [] };
  const canceled = waitForSearchNavigationAnchor(source, { turnId: "old-turn", itemId: "answer" }, abort.signal);
  await new Promise(resolve => setTimeout(resolve, 0)); abort.abort();
  await assert.rejects(canceled, { name: "AbortError" }); assert.equal(listeners.size, 0);
});

test("full-history searches outlive the metadata deadline through the actual runtime port", async () => {
  const { MemoryTransport } = await import("@opencraft/appserver-transport-memory");
  const { createAppServerWorkbenchRuntime } = await import("@opencraft/workbench-runtime");
  const transport = new MemoryTransport({ receive(frame, peer) {
    const request = JSON.parse(frame);
    if (request.id === undefined) return;
    const send = (result: unknown) => peer.send(JSON.stringify({ id: request.id, result }));
    if (request.method === "initialize") send({ codexHome: "/fixture", userAgent: "search-deadline" });
    else if (request.method === "thread/search") setTimeout(() => send({ data: [], nextCursor: null }), 100);
    else if (request.method === "thread/searchOccurrences") setTimeout(() => send({ data: [{ turnId: "turn", itemId: "item" }], nextCursor: null }), 100);
    else if (request.method === "thread/list") setTimeout(() => send({ data: [], nextCursor: null }), 100);
    else send({});
  } });
  const runtime = createAppServerWorkbenchRuntime({ hostId: "search", transport, autoReconnect: false, requestTimeoutMs: 20 });
  try {
    await runtime.connect();
    const source = createAppServerContentSearchSource({ key: "search", hostId: "search", label: "Search", available: true, supported: true,
      assertCurrent() {}, protocol: runtime.resources.protocol, project() { throw new Error("No matches expected"); } });
    const signal = new AbortController().signal;
    assert.deepEqual(await source.search("中继", null, signal), { matches: [], nextCursor: null });
    assert.deepEqual(await source.locate("中继", "thread", signal), { turnId: "turn", itemId: "item" });
    await assert.rejects(runtime.resources.threads.list({ limit: 1 }), { code: "TIMEOUT" }, "metadata retains its original deadline");
  } finally { await runtime.dispose(); }
});
