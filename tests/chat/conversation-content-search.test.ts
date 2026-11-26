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
  assert.deepEqual(calls[0], { method: "thread/search", params: { searchTerm: "正文", cursor: "older", limit: 30, archived: false, sortKey: "updated_at", sortDirection: "desc" }, options: { timeoutMs: 120_000, signal } });
  const target = await source.locate("正文", "old", signal);
  assert.equal(target?.itemId, "answer");
  assert.equal(target?.turnCursor, "native");
  assert.deepEqual(calls[1].options, { timeoutMs: 120_000, signal });
  revokeDuringRead = true;
  await assert.rejects(source.search("正文", null, signal), /revoked/);
  const count = calls.length;
  await assert.rejects(source.search("正文", null, signal), /revoked/);
  assert.equal(calls.length, count);
  assert.ok(calls.every(call => ["thread/search", "thread/searchOccurrences"].includes(call.method)));
});

for (const exact of ["match", "expired", "wrong-turn", "wrong-item", "denied"] as const) {
  test(`content selection uses the occurrence cursor through the passive runtime: ${exact}`, async () => {
    const { MemoryTransport } = await import("@opencraft/appserver-transport-memory");
    const { createAppServerWorkbenchRuntime } = await import("@opencraft/workbench-runtime");
    const { prepareSearchNavigationTarget } = await import("../../apps/workbench-web/src/runtime/conversation-search-navigation");
    const methods: string[] = [];
    const reads: Array<[unknown, unknown]> = [];
    const latest = { id: "latest", status: "completed", itemsView: "full",
      items: [{ id: "latest-prompt", type: "userMessage", content: [{ type: "text", text: "Latest" }] }] };
    const between = { ...latest, id: "between",
      items: [{ id: "between-prompt", type: "userMessage", content: [{ type: "text", text: "Between" }] }] };
    const turn = { id: "located", status: "completed", itemsView: "full",
      items: [{ id: "located-prompt", type: "userMessage", content: [{ type: "text", text: "Earlier" }] },
        { id: "answer", type: "agentMessage", text: "Exact result" }] };
    const transport = new MemoryTransport({ receive(frame, peer) {
      const { id, method, params } = JSON.parse(frame);
      if (id === undefined) return;
      methods.push(method);
      const send = (result: unknown) => peer.send(JSON.stringify({ id, result }));
      if (method === "initialize") send({ codexHome: "/fixture", userAgent: "exact-search",
        capabilities: { extensions: { "opencraft/read-history": { version: 1, initialTurnsPage: true } } } });
      else if (method === "thread/read") send({
        thread: { id: "thread", cwd: "/fixture", status: { type: "idle" }, historyMode: "paginated", turns: [] },
        initialTurnsPage: { data: [latest], nextCursor: "older" },
      });
      else if (method === "thread/searchOccurrences")
        send({ data: [{ turnId: turn.id, itemId: "answer", turnCursor: "inclusive" }], nextCursor: null });
      else if (method === "thread/turns/list") {
        reads.push([params.cursor, params.itemsView]);
        if (params.cursor === "inclusive") {
          assert.equal(params.limit, 1);
          assert.equal(params.sortDirection, "desc");
          if (exact === "expired" || exact === "denied")
            peer.send(JSON.stringify({ id, error: exact === "expired"
              ? { code: -32602, message: "invalid cursor: anchor turn is no longer present" }
              : { code: -32003, message: "Not authorized" } }));
          else send({ data: [exact === "wrong-turn" ? { ...turn, id: "alien" }
            : exact === "wrong-item" ? { ...turn, items: [] } : turn], nextCursor: null });
        } else if (params.cursor === null) send({ data: [latest], nextCursor: "older" });
        else if (exact === "match" && params.itemsView === "full") {
          send(params.cursor === "older" ? { data: [between], nextCursor: "before-between" }
            : { data: [turn], nextCursor: null });
        } else {
          // In the successful case the target is past the rail's ten-page cap.
          const page = params.cursor === "older" ? 0 : Number(params.cursor);
          send(exact === "match"
            ? { data: [{ ...latest, id: `filler-${page}` }], nextCursor: String(page + 1) }
            : { data: [params.itemsView === "full" ? turn : { ...turn, itemsView: "notLoaded", items: [] }], nextCursor: null });
        }
      } else send(method.endsWith("/list") ? { data: [], nextCursor: null } : {});
    } });
    const runtime = createAppServerWorkbenchRuntime({ hostId: "search", transport, autoReconnect: false });
    try {
      await runtime.connect();
      const signal = AbortSignal.timeout(1000);
      const search = createAppServerContentSearchSource({ key: "scope", hostId: "search", label: "Search",
        available: true, supported: true, assertCurrent() {}, protocol: runtime.resources.protocol,
        project() { throw new Error("No title projection expected"); } });
      const target = await search.locate("result", "thread", signal);
      assert.ok(target);
      const lease = await runtime.acquireThread("thread");
      const position = prepareSearchNavigationTarget(lease.getNavigation(), target, signal);
      lease.setRecoveryVisibility(true);
      if (exact === "denied") await assert.rejects(position, { code: -32003 });
      else {
        const result = await position;
        assert.equal(result?.turnKey, turn.id);
        assert.equal(result?.itemId, "answer");
      }
      assert.deepEqual(reads, exact === "match" || exact === "denied" ? [["inclusive", "full"]]
        : [["inclusive", "full"], [null, "notLoaded"], ["older", "notLoaded"], ["older", "full"]]);
      if (exact === "match") {
        await lease.getNavigation().prepare();
        const anchors = () => lease.getNavigation().getSnapshot().anchors.map(anchor => anchor.turnKey);
        const projectedTurns = () => [...new Set(lease.getSnapshot().timeline.frames.map(frame => frame.turnId))];
        assert.deepEqual(projectedTurns(), [turn.id, latest.id]);
        assert.equal(anchors().includes(turn.id), false, "a sparse Turn has no place in the scanned index");
        await lease.loadOlder();
        assert.deepEqual(projectedTurns(), [turn.id, between.id, latest.id]);
        assert.equal(anchors().includes(turn.id), false, "the intervening page has not covered the search target");
        await lease.loadOlder();
        assert.deepEqual(projectedTurns(), [turn.id, between.id, latest.id]);
        assert.deepEqual(anchors(), [turn.id, between.id, latest.id]);
      }
      assert.equal(methods.some(method => method === "thread/resume" || method === "turn/start"), false);
      lease.release();
    } finally { await runtime.dispose(); }
  });
}

test("a second deep search replaces the unplaced hit without changing contiguous history", async () => {
  const { MemoryTransport } = await import("@opencraft/appserver-transport-memory");
  const { createAppServerWorkbenchRuntime } = await import("@opencraft/workbench-runtime");
  const { prepareSearchNavigationTarget } = await import("../../apps/workbench-web/src/runtime/conversation-search-navigation");
  const makeTurn = (id: string) => ({ id, status: "completed", itemsView: "full",
    items: [{ id: id + "-answer", type: "agentMessage", text: id }] });
  const exactCursors: string[] = [];
  const delayed = Promise.withResolvers<() => void>();
  const transport = new MemoryTransport({ receive(frame, peer) {
    const { id, method, params } = JSON.parse(frame);
    if (id === undefined) return;
    const send = (result: unknown) => peer.send(JSON.stringify({ id, result }));
    if (method === "initialize") send({ codexHome: "/fixture", userAgent: "search-focus",
      capabilities: { extensions: { "opencraft/read-history": { version: 1, initialTurnsPage: true } } } });
    else if (method === "thread/read") send({
      thread: { id: "thread", cwd: "/fixture", status: { type: "idle" }, historyMode: "paginated", turns: [] },
      initialTurnsPage: { data: [makeTurn("tail")], nextCursor: "canonical" },
    });
    else if (method === "thread/turns/list") {
      if (params.cursor === "canonical") send({ data: [makeTurn("newer"), makeTurn("older")], nextCursor: null });
      else {
        exactCursors.push(params.cursor);
        const result = { data: [makeTurn(params.cursor)], nextCursor: null };
        if (params.cursor === "delayed") delayed.resolve(() => send(result));
        else send(result);
      }
    } else send(method.endsWith("/list") ? { data: [], nextCursor: null } : {});
  } });
  const runtime = createAppServerWorkbenchRuntime({ hostId: "search", transport, autoReconnect: false });
  try {
    await runtime.connect();
    const lease = await runtime.acquireThread("thread");
    lease.setRecoveryVisibility(true);
    const projected = () => [...new Set(lease.getSnapshot().timeline.frames.map(frame => frame.turnId))];
    const select = async (id: string) => {
      const result = await prepareSearchNavigationTarget(lease.getNavigation(),
        { turnId: id, itemId: id + "-answer", turnCursor: id }, AbortSignal.timeout(1000));
      assert.equal(result?.itemId, id + "-answer");
    };
    await select("older");
    assert.deepEqual(projected(), ["older", "tail"]);
    assert.equal(lease.getSnapshot().timeline.unplacedSearchTurnId, "older");
    await select("newer");
    assert.deepEqual(projected(), ["newer", "tail"]);
    await select("older");
    assert.deepEqual(projected(), ["older", "tail"]);
    await select("tail");
    assert.deepEqual(projected(), ["tail"], "a materialized selection retires the prior search window");
    assert.equal(lease.getSnapshot().history.cursor, "canonical");
    assert.deepEqual(exactCursors, ["older", "newer", "older"], "selecting an already loaded Item needs no read");
    const obsolete = assert.rejects(select("delayed"), { name: "AbortError" });
    const release = await delayed.promise;
    await select("newer");
    await obsolete;
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(projected(), ["newer", "tail"], "a late older selection cannot replace focus");
    await lease.loadOlder();
    assert.deepEqual(projected(), ["older", "newer", "tail"]);
    assert.equal(lease.getSnapshot().timeline.unplacedSearchTurnId, undefined);
    await select("tail");
    assert.deepEqual(projected(), ["older", "newer", "tail"], "canonical history survives later selections");
    lease.release();
  } finally { await runtime.dispose(); }
});

for (const variant of ["nonempty", "empty", "removed"] as const) test(`ordinary history reconciles an indexed hit, ${variant}`, async () => {
  const { MemoryTransport } = await import("@opencraft/appserver-transport-memory");
  const { createAppServerWorkbenchRuntime, createConversationDisplayContinuity } = await import("@opencraft/workbench-runtime");
  const { asTurnId } = await import("@opencraft/chat-core");
  const { prepareSearchNavigationTarget } = await import("../../apps/workbench-web/src/runtime/conversation-search-navigation");
  const full = (id: string) => ({ id, status: "completed", itemsView: "full",
    items: [{ id: id + "-answer", type: "agentMessage", text: id }] });
  const head = full("head");
  const boundary = { ...full("empty-boundary"), items: [] };
  const hit = full("indexed-hit");
  const neighbor = full("cached-neighbor");
  const emptyHead = variant !== "nonempty";
  const removed = variant === "removed";
  const heldExact = Promise.withResolvers<() => void>();
  const headTurns = emptyHead ? [] : [head, boundary];
  const reads: Array<[string | null, string]> = [];
  const transport = new MemoryTransport({ receive(frame, peer) {
    const { id, method, params } = JSON.parse(frame);
    if (id === undefined) return;
    const send = (result: unknown) => peer.send(JSON.stringify({ id, result }));
    if (method === "initialize") send({ codexHome: "/fixture", userAgent: "indexed-preview",
      capabilities: { extensions: { "opencraft/read-history": { version: 1, initialTurnsPage: true } } } });
    else if (method === "thread/read") send({
      thread: { id: "thread", cwd: "/fixture", status: { type: "idle" }, historyMode: "paginated", turns: [] },
      initialTurnsPage: { data: headTurns, nextCursor: "older" },
    });
    else if (method === "thread/turns/list") {
      reads.push([params.cursor, params.itemsView]);
      if (params.itemsView === "notLoaded") {
        const headPage = params.cursor === null;
        send({ data: (headPage ? headTurns : [neighbor, hit]).map(turn => ({ ...turn, itemsView: "notLoaded", items: [] })),
          nextCursor: headPage ? "older" : null });
      } else if (emptyHead && params.cursor === "older") {
        send({ data: [neighbor], nextCursor: "reach-hit" });
      } else if (removed && params.cursor === "reach-hit") {
        send({ data: [], nextCursor: null });
      } else if (params.cursor === "stale-exact") {
        heldExact.resolve(() => send({ data: [full("late")], nextCursor: null }));
      } else {
        const selectedHit = emptyHead && params.cursor === "inclusive" ? { ...hit, status: "inProgress" } : hit;
        send({ data: params.cursor === "older" ? [neighbor, hit] : [selectedHit], nextCursor: null });
      }
    } else send(method.endsWith("/list") ? { data: [], nextCursor: null } : {});
  } });
  const saved = new Map<string, string>();
  const displayStorage = { async load(key: string) { return saved.get(key) ?? null; },
    async save(key: string, value: string) { saved.set(key, value); },
    async remove(key: string) { saved.delete(key); } };
  const display = () => createConversationDisplayContinuity({ namespace: "indexed-preview", storage: displayStorage });
  const cache = display();
  const runtime = createAppServerWorkbenchRuntime({ hostId: "search", transport, autoReconnect: false });
  try {
    await runtime.connect();
    const lease = await runtime.acquireThread("thread");
    lease.setRecoveryVisibility(true);
    for (let i = 0; i < 50 && !lease.getSnapshot().authoritative; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(lease.getSnapshot().authoritative, true);
    const baseline = lease.getSnapshot().timeline;
    assert.deepEqual(baseline.frames.map(frame => frame.turnId), emptyHead ? [] : [head.id]);
    if (!emptyHead) {
      const cachedOlder = { ...baseline.frames[0]!, id: "neighbor", turnId: asTurnId(neighbor.id) };
      await cache.observe({ ...baseline, frames: [cachedOlder, ...baseline.frames] }, true);
    }
    const savedBeforeSearch = [...saved.values()][0];
    await lease.getNavigation().prepare();
    const selected = await prepareSearchNavigationTarget(lease.getNavigation(), {
      turnId: hit.id, itemId: "indexed-hit-answer", turnCursor: "inclusive",
    }, AbortSignal.timeout(1000));
    assert.equal(selected?.itemId, "indexed-hit-answer");
    const focused = lease.getSnapshot().timeline;
    assert.ok(focused.frames.some(frame => frame.turnId === hit.id));
    assert.equal(focused.unplacedSearchTurnId, undefined, "the provider index knows the relative order");
    assert.deepEqual([...(focused.outsideHistoryWindowTurnIds ?? [])], [hit.id]);
    assert.equal(lease.getSnapshot().activeTurn, null, "an isolated history observation cannot establish an active task");
    assert.equal(lease.getSnapshot().history.cursor, "older");
    await cache.observe(focused, true);
    assert.equal([...saved.values()][0], savedBeforeSearch, "indexing and exact navigation leave the preview intact");
    assert.deepEqual((await display().load("search", "thread"))?.frames.map(frame => frame.turnId),
      emptyHead ? undefined : [neighbor.id, head.id]);
    await lease.loadOlder();
    if (emptyHead) {
      const intermediate = lease.getSnapshot().timeline;
      assert.deepEqual(intermediate.frames.map(frame => frame.turnId), [hit.id, neighbor.id]);
      assert.deepEqual([...(intermediate.outsideHistoryWindowTurnIds ?? [])], [hit.id]);
      await cache.observe(intermediate, true);
      assert.deepEqual((await display().load("search", "thread"))?.frames.map(frame => frame.turnId), [neighbor.id]);
      const pending = removed ? lease.getNavigation().prepareLocatedTarget!({
        turnId: "late", itemId: "late-answer", turnCursor: "stale-exact",
      }, AbortSignal.timeout(1000)) : null;
      const releaseExact = pending ? await heldExact.promise : null;
      await lease.loadOlder();
      releaseExact?.();
      if (pending) assert.equal(await pending, null, "an old exact read cannot restore a Turn after coverage settles");
    }
    assert.deepEqual(reads, [[null, "notLoaded"], ["older", "notLoaded"], ["inclusive", "full"], ["older", "full"],
      ...(removed ? [["stale-exact", "full"]] : []), ...(emptyHead ? [["reach-hit", "full"]] : [])]);
    assert.equal(lease.getSnapshot().timeline.outsideHistoryWindowTurnIds, undefined);
    await cache.observe(lease.getSnapshot().timeline, false);
    const finalTurns = removed ? [neighbor.id] : emptyHead ? [hit.id, neighbor.id] : [hit.id, neighbor.id, head.id];
    assert.deepEqual(lease.getSnapshot().timeline.frames.map(frame => frame.turnId), finalTurns);
    const navigation = lease.getNavigation().getSnapshot();
    assert.equal(navigation.completeness, "complete");
    assert.deepEqual(navigation.anchors.filter(anchor => anchor.turnKey !== boundary.id).map(anchor => anchor.turnKey), finalTurns);
    assert.deepEqual((await display().load("search", "thread"))?.frames.map(frame => frame.turnId),
      finalTurns);
    lease.release();
  } finally { await runtime.dispose(); }
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

test("canceling search positioning releases its waiter while the shared navigation scan is pending", async () => {
  const { waitForSearchNavigationAnchor } = await import("../../apps/workbench-web/src/runtime/conversation-search-navigation");
  const preparation = Promise.withResolvers<void>();
  let subscriptions = 0;
  const source = {
    prepare: () => preparation.promise,
    getSnapshot: () => ({ revision: 0, phase: "empty" as const, generation: null, completeness: "partial" as const, anchors: [], error: null }),
    subscribe: () => { subscriptions++; return () => {}; },
    prepareTarget: async () => null, loadPreview: async () => null, dispose: () => {},
  };
  const abort = new AbortController();
  let canceled = false;
  const waiting = waitForSearchNavigationAnchor(source, { turnId: "old", itemId: "target" }, abort.signal)
    .catch(error => { assert.equal(error.name, "AbortError"); canceled = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    abort.abort();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(canceled, true);
  } finally {
    preparation.resolve();
    await waiting;
  }
  assert.equal(subscriptions, 0);
});

for (const alreadyLoaded of [true, false]) {
  test(`search opens a tool-only Turn from passive history, materialized=${alreadyLoaded}`, async () => {
    const { MemoryTransport } = await import("@opencraft/appserver-transport-memory");
    const { createAppServerWorkbenchRuntime } = await import("@opencraft/workbench-runtime");
    const { waitForSearchNavigationAnchor } = await import("../../apps/workbench-web/src/runtime/conversation-search-navigation");
    const target = { turnId: "tools", itemId: "result" };
    const toolTurn = { id: target.turnId, status: "completed", itemsView: "full",
      items: [{ id: target.itemId, type: "commandExecution", command: "inspect", aggregatedOutput: "Found result" }] };
    const latest = { id: "latest", status: "completed", itemsView: "full", items: [] };
    const methods: string[] = [], pages: Array<[unknown, unknown]> = [];
    const transport = new MemoryTransport({ receive(frame, peer) {
      const { id, method, params } = JSON.parse(frame);
      if (id === undefined) return;
      methods.push(method);
      const send = (result: unknown) => peer.send(JSON.stringify({ id, result }));
      if (method === "initialize") send({ codexHome: "/fixture", userAgent: "read-only-search",
        capabilities: { extensions: { "opencraft/read-history": { version: 1, initialTurnsPage: true } } } });
      else if (method === "thread/read") send({
        thread: { id: "thread", cwd: "/fixture", status: { type: "idle" }, historyMode: "paginated", turns: [] },
        initialTurnsPage: alreadyLoaded ? { data: [latest, toolTurn], nextCursor: null } : { data: [latest], nextCursor: "older" },
      });
      else if (method === "thread/turns/list") {
        pages.push([params.cursor, params.itemsView]);
        if (params.cursor === null) send({ data: [latest], nextCursor: "older" });
        else send({ data: [params.itemsView === "full" ? toolTurn : { id: toolTurn.id, itemsView: "notLoaded", items: [] }], nextCursor: null });
      } else send(method.endsWith("/list") ? { data: [], nextCursor: null } : {});
    } });
    const runtime = createAppServerWorkbenchRuntime({ hostId: "search", transport, autoReconnect: false });
    try {
      await runtime.connect();
      const lease = await runtime.acquireThread("thread");
      lease.setRecoveryVisibility(true);
      for (let i = 0; i < 50 && !lease.getSnapshot().authoritative; i++) await new Promise(resolve => setImmediate(resolve));
      assert.equal(lease.getSnapshot().authoritative, true);
      const source = lease.getNavigation();
      const signal = AbortSignal.timeout(800);
      const anchor = await waitForSearchNavigationAnchor(source, target, signal);
      const result = await source.prepareTarget(anchor.id, { itemId: target.itemId, signal });
      assert.equal(result?.turnKey, target.turnId);
      assert.equal(result?.itemId, target.itemId);
      assert.deepEqual(pages, alreadyLoaded ? [] : [[null, "notLoaded"], ["older", "notLoaded"], ["older", "full"]]);
      assert.equal(methods.some(method => method === "thread/resume" || method === "turn/start"), false);
      await transport.close();
      assert.equal(await source.prepareTarget(anchor.id, { itemId: target.itemId }), null);
      lease.release();
    } finally { await runtime.dispose(); }
  });
}

test("a replacement search can use the runtime port before the cancelled query's late reply", async () => {
  const { MemoryTransport } = await import("@opencraft/appserver-transport-memory");
  const { createAppServerWorkbenchRuntime } = await import("@opencraft/workbench-runtime");
  const received = Promise.withResolvers<void>();
  const terms: string[] = [];
  let oldReplySent = false;
  let oldReplySentAtReplacement: boolean | undefined;
  let release = () => {};
  const transport = new MemoryTransport({ receive(frame, peer) {
    const { id, method, params } = JSON.parse(frame);
    if (id === undefined) return;
    const send = (result: unknown) => peer.send(JSON.stringify({ id, result }));
    if (method === "initialize") send({ codexHome: "/fixture", userAgent: "search-cancel" });
    else if (method === "thread/search") {
      terms.push(params.searchTerm);
      if (params.searchTerm === "obsolete") {
        release = () => { oldReplySent = true; send({ data: [], nextCursor: "stale" }); };
        received.resolve();
      } else {
        oldReplySentAtReplacement = oldReplySent;
        send({ data: [], nextCursor: null });
      }
    } else send(method.endsWith("/list") ? { data: [], nextCursor: null } : {});
  } });
  const runtime = createAppServerWorkbenchRuntime({ hostId: "search", transport, autoReconnect: false });
  try {
    await runtime.connect();
    const source = createAppServerContentSearchSource({ key: "scope", hostId: "search", label: "Search", available: true, supported: true,
      assertCurrent() {}, protocol: runtime.resources.protocol, project() { throw new Error("No matches expected"); } });
    const obsolete = new AbortController();
    const first = source.search("obsolete", null, obsolete.signal);
    const cancelled = assert.rejects(first, error => (error as { code?: string }).code === "ABORTED");
    await received.promise;
    obsolete.abort();
    const replacement = source.search("latest", null, AbortSignal.timeout(800));
    const late = setTimeout(() => release(), 400);
    try {
      await cancelled;
      assert.deepEqual(await replacement, { matches: [], nextCursor: null });
      assert.deepEqual(terms, ["obsolete", "latest"]);
      assert.equal(oldReplySentAtReplacement, false);
    } finally {
      clearTimeout(late);
      release();
    }
  } finally { await runtime.dispose(); }
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
