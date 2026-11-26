import assert from "node:assert/strict";
import test from "node:test";

import { AppServerRpcError, projectedTurnsPage } from "@opencraft/appserver-client";
import type {
  AppServerTurn,
  ReplicaJsonValue,
  ThreadTurnsListRequest,
  ThreadTurnsListResponse,
} from "@opencraft/appserver-protocol";
import {
  createV3ConversationNavigationSource,
  createEmptyThreadView,
  createThreadViewReplicaProjectionBarrier,
  mergeTurns,
  reconcileHydratedTurn,
  type ThreadView,
  type ThreadViewProjectionReplica,
} from "@opencraft/appserver-session";
import {
  MemoryReplicaStorage,
  ReplicaAuthority,
  ReplicaClient,
} from "@opencraft/appserver-replica";
import {
  ConversationNavigationController,
  createReplicaConversationNavigationSource,
  findAnchorAtOrBefore,
  findFirstVisibleAnchor,
  THREAD_NAVIGATION_ENTITY_KIND,
  threadNavigationReplicaScope,
  type ConversationNavigationAnchor,
  type ConversationNavigationPreview,
  type ConversationNavigationSource,
} from "@opencraft/chat-navigation";

function turn(id: string, prompt?: string, response?: string): AppServerTurn {
  return {
    id,
    items: prompt === undefined ? [] : [
      { id: `${id}:user`, type: "userMessage", content: prompt },
      { id: `${id}:agent`, type: "agentMessage", content: response ?? "" },
    ],
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error("Timed out waiting for navigation state"));
        return;
      }
      setTimeout(poll, 1);
    };
    poll();
  });
}

function anchor(id: string, order: number): ConversationNavigationAnchor {
  return {
    id,
    turnKey: `turn:${id}`,
    itemId: `item:${id}`,
    order,
    label: id,
    isLoaded: true,
    isHeartbeat: false,
  };
}

test("active navigation lookup remains logarithmic and follows first-visible semantics", () => {
  const anchors = [anchor("a", 10), anchor("b", 20), anchor("c", 30), anchor("d", 40)];
  assert.equal(findAnchorAtOrBefore(anchors, 9), null);
  assert.equal(findAnchorAtOrBefore(anchors, 30)?.id, "c");
  assert.equal(findAnchorAtOrBefore(anchors, 39)?.id, "c");
  assert.equal(findFirstVisibleAnchor(anchors, new Set(["item:c", "item:b"]))?.id, "b");
  assert.equal(findFirstVisibleAnchor(anchors, new Set())?.id, "d");
});

test("projection barrier resolves only the exact ThreadView commit and is abortable", async () => {
  const listeners = new Set<() => void>();
  let replicaRevision = 1;
  let projectedRevision = 4;
  const replica: ThreadViewProjectionReplica = {
    get: () => ({
      hostId: "ssh:fixture",
      threadId: "thread-one",
      connectionGeneration: 7,
      revision: projectedRevision,
    }),
    getSnapshot: () => ({
      revision: replicaRevision,
      storageKey: "test",
      scope: "appserver-thread:ssh:fixture:thread-one",
      phase: "live",
      authoritative: true,
      epoch: "appserver-v3:ssh:fixture:7",
      nextSeq: replicaRevision + 1,
      journalStartSeq: 1,
      entities: new Map(),
      lastError: null,
    }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const publish = () => {
    replicaRevision += 1;
    for (const listener of listeners) listener();
  };
  const barrier = createThreadViewReplicaProjectionBarrier(replica);
  const commit = {
    hostId: "ssh:fixture",
    threadId: "thread-one",
    connectionGeneration: 7,
    viewRevision: 6,
  };
  let settled = false;
  const operation = barrier.waitUntilProjected(commit).finally(() => {
    settled = true;
  });
  projectedRevision = 5;
  publish();
  await Promise.resolve();
  assert.equal(settled, false, "an unrelated/intermediate Replica publication is not the commit");
  projectedRevision = 6;
  publish();
  assert.equal(await operation, 3, "barrier returns the exact Replica revision owned by Timeline projection");

  const controller = new AbortController();
  const aborted = barrier.waitUntilProjected({ ...commit, viewRevision: 7 }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(aborted, (error: unknown) => error instanceof Error && error.name === "AbortError");
});

test("V3 source enumerates lightweight Turns and hydrates only the hovered Turn", async () => {
  const middleTurn: AppServerTurn = {
    id: "turn-2",
    items: [
      { id: "turn-2:user", type: "userMessage", content: "Middle prompt", sender: { kind: "employee", loginName: "alice" } },
      { id: "turn-2:assistant", type: "agentMessage", content: "Middle answer" },
      { id: "turn-2:steer", type: "steeringUserMessage", content: "Follow-up instruction", sender: { kind: "employee", loginName: "bob" } },
      { id: "turn-2:assistant-2", type: "agentMessage", content: "Follow-up answer" },
    ],
    status: "completed",
  };
  let view: ThreadView = {
    ...createEmptyThreadView("ssh:fixture", "thread-one"),
    resumeState: "resumed",
    connectionGeneration: 7,
    turns: [turn("turn-3", "Newest", "latest response")],
  };
  const listeners = new Set<() => void>();
  const calls: ThreadTurnsListRequest[] = [];
  let releaseRendererPublication = () => undefined;
  const rendererPublication = new Promise<void>((resolve) => {
    releaseRendererPublication = resolve;
  });
  const listTurns = async (params: ThreadTurnsListRequest): Promise<ThreadTurnsListResponse> => {
    calls.push(params);
    if (params.itemsView === "full" && params.cursor === "after-turn-3") {
      return { data: [middleTurn], nextCursor: "older" };
    }
    if (params.itemsView === "notLoaded" && params.cursor === null && params.limit === 1) {
      return { data: [turn("turn-3")], nextCursor: "after-turn-3" };
    }
    if (params.cursor === null) {
      return { data: [turn("turn-3"), turn("turn-2")], nextCursor: "older", backwardsCursor: null };
    }
    if (params.cursor === "older") {
      return { data: [turn("turn-1")], nextCursor: null, backwardsCursor: "older" };
    }
    throw new Error(`Unexpected cursor ${params.cursor}`);
  };
  const source = createV3ConversationNavigationSource({
    threadId: "thread-one",
    pageSize: 2,
    port: {
      getView: () => view,
      subscribeView(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      listTurns,
      projectionBarrier: {
        waitUntilProjected: async () => {
          await rendererPublication;
          return 23;
        },
      },
      commitHydratedTurn(hydrated, chronologicalTurnIds, baselineTurn) {
        view = {
          ...view,
          revision: view.revision + 1,
          turns: reconcileHydratedTurn(view.turns, hydrated, chronologicalTurnIds, { turn: baselineTurn }),
        };
        for (const listener of listeners) listener();
        return {
          hostId: view.hostId,
          threadId: view.threadId,
          connectionGeneration: view.connectionGeneration,
          viewRevision: view.revision,
        };
      },
    },
  });

  await source.prepare();
  assert.equal(source.getSnapshot().completeness, "complete");
  assert.deepEqual(source.getSnapshot().anchors.map((item) => item.turnKey), ["turn-1", "turn-2", "turn-3"]);
  assert.deepEqual(calls.map((call) => [call.itemsView, call.cursor, call.limit]), [
    ["notLoaded", null, 2],
    ["notLoaded", "older", 2],
  ]);
  const topologyBeforeHydration = source.getSnapshot().anchors.map(({ id, order, turnKey }) => ({
    id,
    order,
    turnKey,
  }));

  const middleAnchor = source.getSnapshot().anchors.find((item) => item.turnKey === "turn-2");
  assert.ok(middleAnchor);
  const preview = await source.loadPreview(middleAnchor.id);
  assert.deepEqual(preview, { sender: { kind: "employee", loginName: "alice" }, label: "Middle prompt", response: "Middle answer", outputs: [] });
  assert.deepEqual(calls.slice(2).map((call) => [call.itemsView, call.cursor, call.limit]), [
    ["notLoaded", null, 1],
    ["full", "after-turn-3", 1],
  ]);
  assert.deepEqual(
    source.getSnapshot().anchors.map(({ id, order, turnKey }) => ({ id, order, turnKey })),
    topologyBeforeHydration,
    "preview hydration may enrich a V3 marker but cannot expand or move the rail",
  );
  assert.equal(view.turns.some((candidate) => candidate.id === "turn-2"), false, "preview must not mutate the visible timeline");

  let preparationSettled = false;
  const preparation = source.prepareTarget(middleAnchor.id).finally(() => {
    preparationSettled = true;
  });
  await waitFor(() => view.turns.some((candidate) => candidate.id === "turn-2"));
  await Promise.resolve();
  assert.equal(preparationSettled, false, "target preparation must await projection commit");
  releaseRendererPublication();
  const prepared = await preparation;
  assert.deepEqual(prepared, {
    turnKey: "turn-2",
    itemId: "turn-2:user",
    anchorId: "v3:turn-2:user:0",
    generation: source.getSnapshot().generation,
    projectionRevision: 23,
    targetVersion: '["turn-2","turn-2:user"]',
  });
  assert.equal(view.turns.some((candidate) => candidate.id === "turn-2"), true);
  assert.deepEqual(
    source.getSnapshot().anchors.map(({ id, order, turnKey }) => ({ id, order, turnKey })),
    topologyBeforeHydration,
    "navigation hydration preserves marker identity and geometry",
  );
  assert.equal(calls.length, 4, "target preparation reuses the preview hydration");
  source.dispose();
});

test("V3 navigation carries the pre-read baseline through cached preview hydration", async () => {
  const baseline: AppServerTurn = { id: "target", status: "inProgress", itemsView: "summary",
    items: [{ id: "answer", type: "agentMessage", text: "A" }] };
  let view: ThreadView = { ...createEmptyThreadView("local", "thread-one"), resumeState: "resumed",
    connectionGeneration: 7, turns: [turn("older", "Earlier"), baseline, turn("newer", "Later")] };
  let release: (value: ThreadTurnsListResponse) => void = () => undefined;
  const held = new Promise<ThreadTurnsListResponse>(resolve => { release = resolve; });
  let readStarted = false;
  const source = createV3ConversationNavigationSource({ threadId: "thread-one", port: {
    getView: () => view,
    subscribeView: () => () => undefined,
    listTurns: async params => {
      if (params.itemsView === "notLoaded") return { data: [{ id: "target", items: [] }], nextCursor: null };
      readStarted = true;
      return held;
    },
    projectionBarrier: { waitUntilProjected: async () => 10 },
    commitHydratedTurn(hydrated, positions, baselineTurn) {
      assert.strictEqual(baselineTurn, baseline, "the cached preview must retain its request baseline, not current View");
      view = { ...view, revision: view.revision + 1,
        turns: reconcileHydratedTurn(view.turns, hydrated, positions, { turn: baselineTurn }) };
      return { hostId: view.hostId, threadId: view.threadId, connectionGeneration: 7, viewRevision: view.revision };
    },
  } });
  try {
    await source.prepare();
    const marker = source.getSnapshot().anchors.find(anchor => anchor.turnKey === "target")!;
    const preview = source.loadPreview(marker.id);
    await waitFor(() => readStarted);
    view = { ...view, turns: mergeTurns(view.turns, [{ id: "target", items: [
      { id: "answer", type: "agentMessage", text: "AB" },
      { id: "next", type: "agentMessage", text: "New reply" },
    ] }]) };
    release({ data: [{ ...baseline, itemsView: "full", items: [
      { id: "user", type: "userMessage", content: "Prompt" }, ...baseline.items!,
    ] }], nextCursor: null });
    await preview;
    assert.ok(await source.prepareTarget(marker.id));
    assert.deepEqual(view.turns.map(turn => turn.id), ["older", "target", "newer"]);
    assert.deepEqual(view.turns[1]?.items?.map(item => item.id), ["user", "answer", "next"]);
    assert.equal(view.turns[1]?.items?.[1]?.text, "AB");
  } finally { release({ data: [], nextCursor: null }); source.dispose(); }
});

test("V3 previews and explicit jumps complete a partially loaded Turn without changing the marker ID", async () => {
  const original = { id: "original", type: "userMessage", content: "First prompt" };
  const steering = { id: "steering", type: "steeringUserMessage", content: "Later steering" };
  const items = [original, { id: "original-answer", type: "agentMessage", text: "First answer" },
    steering, { id: "steering-answer", type: "agentMessage", text: "Later answer" }];
  const fullTurn: AppServerTurn = { id: "target", itemsView: "full", items };
  const partialTurn: AppServerTurn = { ...fullTurn, itemsView: "summary", items: items.slice(2) };
  let view: ThreadView = { ...createEmptyThreadView("local", "thread-one"), resumeState: "resumed", turns: [partialTurn] };
  const listeners = new Set<() => void>();
  let fullReads = 0;
  const source = createV3ConversationNavigationSource({ threadId: view.threadId, port: {
    getView: () => view,
    subscribeView(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async listTurns(params) {
      if (params.itemsView === "full") {
        fullReads++;
        return { data: [fullTurn], nextCursor: null };
      }
      return { data: [{ id: fullTurn.id }], nextCursor: null };
    },
    projectionBarrier: { waitUntilProjected: async commit => commit.viewRevision },
    commitHydratedTurn(hydrated, order, baseline) {
      assert.equal(baseline, partialTurn);
      view = { ...view, revision: view.revision + 1,
        turns: reconcileHydratedTurn(view.turns, hydrated, order, { turn: baseline }) };
      for (const listener of listeners) listener();
      return { hostId: view.hostId, threadId: view.threadId, connectionGeneration: view.connectionGeneration, viewRevision: view.revision };
    },
  } });
  try {
    await source.prepare();
    const marker = source.getSnapshot().anchors[0]!;
    assert.equal((await source.prepareTarget(marker.id, { itemId: steering.id }))?.itemId, steering.id);
    assert.equal(fullReads, 0);
    assert.equal(marker.isLoaded, false);
    assert.equal(marker.itemId, null);
    const [preview, target] = await Promise.all([
      source.loadPreview(marker.id),
      source.prepareTarget(marker.id, { itemId: original.id }),
    ]);
    assert.deepEqual(preview, { label: "First prompt", response: "First answer", outputs: [] });
    assert.equal(target?.itemId, original.id);
    assert.equal(fullReads, 1);
    assert.equal(source.getSnapshot().anchors[0]?.id, marker.id);
    assert.equal(source.getSnapshot().anchors[0]?.itemId, original.id);
    assert.equal(source.getSnapshot().anchors[0]?.isLoaded, true);
  } finally { source.dispose(); }
});

test("V3 navigation keeps the first locator and its original offset across overlapping pages", async () => {
  const view = { ...createEmptyThreadView("local", "thread-one"), resumeState: "resumed" as const };
  const calls: Array<[string | null, number | null | undefined, string | undefined]> = [];
  let committedOrder: readonly string[] = [];
  const commit = { hostId: view.hostId, threadId: view.threadId, connectionGeneration: view.connectionGeneration, viewRevision: 1 };
  const source = createV3ConversationNavigationSource({ threadId: view.threadId, pageSize: 4, port: {
    getView: () => view,
    subscribeView: () => () => undefined,
    async listTurns({ cursor, limit, itemsView }) {
      calls.push([cursor ?? null, limit, itemsView]);
      if (cursor === "at-middle" && itemsView === "full")
        return { data: [turn("middle", "Middle prompt", "Middle answer")], nextCursor: "older" };
      if (cursor === null && limit === 2)
        return { data: [turn("latest"), turn("latest")], nextCursor: "at-middle" };
      if (cursor === null)
        return { data: ["latest", "latest", "middle", "oldest-loaded"].map(id => turn(id)), nextCursor: "older" };
      return { data: [turn("middle"), turn("earlier")], nextCursor: null };
    },
    projectionBarrier: { waitUntilProjected: async () => 1 },
    commitHydratedTurn(hydrated, ids) {
      assert.equal(hydrated.id, "middle");
      committedOrder = ids;
      return commit;
    },
  } });
  try {
    await source.prepare();
    const order = ["earlier", "oldest-loaded", "middle", "latest"];
    assert.deepEqual(source.getSnapshot().anchors.map(anchor => anchor.turnKey), order);
    const middle = source.getSnapshot().anchors[2]!;
    assert.equal((await source.loadPreview(middle.id))?.response, "Middle answer");
    assert.equal((await source.prepareTarget(middle.id))?.turnKey, "middle");
    assert.deepEqual(committedOrder, order);
    assert.deepEqual(calls, [
      [null, 4, "notLoaded"], ["older", 4, "notLoaded"], [null, 2, "notLoaded"], ["at-middle", 1, "full"],
    ]);
  } finally { source.dispose(); }
});

test("V3 navigation replays the original page cursor in a projected history reader", async () => {
  const view = { ...createEmptyThreadView("local", "thread-one"), resumeState: "resumed" as const };
  const turns = ["oldest", "middle", "latest"].map(id => {
    const row = turn(id, id, `${id} answer`);
    return { ...row, items: [...row.items!] };
  });
  const source = createV3ConversationNavigationSource({ threadId: view.threadId, pageSize: 2, port: {
    getView: () => view,
    subscribeView: () => () => undefined,
    async listTurns(params) {
      return projectedTurnsPage({ id: view.threadId, turns }, params) as ThreadTurnsListResponse;
    },
    projectionBarrier: { waitUntilProjected: async () => 1 },
    commitHydratedTurn: () => ({
      hostId: view.hostId, threadId: view.threadId, connectionGeneration: view.connectionGeneration, viewRevision: view.revision,
    }),
  } });
  try {
    await source.prepare();
    for (const anchor of source.getSnapshot().anchors) {
      assert.equal((await source.loadPreview(anchor.id))?.response, `${anchor.turnKey} answer`);
    }
  } finally { source.dispose(); }
});

test("V3 navigation counts actual rows when a locator seek returns a short page", async () => {
  const view = { ...createEmptyThreadView("local", "thread-one"), resumeState: "resumed" as const };
  const reads: Array<[string | null, number | null | undefined, string | undefined]> = [];
  const source = createV3ConversationNavigationSource({ threadId: view.threadId, pageSize: 3, port: {
    getView: () => view,
    subscribeView: () => () => undefined,
    async listTurns({ cursor, limit, itemsView }) {
      reads.push([cursor ?? null, limit, itemsView]);
      if (cursor === null && limit === 3)
        return { data: ["latest", "middle", "target"].map(id => turn(id)), nextCursor: null };
      if (cursor === null) return { data: [turn("latest")], nextCursor: "middle" };
      if (cursor === "middle") return { data: [turn("middle")], nextCursor: "target" };
      return { data: [turn("target", "Target prompt", "Target answer")], nextCursor: null };
    },
    projectionBarrier: { waitUntilProjected: async () => 1 },
    commitHydratedTurn: () => ({
      hostId: view.hostId, threadId: view.threadId, connectionGeneration: view.connectionGeneration, viewRevision: view.revision,
    }),
  } });
  try {
    await source.prepare();
    const target = source.getSnapshot().anchors[0]!;
    assert.equal((await source.loadPreview(target.id))?.response, "Target answer");
    assert.deepEqual(reads, [
      [null, 3, "notLoaded"], [null, 2, "notLoaded"], ["middle", 1, "notLoaded"], ["target", 1, "full"],
    ]);
  } finally { source.dispose(); }
});

test("V3 adopts a completed history View after a capped index scan", async () => {
  let view: ThreadView = { ...createEmptyThreadView("local", "thread"), resumeState: "resumed",
    historyMode: "paginated", historyCheckpoint: { epoch: "stable", nextSeq: 4 },
    turns: [turn("latest", "Latest")],
    turnsPagination: { olderCursor: "older", oldestLoadedTurnId: "latest", hasLoadedOldest: false, isLoadingOlder: false } };
  let notify = () => {};
  const cursors: (string | null)[] = [];
  const source = createV3ConversationNavigationSource({ threadId: view.threadId, maxPages: 1, port: {
    getView: () => view,
    subscribeView(listener) { notify = listener; return () => {}; },
    async listTurns({ cursor }) { cursors.push(cursor); return { data: [turn("middle")], nextCursor: "more" }; },
    projectionBarrier: { waitUntilProjected: async commit => commit.viewRevision },
    commitHydratedTurn() { throw new Error("A materialized target does not need a new commit"); },
  } });
  try {
    await source.prepare();
    const partial = source.getSnapshot();
    assert.equal(partial.completeness, "partial");
    view = { ...view, revision: 8, tailHydrationComplete: true,
      turns: [turn("earliest", "First prompt"), turn("middle", "Middle prompt"), ...view.turns],
      turnsPagination: { ...view.turnsPagination, olderCursor: null, oldestLoadedTurnId: "earliest", hasLoadedOldest: true } };
    notify();
    const full = source.getSnapshot();
    assert.equal(full.phase, "ready");
    assert.equal(full.completeness, "complete");
    assert.equal(full.generation, partial.generation);
    assert.deepEqual(full.anchors.map(anchor => anchor.turnKey), ["earliest", "middle", "latest"]);
    assert.equal((await source.prepareTarget(full.anchors[0]!.id))?.projectionRevision, 8);
    await source.prepare();
    assert.deepEqual(cursors, ["older"]);
  } finally { source.dispose(); }
});

test("V3 reads locally indexed partial Turns by ID even when a live Turn is not in provider history", async () => {
  const older = { ...turn("older", "Original prompt", "Original reply"), itemsView: "full" as const };
  const persisted = [older, turn("latest", "Latest")];
  let view: ThreadView = { ...createEmptyThreadView("local", "thread"), resumeState: "resumed", historyMode: "paginated",
    turns: [{ ...older, itemsView: "summary", items: [] }, persisted[1]!, { id: "live", status: "inProgress" }],
    turnsPagination: { olderCursor: null, oldestLoadedTurnId: older.id, hasLoadedOldest: true, isLoadingOlder: false } };
  const turnReads: number[] = [];
  const itemReads: string[] = [];
  const source = createV3ConversationNavigationSource({ threadId: view.threadId, port: {
    getView: () => view,
    subscribeView: () => () => {},
    async listTurns(params) {
      turnReads.push(params.limit ?? 0);
      const turns = persisted.map(row => ({ ...row, items: [...row.items!] }));
      return projectedTurnsPage({ id: view.threadId, turns }, params) as ThreadTurnsListResponse;
    },
    async listItems({ turnId }) {
      itemReads.push(turnId);
      return { data: older.items!.map(item => ({ turnId, item })), nextCursor: null };
    },
    projectionBarrier: { waitUntilProjected: async commit => commit.viewRevision },
    commitHydratedTurn(hydrated, order, baseline) {
      view = { ...view, revision: view.revision + 1, turns: reconcileHydratedTurn(view.turns, hydrated, order, { turn: baseline }) };
      return { hostId: view.hostId, threadId: view.threadId, connectionGeneration: view.connectionGeneration, viewRevision: view.revision };
    },
  } });
  try {
    await source.prepare();
    const marker = source.getSnapshot().anchors.find(anchor => anchor.turnKey === older.id)!;
    assert.equal((await source.loadPreview(marker.id))?.response, "Original reply");
    assert.equal((await source.prepareTarget(marker.id, { itemId: "older:user" }))?.itemId, "older:user");
    assert.deepEqual(turnReads, []);
    assert.deepEqual(itemReads, ["older"]);
  } finally { source.dispose(); }
});

test("V3 navigation falls back to bounded Item pages when a whole Turn exceeds the response budget", async () => {
  const oversized = new AppServerRpcError({ code: -32072, message: "History response exceeds budget" });
  const items = turn("target", "Original prompt", "Original reply").items!;
  const reads: string[] = [];
  let view: ThreadView = { ...createEmptyThreadView("local", "thread-one"), resumeState: "resumed" };
  let oneItemTooLarge = true;
  const source = createV3ConversationNavigationSource({ threadId: view.threadId, port: {
    getView: () => view,
    subscribeView: () => () => undefined,
    async listTurns({ itemsView }) {
      reads.push(itemsView);
      if (itemsView === "full") throw oversized;
      return { data: [{ id: "target", itemsView: "notLoaded", items: [] }], nextCursor: null };
    },
    async listItems({ threadId, turnId, cursor, limit, sortDirection }) {
      assert.deepEqual([threadId, turnId, sortDirection], [view.threadId, "target", "asc"]);
      reads.push(`items:${cursor}:${limit}`);
      if (limit > 1 || oneItemTooLarge) throw oversized;
      return cursor === null
        ? { data: [{ turnId, item: items[0]!, startedAtMs: 10 }], nextCursor: "reply" }
        : { data: [{ turnId, item: items[1]! }], nextCursor: null };
    },
    projectionBarrier: { waitUntilProjected: async commit => commit.viewRevision },
    commitHydratedTurn(hydrated) {
      view = { ...view, revision: view.revision + 1, turns: [hydrated] };
      return { hostId: view.hostId, threadId: view.threadId, connectionGeneration: view.connectionGeneration, viewRevision: view.revision };
    },
  } });
  try {
    await source.prepare();
    const anchor = source.getSnapshot().anchors[0]!;
    await assert.rejects(source.loadPreview(anchor.id), error => error === oversized);
    assert.equal(reads.at(-1), "items:null:1");
    assert.deepEqual(view.turns, []);
    reads.length = 0;
    oneItemTooLarge = false;
    const [preview, target] = await Promise.all([
      source.loadPreview(anchor.id), source.prepareTarget(anchor.id, { itemId: "target:user" }),
    ]);
    assert.equal(preview?.response, "Original reply");
    assert.equal(target?.itemId, "target:user");
    assert.equal(view.turns[0]?.itemsView, "full");
    assert.equal(view.turns[0]?.items?.[0]?.startedAtMs, 10);
    assert.deepEqual(reads, ["full", "notLoaded", ...[100, 50, 25, 12, 6, 3, 1].map(limit => `items:null:${limit}`), "items:reply:1"]);
  } finally { source.dispose(); }
});

test("V3 cancels an Item fallback when the navigation checkpoint changes", async () => {
  let view: ThreadView = { ...createEmptyThreadView("local", "thread-one"), resumeState: "resumed", connectionGeneration: 1 };
  let notify = () => {};
  let itemSignal: AbortSignal | undefined;
  let itemReads = 0;
  const held = Promise.withResolvers<import("@opencraft/appserver-protocol").ThreadItemsListResponse>();
  const oversized = new AppServerRpcError({ code: -32072, message: "History response exceeds budget" });
  const source = createV3ConversationNavigationSource({ threadId: view.threadId, port: {
    getView: () => view,
    subscribeView(listener) { notify = listener; return () => {}; },
    async listTurns({ itemsView }) {
      if (itemsView === "full") throw oversized;
      return { data: [{ id: "target", itemsView: "notLoaded" }], nextCursor: null };
    },
    async listItems(_params, signal) { itemReads++; itemSignal = signal; return held.promise; },
    projectionBarrier: { waitUntilProjected: async () => 0 },
    commitHydratedTurn() { throw new Error("A superseded page cannot commit"); },
  } });
  try {
    await source.prepare();
    const reading = source.loadPreview(source.getSnapshot().anchors[0]!.id);
    await waitFor(() => itemSignal !== undefined);
    view = { ...view, connectionGeneration: 2 };
    notify();
    assert.equal(itemSignal?.aborted, true);
    held.resolve({ data: [{ id: "stale", type: "userMessage", content: "Old prompt" }], nextCursor: "more" });
    assert.equal(await reading, null);
    await source.prepare();
    assert.equal(itemReads, 1);
    assert.equal(source.getSnapshot().anchors[0]?.itemId, null);
  } finally {
    held.resolve({ data: [], nextCursor: null });
    source.dispose();
  }
});

test("V3 source fails closed when the bounded prompt-index scan is incomplete", async () => {
  const view = { ...createEmptyThreadView("local", "long-thread"), resumeState: "resumed" as const };
  const source = createV3ConversationNavigationSource({
    threadId: "long-thread",
    maxPages: 2,
    pageSize: 1,
    port: {
      getView: () => view,
      subscribeView: () => () => undefined,
      listTurns: async (params) => ({
        data: [turn(params.cursor === null ? "turn-3" : "turn-2")],
        nextCursor: params.cursor === null ? "older-1" : "older-2",
      }),
      projectionBarrier: { waitUntilProjected: async () => 0 },
      commitHydratedTurn: () => ({
        hostId: view.hostId,
        threadId: view.threadId,
        connectionGeneration: view.connectionGeneration,
        viewRevision: view.revision,
      }),
    },
  });
  await source.prepare();
  assert.equal(source.getSnapshot().phase, "degraded");
  assert.equal(source.getSnapshot().completeness, "partial");
  source.dispose();
});

test("V3 navigation stops at a cursor cycle and can retry from the head", async () => {
  let view = { ...createEmptyThreadView("local", "thread-one"), resumeState: "resumed" as const };
  const cursors: (string | null)[] = [];
  let repaired = false;
  let notify = () => {};
  const source = createV3ConversationNavigationSource({ threadId: view.threadId, port: {
    getView: () => view,
    subscribeView(listener) { notify = listener; return () => {}; },
    async listTurns({ cursor }) {
      cursors.push(cursor ?? null);
      if (cursor == null) return { data: [turn("latest")], nextCursor: "a" };
      if (cursor === "a") return { data: [turn("middle")], nextCursor: "b" };
      return { data: [turn("oldest")], nextCursor: repaired ? null : "a" };
    },
    projectionBarrier: { waitUntilProjected: async () => 0 },
    commitHydratedTurn: () => ({
      hostId: view.hostId, threadId: view.threadId, connectionGeneration: view.connectionGeneration, viewRevision: view.revision,
    }),
  } });
  try {
    await source.prepare();
    const failed = source.getSnapshot();
    assert.deepEqual(cursors, [null, "a", "b"]);
    assert.equal(failed.phase, "degraded");
    assert.equal(failed.completeness, "partial");
    assert.match(failed.error?.message ?? "", /repeated a cursor/u);
    assert.deepEqual(failed.anchors, []);

    for (let i = 0; i < 3; i++) {
      view = { ...view, revision: view.revision + 1 };
      notify();
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.deepEqual(cursors, [null, "a", "b"]);
    repaired = true;
    await source.prepare();
    const recovered = source.getSnapshot();
    assert.deepEqual(cursors, [null, "a", "b", null, "a", "b"]);
    assert.equal(recovered.completeness, "complete");
    assert.equal(recovered.error, null);
    assert.deepEqual(recovered.anchors.map(anchor => anchor.turnKey), ["oldest", "middle", "latest"]);
  } finally { source.dispose(); }
});

test("V4 Replica prompt index applies live entries and epoch replacement without leaking cursors to UI", async () => {
  const scope = threadNavigationReplicaScope("durable-a", "thread-one");
  const storage = new MemoryReplicaStorage<ReplicaJsonValue>();
  const authority = new ReplicaAuthority<ReplicaJsonValue>({
    scope,
    storage,
    createEpoch: () => "epoch-one",
  });
  const replica = new ReplicaClient<ReplicaJsonValue>({
    scope,
    storageKey: "navigation-client",
    storage,
    pageSize: 2,
  });
  const prepareTargetCalls: Array<{ id: string; epoch: string }> = [];
  let heldTargetPreparation: Promise<void> | null = null;
  const source = createReplicaConversationNavigationSource({
    replica,
    source: authority,
    isLoaded: (entry) => entry.turnId === "turn-2",
    prepareTarget: async (entry, epoch) => {
      prepareTargetCalls.push({ id: entry.anchorId, epoch });
      await heldTargetPreparation;
      return { turnKey: entry.turnId, itemId: entry.itemId, projectionRevision: 100 };
    },
  });
  const entity = (id: string, seq: number): ReplicaJsonValue => ({
    kind: THREAD_NAVIGATION_ENTITY_KIND,
    anchorId: id,
    timelineSeq: seq,
    turnId: `turn-${seq}`,
    itemId: `item-${seq}`,
    timestamp: null,
    promptPreview: `Prompt ${seq}`,
  });

  await authority.commit([
    { kind: "upsert", entityId: "replica-entry-2", value: entity("anchor-2", 2) },
    { kind: "upsert", entityId: "replica-entry-1", value: entity("anchor-1", 1) },
  ], { commandId: "seed" });
  await source.prepare();
  assert.equal(source.getSnapshot().generation, "epoch-one");
  assert.equal(source.getSnapshot().completeness, "complete");
  assert.deepEqual(source.getSnapshot().anchors.map((item) => item.id), ["anchor-1", "anchor-2"]);
  assert.equal(source.getSnapshot().anchors[1]?.isLoaded, true);

  await authority.commit([
    { kind: "upsert", entityId: "replica-entry-3", value: entity("anchor-3", 3) },
  ], { commandId: "append" });
  await waitFor(() => source.getSnapshot().anchors.length === 3);
  assert.deepEqual(await source.prepareTarget("anchor-1"), {
    turnKey: "turn-1",
    itemId: "item-1",
    anchorId: "anchor-1",
    generation: "epoch-one",
    projectionRevision: 100,
    targetVersion: '["turn-1","item-1"]',
  });
  assert.deepEqual(prepareTargetCalls, [{ id: "anchor-1", epoch: "epoch-one" }]);

  let releaseHeldTarget = () => undefined;
  heldTargetPreparation = new Promise<void>((resolve) => {
    releaseHeldTarget = resolve;
  });
  const staleTarget = source.prepareTarget("anchor-1");
  await waitFor(() => prepareTargetCalls.length === 2);
  await authority.commit([{
    kind: "upsert",
    entityId: "replica-entry-1",
    value: { ...entity("anchor-1", 1) as Record<string, ReplicaJsonValue>, itemId: "item-replaced" },
  }], { commandId: "replace-target-same-epoch" });
  await waitFor(() => source.getSnapshot().anchors[0]?.itemId === "item-replaced");
  releaseHeldTarget();
  assert.equal(await staleTarget, null, "same-epoch target replacement invalidates the prepared lease");
  heldTargetPreparation = null;

  await authority.commit([{
    kind: "upsert",
    entityId: "replica-entry-duplicate",
    value: entity("anchor-1", 10),
  }], { commandId: "duplicate-semantic-anchor" });
  await waitFor(() => source.getSnapshot().phase === "error");
  assert.deepEqual(source.getSnapshot().anchors, [], "duplicate semantic Anchor identities fail closed");

  await authority.replaceSnapshot([
    { entityId: "replica-entry-9", value: entity("anchor-9", 9) },
  ], "epoch-two");
  await waitFor(() => source.getSnapshot().generation === "epoch-two");
  assert.deepEqual(source.getSnapshot().anchors.map((item) => item.id), ["anchor-9"]);
  source.dispose();
  replica.dispose();
});

test("navigation controller deduplicates concurrent previews and invalidates them on generation change", async () => {
  let generation = "epoch-one";
  let previewCalls = 0;
  const listeners = new Set<() => void>();
  const source: ConversationNavigationSource = {
    getSnapshot: () => ({
      revision: 1,
      phase: "ready",
      generation,
      completeness: "complete",
      anchors: [anchor("a", 1)],
      error: null,
    }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prepare: async () => undefined,
    async loadPreview() {
      previewCalls += 1;
      await Promise.resolve();
      return { label: `preview-${previewCalls}`, response: "", outputs: [] };
    },
    prepareTarget: async () => null,
    dispose: () => undefined,
  };
  const controller = new ConversationNavigationController(source);
  const [first, second] = await Promise.all([controller.loadPreview("a"), controller.loadPreview("a")]);
  assert.deepEqual(first, second);
  assert.equal(previewCalls, 1);
  await controller.loadPreview("a");
  assert.equal(previewCalls, 1);

  const unsubscribe = controller.subscribe(() => undefined);
  generation = "epoch-two";
  for (const listener of listeners) listener();
  await controller.loadPreview("a");
  assert.equal(previewCalls, 2);
  unsubscribe();
  controller.dispose();
});

test("navigation controller never lets a stale in-flight preview repopulate a newer revision", async () => {
  let revision = 1;
  let previewCalls = 0;
  let resolveFirst: ((preview: ConversationNavigationPreview | null) => void) | null = null;
  const listeners = new Set<() => void>();
  const source: ConversationNavigationSource = {
    getSnapshot: () => ({
      revision,
      phase: "ready",
      generation: "epoch-one",
      completeness: "complete",
      anchors: [anchor("a", 1)],
      error: null,
    }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prepare: async () => undefined,
    loadPreview: async () => {
      previewCalls += 1;
      if (previewCalls > 1) return { label: "fresh", response: "", outputs: [] };
      return new Promise<ConversationNavigationPreview | null>((resolve) => {
        resolveFirst = resolve;
      });
    },
    prepareTarget: async () => null,
    dispose: () => undefined,
  };
  const controller = new ConversationNavigationController(source);
  const unsubscribe = controller.subscribe(() => undefined);
  const stale = controller.loadPreview("a");
  revision = 2;
  for (const listener of listeners) listener();
  resolveFirst?.({ label: "stale", response: "", outputs: [] });
  await stale;
  assert.equal((await controller.loadPreview("a"))?.label, "fresh");
  assert.equal(previewCalls, 2);
  unsubscribe();
  controller.dispose();
});

test("V3 recovery indexing seeds only the contiguous loaded history range", async () => {
  const view: ThreadView = { ...createEmptyThreadView("local", "thread"), resumeState: "resumed",
    historyMode: "paginated", historyCheckpoint: { epoch: "checkpoint", nextSeq: 3 },
    turns: [turn("isolated", "Previously picked from search"), turn("boundary", "Boundary"), turn("latest", "Latest")],
    turnsPagination: { olderCursor: "older", oldestLoadedTurnId: "boundary", hasLoadedOldest: false, isLoadingOlder: false },
  };
  const cursors: (string | null)[] = [];
  const source = createV3ConversationNavigationSource({ threadId: view.threadId, port: {
    getView: () => view,
    subscribeView: () => () => undefined,
    async listTurns({ cursor }) {
      cursors.push(cursor);
      return { data: ["between", "isolated", "earliest"].map(id => turn(id)), nextCursor: null };
    },
    projectionBarrier: { waitUntilProjected: async () => 0 },
    commitHydratedTurn() { throw new Error("Index only reads metadata"); },
  } });
  try {
    await source.prepare();
    assert.deepEqual(cursors, ["older"]);
    assert.deepEqual(source.getSnapshot().anchors.map(anchor => anchor.turnKey),
      ["earliest", "isolated", "between", "boundary", "latest"]);
  } finally { source.dispose(); }
});

test("V3 switches from a message window to an index in the same connection generation", async () => {
  let view: ThreadView = { ...createEmptyThreadView("local", "thread"), resumeState: "resumed", connectionGeneration: 5,
    historyMode: "message-window", tailHydrationComplete: true, turns: [turn("window", "Previous prompt")] };
  let notify = () => {};
  let scans = 0;
  const source = createV3ConversationNavigationSource({ threadId: view.threadId, port: {
    getView: () => view,
    subscribeView(listener) { notify = listener; return () => {}; },
    async listTurns() { scans++; return { data: [turn("older"), turn("oldest")], nextCursor: null }; },
    projectionBarrier: { waitUntilProjected: async () => 0 },
    commitHydratedTurn() { throw new Error("Preview does not commit history"); },
  } });
  try {
    await source.prepare();
    assert.equal(scans, 0);
    const prior = source.getSnapshot();
    const oldPreview = source.loadPreview(prior.anchors[0]!.id);
    view = { ...view, historyMode: "paginated", tailHydrationComplete: false, turns: [] };
    notify();
    await source.prepare();
    assert.equal(scans, 1);
    assert.notEqual(source.getSnapshot().generation, prior.generation);
    assert.deepEqual(source.getSnapshot().anchors.map(anchor => anchor.turnKey), ["oldest", "older"]);
    assert.equal(await oldPreview, null);
  } finally { source.dispose(); }
});

test("V3 aborts an old index read when the same checkpoint switches to a message window", async () => {
  let view: ThreadView = { ...createEmptyThreadView("local", "thread"), resumeState: "resumed",
    historyMode: "paginated", historyCheckpoint: { epoch: "stable", nextSeq: 2 } };
  let notify = () => {};
  let signal: AbortSignal | undefined;
  const held = Promise.withResolvers<ThreadTurnsListResponse>();
  const source = createV3ConversationNavigationSource({ threadId: view.threadId, port: {
    getView: () => view,
    subscribeView(listener) { notify = listener; return () => {}; },
    async listTurns(_params, operation) { signal = operation; return held.promise; },
    projectionBarrier: { waitUntilProjected: async () => 0 },
    commitHydratedTurn() { throw new Error("Old scan must not commit"); },
  } });
  try {
    let settled = false;
    const scanning = source.prepare().then(() => { settled = true; });
    await waitFor(() => signal !== undefined || source.getSnapshot().phase === "loading");
    const before = source.getSnapshot().generation;
    view = { ...view, historyMode: "message-window", tailHydrationComplete: true, turns: [turn("window", "New prompt")] };
    notify();
    await source.prepare();
    assert.equal(signal?.aborted, true);
    assert.equal(source.getSnapshot().phase, "ready");
    assert.notEqual(source.getSnapshot().generation, before);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, true, "a retired transport must not hold the original prepare call open");
    held.resolve({ data: [turn("stale")], nextCursor: null });
    await scanning;
    assert.deepEqual(source.getSnapshot().anchors.map(anchor => anchor.turnKey), ["window"]);
  } finally {
    held.resolve({ data: [], nextCursor: null });
    source.dispose();
  }
});

test("V3 publishes a single scan owner before notifying loading listeners", async () => {
  const view: ThreadView = { ...createEmptyThreadView("local", "thread"), resumeState: "resumed" };
  let repeat: Promise<void> | undefined;
  let requested = false;
  let scans = 0;
  const source = createV3ConversationNavigationSource({ threadId: view.threadId, port: {
    getView: () => view,
    subscribeView: () => () => {},
    async listTurns() { scans++; return { data: [turn("one")], nextCursor: null }; },
    projectionBarrier: { waitUntilProjected: async () => 0 },
    commitHydratedTurn() { throw new Error("Index only reads metadata"); },
  } });
  const unsubscribe = source.subscribe(() => {
    if (source.getSnapshot().phase === "loading" && !requested) {
      requested = true;
      repeat = source.prepare();
    }
  });
  try {
    const initial = source.prepare();
    await initial;
    assert.equal(repeat, initial);
    assert.equal(scans, 1);
  } finally { unsubscribe(); source.dispose(); }
});

test("V3 recovery index is demand driven, preserves unchanged reconnects and fences changed history", async () => {
  let view: ThreadView = { ...createEmptyThreadView("local", "thread-one"), resumeState: "resumed",
    historyMode: "paginated", historyCheckpoint: { epoch: "provider", nextSeq: 4 }, turns: [turn("tail-1", "One")],
    turnsPagination: { olderCursor: "older-1", oldestLoadedTurnId: "tail-1", isLoadingOlder: false, hasLoadedOldest: false } };
  const listeners = new Set<() => void>();
  let reads = 0, release!: (page: ThreadTurnsListResponse) => void;
  const stale = new Promise<ThreadTurnsListResponse>(resolve => { release = resolve; });
  const source = createV3ConversationNavigationSource({ threadId: "thread-one", port: {
    getView: () => view,
    subscribeView(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async listTurns(params) {
      reads++;
      if (params.cursor === "older-2") return stale;
      return { data: [turn(params.cursor === "older-3" ? "fresh" : "older", "Prompt")], nextCursor: null };
    },
    projectionBarrier: { waitUntilProjected: async () => 1 },
    commitHydratedTurn: () => ({ hostId: view.hostId, threadId: view.threadId, connectionGeneration: view.connectionGeneration, viewRevision: view.revision }),
  } });
  const notify = () => { for (const listener of listeners) listener(); };
  try {
    notify(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(reads, 0);
    await source.prepare(); assert.equal(reads, 1); assert.equal(source.getSnapshot().completeness, "complete");
    const stable = source.getSnapshot().generation;
    view = { ...view, connectionGeneration: view.connectionGeneration + 1 }; notify(); await source.prepare();
    assert.equal(reads, 1); assert.equal(source.getSnapshot().generation, stable);
    view = { ...view, historyCheckpoint: { epoch: "provider", nextSeq: 8 }, turns: [turn("tail-2", "Two")],
      turnsPagination: { ...view.turnsPagination, olderCursor: "older-2", oldestLoadedTurnId: "tail-2" } }; notify();
    await waitFor(() => reads === 2);
    let publishedStale = false;
    source.subscribe(() => { publishedStale ||= source.getSnapshot().anchors.some(a => a.turnKey === "stale"); });
    view = { ...view, historyCheckpoint: { epoch: "provider", nextSeq: 12 }, turns: [turn("tail-3", "Three")],
      turnsPagination: { ...view.turnsPagination, olderCursor: "older-3", oldestLoadedTurnId: "tail-3" } }; notify();
    release({ data: [turn("stale", "Obsolete")], nextCursor: null });
    await waitFor(() => reads === 3 && source.getSnapshot().phase === "ready");
    assert.equal(publishedStale, false);
    assert.deepEqual(source.getSnapshot().anchors.map(a => a.turnKey), ["fresh", "tail-3"]);
  } finally { release({ data: [], nextCursor: null }); source.dispose(); }
});

test("an explicit indexed tool target keeps its identity through hydration even without a user prompt",async()=>{
 const tool={id:"tool",type:"commandExecution",command:"synthetic",aggregatedOutput:"needle"};
 let view:ThreadView={...createEmptyThreadView("local","thread"),resumeState:"resumed",connectionGeneration:1,turns:[]};
 let removeDuringProjection=false;
 const source=createV3ConversationNavigationSource({threadId:"thread",port:{
  getView:()=>view,subscribeView:()=>()=>{},
  listTurns:async params=>({data:[{id:"tools-only",itemsView:params.itemsView,items:params.itemsView==="full"?[tool]:[]}],nextCursor:null}),
  commitHydratedTurn(hydrated){view={...view,revision:view.revision+1,turns:[hydrated]};return{hostId:view.hostId,threadId:view.threadId,connectionGeneration:1,viewRevision:view.revision};},
  projectionBarrier:{waitUntilProjected:async()=>{if(removeDuringProjection)view={...view,turns:[{id:"tools-only",items:[]}]};return 7;}},
 }});
 try {
  await source.prepare();const anchor=source.getSnapshot().anchors[0]!;
  const prepared=await source.prepareTarget(anchor.id,{itemId:"tool"});assert.equal(prepared?.itemId,"tool");assert.equal(prepared?.turnKey,"tools-only");assert.equal(prepared?.projectionRevision,7);
  assert.equal(await source.prepareTarget(anchor.id,{itemId:"missing"}),null);
  removeDuringProjection=true;assert.equal(await source.prepareTarget(anchor.id,{itemId:"tool"}),null);
 }finally{source.dispose();}
});

test("V3 anchor publications never read full response or tool payloads; previews still do", async () => {
  let promptReads=0,responseReads=0,outputReads=0,previewAllowed=false,notify=()=>{};
  const makeTurn=(response:string):AppServerTurn=>({id:"active",items:[
    {id:"user",type:"userMessage",sender:{kind:"employee",loginName:"alice"},get content(){promptReads++;return "  Prompt  "}},
    {id:"answer",type:"agentMessage",get content(){responseReads++;assert.ok(previewAllowed,"anchors must not read assistant content");return response}},
    {id:"files",type:"fileChange",get changes(){outputReads++;assert.ok(previewAllowed,"anchors must not enumerate outputs");return[{path:"/workspace/report.txt"},{path:"/workspace/report.txt"}]}},
    {id:"later",type:"steeringUserMessage",content:"A second prompt"},
    {id:"later-answer",type:"agentMessage",content:"Separate answer"},
  ]});
  let active=makeTurn("First answer");
  let view:ThreadView={...createEmptyThreadView("local","thread"),resumeState:"resumed",historyMode:"message-window",tailHydrationComplete:true,turns:[active]};
  const source=createV3ConversationNavigationSource({threadId:"thread",port:{
    getView:()=>view,subscribeView(listener){notify=listener;return()=>{}},
    async listTurns(){throw Error("anchor-only navigation must not fetch full history")},
    commitHydratedTurn(){throw Error("already-loaded target must not be recommitted")},
    projectionBarrier:{waitUntilProjected:async()=>9},
  }});
  await source.prepare();
  const first=source.getSnapshot().anchors[0]!;
  assert.equal(first.itemId,"user");assert.equal(first.label,"Prompt");
  assert.equal(promptReads,1);assert.equal(responseReads,0);assert.equal(outputReads,0);
  for(let i=0;i<3;i++){view={...view,revision:view.revision+1};notify()}
  assert.equal(promptReads,1,"immutable Turn metadata is reused");
  const target=await source.prepareTarget(first.id);
  assert.equal(target?.itemId,"user");assert.equal(responseReads,0);assert.equal(outputReads,0);
  previewAllowed=true;
  assert.deepEqual(await source.loadPreview(first.id),{sender:{kind:"employee",loginName:"alice"},label:"Prompt",response:"First answer",outputs:[{kind:"file",label:"report.txt"}]});
  assert.ok(responseReads>0&&outputReads>0);
  previewAllowed=false;
  const oldReads={responseReads,outputReads};active=makeTurn("Current answer");view={...view,revision:view.revision+1,turns:[active]};notify();
  assert.equal(source.getSnapshot().anchors.length,1,"a later steer never expands V3 topology");
  assert.deepEqual({responseReads,outputReads},oldReads);
  previewAllowed=true;
  assert.equal((await source.loadPreview(first.id))?.response,"Current answer","preview hydration must observe a replaced live Turn");
  source.dispose();
});

test("V3 empty metadata cache invalidates for late prompts and preserves heartbeat semantics", async () => {
  let notify=()=>{},itemReads=0;
  const empty:AppServerTurn={id:"late",get items(){itemReads++;return[{id:"reasoning",type:"reasoning",text:"work"}]}};
  let view:ThreadView={...createEmptyThreadView("local","thread"),resumeState:"resumed",historyMode:"message-window",tailHydrationComplete:true,turns:[empty]};
  const source=createV3ConversationNavigationSource({threadId:"thread",port:{
    getView:()=>view,subscribeView(listener){notify=listener;return()=>{}},
    async listTurns(){throw Error("not expected")},commitHydratedTurn(){throw Error("not expected")},projectionBarrier:{waitUntilProjected:async()=>1},
  }});
  assert.deepEqual(source.getSnapshot().anchors,[]);const initialReads=itemReads;
  view={...view,revision:view.revision+1};notify();assert.equal(itemReads,initialReads);
  view={...view,revision:view.revision+1,turns:[{id:"late",items:[{id:"heartbeat",type:"hookPrompt",content:"  Check  "},{id:"user",type:"userMessage",content:"Later"}]}]};notify();
  assert.deepEqual(source.getSnapshot().anchors.map(({itemId,label,isHeartbeat,isLoaded})=>({itemId,label,isHeartbeat,isLoaded})),[{itemId:"heartbeat",label:"Check",isHeartbeat:true,isLoaded:true}]);
  source.dispose();
});

test("V3 anchor metadata preserves first-eligible ordering and last-eligible duplicate Turn ownership", () => {
  const view:ThreadView={...createEmptyThreadView("local","thread"),turns:[
    {id:"duplicate",items:[]},turn("middle","Middle"),turn("duplicate","First"),
    {...turn("duplicate","Last"),items:[{id:"last",type:"steeringUserMessage",content:"Last"}]},
    {id:"duplicate",items:[]},
  ]};
  const source=createV3ConversationNavigationSource({threadId:"thread",port:{
    getView:()=>view,subscribeView:()=>()=>{},async listTurns(){throw Error("not expected")},
    commitHydratedTurn(){throw Error("not expected")},projectionBarrier:{waitUntilProjected:async()=>1},
  }});
  assert.deepEqual(source.getSnapshot().anchors.map(({turnKey,itemId,label})=>({turnKey,itemId,label})),[
    {turnKey:"middle",itemId:"middle:user",label:"Middle"},{turnKey:"duplicate",itemId:"last",label:"Last"},
  ]);
  source.dispose();
});
