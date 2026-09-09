import assert from "node:assert/strict";
import test from "node:test";

import type {
  AppServerTurn,
  ReplicaJsonValue,
  ThreadTurnsListRequest,
  ThreadTurnsListResponse,
} from "@opencraft/appserver-protocol";
import {
  createCodexV3ConversationNavigationSource,
  createEmptyThreadView,
  createThreadViewReplicaProjectionBarrier,
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

test("active navigation lookup remains logarithmic and follows Codex first-visible semantics", () => {
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
      scope: "codex-thread:ssh:fixture:thread-one",
      phase: "live",
      authoritative: true,
      epoch: "codex-v3:ssh:fixture:7",
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
      { id: "turn-2:user", type: "userMessage", content: "Middle prompt" },
      { id: "turn-2:assistant", type: "agentMessage", content: "Middle answer" },
      { id: "turn-2:steer", type: "steeringUserMessage", content: "Follow-up instruction" },
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
  const source = createCodexV3ConversationNavigationSource({
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
      commitHydratedTurn(hydrated, chronologicalTurnIds) {
        const order = new Map(chronologicalTurnIds.map((id, index) => [id, index]));
        view = {
          ...view,
          revision: view.revision + 1,
          turns: [...view.turns.filter((candidate) => candidate.id !== hydrated.id), hydrated]
            .sort((left, right) => (order.get(left.id) ?? Number.MAX_SAFE_INTEGER)
              - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER)),
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
  assert.deepEqual(preview, { label: "Middle prompt", response: "Middle answer", outputs: [] });
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
    generation: "codex-v3:ssh:fixture:7",
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

test("V3 source fails closed when the bounded prompt-index scan is incomplete", async () => {
  const view = { ...createEmptyThreadView("local", "long-thread"), resumeState: "resumed" as const };
  const source = createCodexV3ConversationNavigationSource({
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
