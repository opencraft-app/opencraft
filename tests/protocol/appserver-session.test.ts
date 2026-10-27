import assert from "node:assert/strict";
import test from "node:test";

import { AppServerClientError, AppServerRpcError, JsonRpcAppServerClient } from "@opencraft/appserver-client";
import {
  createCordisThreadSessionRuntime,
  createThreadViewReplicaSource,
  createThreadViewFrameScheduler,
  reconcileHistoryTurns,
  type CordisThreadSessionRuntime,
  type ThreadViewFrameScheduler,
} from "@opencraft/appserver-session";
import {
  MemoryTransport,
  type InMemoryAppServer,
  type InMemoryAppServerPeer,
} from "@opencraft/appserver-transport-memory";
import {
  encodeJsonRpcMessage,
  isJsonRpcRequest,
  isJsonRpcSuccess,
  parseJsonRpcMessage,
} from "@opencraft/appserver-protocol";

interface WireRequest {
  method: string;
  params: Record<string, unknown>;
}

interface HarnessOptions {
  readHistory?: boolean;
  frameScheduler?: ThreadViewFrameScheduler;
  historyMode?: "legacy" | "paginated";
  historyRecovery?: import("@opencraft/appserver-protocol").ThreadHistoryRecovery;
  responseTurns?: readonly Record<string, unknown>[];
  initialTurnsPage?: { data: readonly Record<string, unknown>[]; nextCursor: string | null } | null;
  turnsPages?: Readonly<Record<string, { data: readonly Record<string, unknown>[]; nextCursor: string | null }>>;
  itemsByTurnId?: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  itemClocksById?: Readonly<Record<string, { startedAtMs?: unknown; completedAtMs?: unknown }>>;
  fallbackTurns?: readonly Record<string, unknown>[];
  resumeDelayMs?: number;
  turnsDelayMs?: number;
  holdTurnsResponse?: (respond: () => void) => void;
  failResume?: boolean;
  resumeErrorData?: unknown;
  oversizedFullPage?: boolean;
  historySizeError?: import("@opencraft/appserver-protocol").JsonRpcErrorObject;
  maxItemsLimit?: number;
  oversizedResumePage?: boolean;
  malformedResume?: boolean;
  emitDuringResume?: boolean;
  emitItemDuringResume?: boolean;
  requestDuringResume?: boolean;
  repeatItemCursor?: boolean;
  repeatTurnsCursor?: boolean;
  hostId?: string;
  hostKind?: "local" | "durable";
  useTailHydration?: boolean;
  drainTailHistory?: boolean;
  historyModeHint?: "legacy" | "paginated" | "message-window";
}

const initializeResult = {
  codexHome: "/tmp/appserver-session-fixture",
  platformFamily: "unix",
  platformOs: "linux",
  userAgent: "session-fixture/1",
};

function thread(id: string, turns: readonly Record<string, unknown>[] = [], historyMode = "legacy") {
  return {
    id,
    sessionId: `session:${id}`,
    name: "Fixture Thread",
    cwd: "/workspace",
    path: `/rollouts/${id}.jsonl`,
    historyMode,
    status: { type: "idle" },
    turns,
  };
}

function resumeResult(options: HarnessOptions) {
  return {
    thread: options.malformedResume ? { turns: [] } : thread("thread-one", options.responseTurns, options.historyMode),
    model: "fixture-model",
    modelProvider: "openai",
    serviceTier: "priority",
    reasoningEffort: "high",
    cwd: "/workspace",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: { type: "workspaceWrite", writableRoots: ["/workspace"] },
    activePermissionProfile: { id: "workspace" },
    runtimeWorkspaceRoots: ["/workspace"],
    instructionSources: ["/workspace/AGENTS.md"],
    turnsBackwardsCursor: options.historyMode === "paginated" ? "turns:head" : null,
    itemsBackwardsCursor: options.historyMode === "paginated" ? "items:head" : null,
    ...(options.historyRecovery === undefined ? {} : { historyRecovery: options.historyRecovery }),
    ...(options.initialTurnsPage === undefined ? {} : { initialTurnsPage: options.initialTurnsPage }),
  };
}

async function createHarness(options: HarnessOptions = {}): Promise<{
  client: JsonRpcAppServerClient;
  runtime: CordisThreadSessionRuntime;
  transport: MemoryTransport;
  requests: WireRequest[];
  approvalResponses: unknown[];
  emit(method: string, params: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}> {
  const requests: WireRequest[] = [];
  const approvalResponses: unknown[] = [];
  let connectedPeer: InMemoryAppServerPeer | null = null;
  const server: InMemoryAppServer = {
    connected(peer) {
      connectedPeer = peer;
    },
    receive(frame, peer) {
      const message = parseJsonRpcMessage(frame);
      if (isJsonRpcSuccess(message) && message.id === "resume-approval") {
        approvalResponses.push(message.result);
        return;
      }
      if (!isJsonRpcRequest(message)) return;
      const params = message.params as Record<string, unknown>;
      requests.push({ method: message.method, params });
      if (message.method === "initialize") {
        peer.send(encodeJsonRpcMessage({ id: message.id, result: { ...initializeResult, ...(options.readHistory ? { capabilities: { extensions: { "opencraft/read-history": { version: 1, initialTurnsPage: true } } } } : options.historyRecovery ? { capabilities: { extensions: { "opencraft/resume-history": { version: 1, mode: "paginated", initialTurnsPage: true, boundedRecovery: true } } } } : {}) } }));
        return;
      }
      if (message.method === "thread/read") {
        if (params.initialTurnsPage && options.oversizedResumePage) {
          peer.send(encodeJsonRpcMessage({ id: message.id, error: options.historySizeError! })); return;
        }
        const turns = params.includeTurns === true ? options.fallbackTurns ?? [] : [];
        peer.send(encodeJsonRpcMessage({
          id: message.id,
          result: { thread: thread("thread-one", turns, options.historyMode) },
        }));
        return;
      }
      if (message.method === "thread/resume") {
        if (options.oversizedResumePage && params.initialTurnsPage) {
          peer.send(encodeJsonRpcMessage({ id: message.id, error: options.historySizeError ?? { code: -32000, message: "decoded message length too large" } }));
          return;
        }
        if (options.emitDuringResume) {
          peer.send(encodeJsonRpcMessage({
            method: "thread/status/changed",
            params: { threadId: "thread-one", status: { type: "active" } },
          }));
        }
        if (options.emitItemDuringResume) {
          peer.send(encodeJsonRpcMessage({
            method: "item/completed",
            params: {
              threadId: "thread-one", turnId: "turn-ordered", completedAtMs: 30_000,
              item: { id: "post-snapshot", type: "agentMessage", phase: "commentary", text: "Later activity" },
            },
          }));
        }
        if (options.requestDuringResume) {
          peer.send(encodeJsonRpcMessage({
            id: "resume-approval",
            method: "item/permissions/requestApproval",
            params: { threadId: "thread-one", command: "pwd" },
          }));
        }
        const respond = () => {
          if (options.failResume) {
            peer.send(encodeJsonRpcMessage({
              id: message.id,
              error: { code: -32022, message: "resume failed", data: options.resumeErrorData },
            }));
          } else {
            peer.send(encodeJsonRpcMessage({ id: message.id, result: resumeResult(options) }));
          }
        };
        if ((options.resumeDelayMs ?? 0) > 0) setTimeout(respond, options.resumeDelayMs);
        else respond();
        return;
      }
      if (message.method === "thread/turns/list") {
        if (options.oversizedFullPage && params.itemsView === "full") {
          peer.send(encodeJsonRpcMessage({ id: message.id, error: options.historySizeError ?? { code: -32000, message: "decoded message length too large" } }));
          return;
        }
        const key = typeof params.cursor === "string" ? params.cursor : "null";
        const selected = options.turnsPages?.[key] ?? { data: [], nextCursor: null };
        const page = options.repeatTurnsCursor && typeof params.cursor === "string"
          ? { ...selected, nextCursor: params.cursor }
          : selected;
        const respond = () => peer.send(encodeJsonRpcMessage({ id: message.id, result: page }));
        if (options.holdTurnsResponse) options.holdTurnsResponse(respond);
        else if ((options.turnsDelayMs ?? 0) > 0) setTimeout(respond, options.turnsDelayMs);
        else respond();
        return;
      }
      if (message.method === "thread/items/list") {
        const turnId = String(params.turnId);
        const items = options.itemsByTurnId?.[turnId] ?? [];
        if (options.maxItemsLimit !== undefined && Number(params.limit) > options.maxItemsLimit) {
          peer.send(encodeJsonRpcMessage({ id: message.id, error: options.historySizeError ?? { code: -32000, message: "decoded message length too large" } })); return;
        }
        const ordered = options.maxItemsLimit !== undefined && params.sortDirection === "desc" ? [...items].reverse() : items;
        const offset = options.maxItemsLimit !== undefined && typeof params.cursor === "string" && /^items:\d+$/.test(params.cursor) ? Number(params.cursor.slice(6)) : 0;
        const selected = options.maxItemsLimit === undefined ? items : ordered.slice(offset, offset + Number(params.limit));
        peer.send(encodeJsonRpcMessage({
          id: message.id,
          result: {
            data: selected.map((item) => ({ turnId, item, ...options.itemClocksById?.[String(item.id)] })),
            nextCursor: options.repeatItemCursor && typeof params.cursor === "string" ? params.cursor
              : options.maxItemsLimit !== undefined && offset + selected.length < ordered.length ? `items:${offset + selected.length}` : null,
          },
        }));
        return;
      }
      peer.send(encodeJsonRpcMessage({
        id: message.id,
        error: { code: -32601, message: `Unknown method ${message.method}` },
      }));
    },
  };
  const transport = new MemoryTransport(server);
  const client = new JsonRpcAppServerClient({ hostId: options.hostId ?? "local", transport });
  await client.connect({ clientInfo: { name: "session-test", version: "1" } });
  const runtime = await createCordisThreadSessionRuntime({
    client,
    frameScheduler: options.frameScheduler,
    hostKind: options.hostKind,
    useTailHydration: options.useTailHydration,
    drainTailHistory: options.drainTailHistory,
    historyModeHint: options.historyModeHint,
    requestTimeoutMs: 1_000,
  });
  return {
    client,
    runtime,
    transport,
    requests,
    approvalResponses,
    async emit(method, params) {
      if (connectedPeer === null) throw new Error("Harness AppServer is not connected");
      connectedPeer.send(encodeJsonRpcMessage({ method, params }));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
    async close() {
      await runtime.dispose();
      await client.close();
    },
  };
}

function manualFrames() {
  const callbacks = new Set<() => void>();
  return {
    scheduler: { schedule(flush: () => void) { callbacks.add(flush); return () => { callbacks.delete(flush); }; } },
    tick() { for (const flush of [...callbacks]) { callbacks.delete(flush); flush(); } },
    get size() { return callbacks.size; },
  };
}

test("ordered text bursts publish once and completion catches up without a frame", async () => {
  const frames = manualFrames();
  const harness = await createHarness({ frameScheduler: frames.scheduler });
  try {
    harness.runtime.resume.adoptFork(resumeResult({ responseTurns: [{ id: "live", items: [] }] }) as never,
      harness.client.connectionGeneration);
    await harness.emit("turn/started", { threadId: "thread-one", turn: { id: "live", status: "inProgress", items: [] } });
    let publications = 0;
    harness.runtime.views.subscribeThread("thread-one", () => { publications += 1; });
    const replicaEvents: string[] = [];
    const source = createThreadViewReplicaSource(harness.runtime.views, harness.client.hostId, "thread-one");
    const removeReplica = source.subscribe(event => replicaEvents.push(event.kind));
    const delta = (itemId: string, text: string) => harness.emit("item/agentMessage/delta",
      { threadId: "thread-one", turnId: "live", itemId, delta: text });
    for (const text of ["你", "好", "\ud83d", "\ude00", "\n"]) await delta("a", text);
    await delta("b", "second");
    for (const [summaryIndex, text] of [[0, "x"], [1, "a"], [0, "y"], [1, "b"]] as const) {
      await harness.emit("item/reasoning/summaryTextDelta", {
        threadId: "thread-one", turnId: "live", itemId: "reasoning", summaryIndex, delta: text,
      });
    }
    assert.equal(publications, 0);
    assert.equal(frames.size, 1);
    frames.tick();
    assert.equal(publications, 1);
    const batch = harness.runtime.views.get("thread-one")!;
    assert.equal(batch.turns[0]?.items?.find(item => item.id === "a")?.text, "你好😀\n");
    assert.deepEqual(batch.turns[0]?.items?.find(item => item.id === "reasoning")?.summary, ["xy", "ab"]);
    const revision = batch.revision;
    const notificationRevision = batch.notificationRevision;
    await delta("a", "finished");
    await harness.emit("item/completed", { threadId: "thread-one", turnId: "live", item: {
      id: "a", type: "agentMessage", text: "你好😀\nfinished", status: "completed",
    } });
    assert.equal(publications, 2);
    assert.equal(frames.size, 0);
    const completed = harness.runtime.views.get("thread-one")!;
    assert.equal(completed.revision, revision + 1);
    assert.equal(completed.notificationRevision, notificationRevision + 2);
    assert.equal(completed.turns[0]?.items?.find(item => item.id === "a")?.completed, true);
    frames.tick();
    assert.equal(publications, 2);
    assert.deepEqual(replicaEvents, ["entry", "entry"]);
    removeReplica();
  } finally { await harness.close(); }
});

test("frame fallback flushes a suspended clock and cancellation fences late frame callbacks", async () => {
  let lateFrame: (() => void) | undefined;
  let flushes = 0;
  const scheduler = createThreadViewFrameScheduler(flush => { lateFrame = flush; return () => {}; });
  const cancel = scheduler.schedule(() => { flushes += 1; });
  cancel();
  lateFrame?.();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(flushes, 0);
  scheduler.schedule(() => { flushes += 1; });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(flushes, 1);
  lateFrame?.();
  assert.equal(flushes, 1);
});

test("queued projections reject expired generations and never resurrect removed views", async () => {
  const frames = manualFrames();
  const harness = await createHarness({ frameScheduler: frames.scheduler });
  try {
    harness.runtime.resume.adoptFork(resumeResult({ responseTurns: [] }) as never,
      harness.client.connectionGeneration);
    let applied = 0;
    harness.runtime.views.queueProjection("thread-one", harness.client.connectionGeneration - 1,
      view => { applied += 1; return view; }, 10);
    frames.tick();
    assert.equal(applied, 0);
    harness.runtime.views.queueProjection("thread-one", harness.client.connectionGeneration,
      view => { applied += 1; return view; }, 10);
    harness.runtime.views.remove("thread-one");
    frames.tick();
    assert.equal(applied, 0);
    assert.equal(harness.runtime.views.get("thread-one"), null);
  } finally { await harness.close(); }
});

test("authoritative reads, interaction writes and full turn snapshots flush preceding text", async () => {
  const frames = manualFrames();
  const harness = await createHarness({ frameScheduler: frames.scheduler });
  try {
    harness.runtime.resume.adoptFork(resumeResult({ responseTurns: [{ id: "live", items: [] }] }) as never,
      harness.client.connectionGeneration);
    const delta = (text: string) => harness.emit("item/agentMessage/delta",
      { threadId: "thread-one", turnId: "live", itemId: "a", delta: text });
    await delta("read");
    assert.equal(harness.runtime.views.get("thread-one")?.turns[0]?.items?.[0]?.text, "read");
    assert.equal(frames.size, 0);
    await delta(" before interaction");
    harness.runtime.views.update("thread-one", view => ({ ...view, pendingInteractions: [] }));
    assert.equal(harness.runtime.views.get("thread-one")?.turns[0]?.items?.[0]?.text, "read before interaction");
    await delta(" must not append twice");
    await harness.emit("turn/completed", { threadId: "thread-one", turn: {
      id: "live", status: "completed", itemsView: "full",
      items: [{ id: "final", type: "agentMessage", text: "authoritative" }],
    } });
    assert.deepEqual(harness.runtime.views.get("thread-one")?.turns[0]?.items?.map(item => item.id), ["final"]);
    frames.tick();
    assert.deepEqual(harness.runtime.views.get("thread-one")?.turns[0]?.items?.map(item => item.id), ["final"]);
    await delta("old callback");
  } finally { await harness.close(); }
  frames.tick();
});

test("ephemeral fork adopts its live baseline without issuing rollout Resume", async () => {
  const harness = await createHarness({});
  try {
    const response = resumeResult({ responseTurns: [{ id: "inherited", items: [] }] });
    const view = harness.runtime.resume.adoptFork(response as never, harness.client.connectionGeneration);
    assert.equal(view.historySource, "fork");
    assert.equal(view.resumeState, "resumed");
    assert.deepEqual(view.streamRole, { role: "owner" });
    assert.equal(view.execution.cwd, "/workspace");
    await harness.runtime.resume.resume({ threadId: "thread-one" });
    assert.equal(harness.requests.some(request => request.method === "thread/resume"), false);
    assert.throws(() => harness.runtime.resume.adoptFork(response as never, harness.client.connectionGeneration - 1));
    await harness.emit("turn/started", { threadId: "thread-one", turn: { id: "child-turn", status: "inProgress", items: [] } });
    assert.equal(harness.runtime.views.get("thread-one")?.turns.some(turn => turn.id === "child-turn"), true);
  } finally { await harness.close(); }
});

test("ordinary tail hydration leaves older history lazy and explicit pagination restores it", async () => {
  const harness = await createHarness({
    initialTurnsPage: {
      data: [{ id: "turn-3", items: [] }, { id: "turn-2", items: [] }],
      nextCursor: "turns:older",
    },
    turnsPages: {
      "turns:older": { data: [{ id: "turn-1", items: [] }], nextCursor: null },
    },
  });
  try {
    const resumed = await harness.runtime.resume.resume({ threadId: "thread-one" });
    assert.equal(resumed.historySource, "tail");
    assert.deepEqual(resumed.turns.map((turn) => turn.id), ["turn-2", "turn-3"]);
    await harness.runtime.resume.waitForBackgroundHistory("thread-one");
    assert.deepEqual(harness.runtime.views.get("thread-one")?.turns.map(turn => turn.id), ["turn-2", "turn-3"]);
    await harness.runtime.resume.loadOlder("thread-one");
    const drained = harness.runtime.views.get("thread-one");
    assert.deepEqual(drained?.turns.map((turn) => turn.id), ["turn-1", "turn-2", "turn-3"]);
    assert.equal(drained?.tailHydrationComplete, true);
    assert.equal(drained?.execution.model, "fixture-model");
    assert.equal(drained?.execution.approvalPolicy, "on-request");
    assert.deepEqual(drained?.execution.runtimeWorkspaceRoots, ["/workspace"]);
    await harness.emit("thread/settings/updated", {
      threadId: "thread-one",
      threadSettings: {
        model: "gpt-5.6",
        modelProvider: "openai",
        serviceTier: null,
        effort: "xhigh",
        cwd: "/workspace/next",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly" },
        activePermissionProfile: { id: ":read-only", extends: null },
      },
    });
    const updated = harness.runtime.views.get("thread-one");
    assert.equal(updated?.execution.model, "gpt-5.6");
    assert.equal(updated?.execution.reasoningEffort, "xhigh");
    assert.deepEqual(updated?.execution.activePermissionProfile, {
      id: ":read-only",
      extends: null,
    });
    const request = harness.requests.find((entry) => entry.method === "thread/resume");
    assert.deepEqual(request?.params.initialTurnsPage, {
      limit: 5,
      itemsView: "full",
      sortDirection: "desc",
    });
  } finally {
    await harness.close();
  }
});

test("Resume orders hydrated Items before an already painted final answer and replays later notifications", async () => {
  const historyItems = [
    { id: "progress", type: "agentMessage", phase: "commentary", text: "Working" },
    { id: "edit", type: "fileChange", changes: [] },
    { id: "final", type: "agentMessage", phase: "final_answer", text: "Done" },
  ];
  const options: HarnessOptions = {
    initialTurnsPage: {
      data: [{ id: "turn-ordered", itemsView: "full", status: "completed", items: [historyItems[2]!] }],
      nextCursor: null,
    },
  };
  const harness = await createHarness(options);
  try {
    await harness.runtime.resume.resume({ threadId: "thread-one" });
    assert.deepEqual(harness.runtime.views.get("thread-one")?.turns[0]?.items?.map((item) => item.id), ["final"]);
    await harness.transport.close();
    options.initialTurnsPage = {
      data: [{ id: "turn-ordered", itemsView: "full", status: "completed", items: historyItems }],
      nextCursor: null,
    };
    options.emitItemDuringResume = true;
    await harness.client.connect({ clientInfo: { name: "session-test", version: "1" } });
    await harness.runtime.resume.resume({ threadId: "thread-one" });
    const view = harness.runtime.views.get("thread-one");
    assert.deepEqual(view?.turns[0]?.items?.map((item) => item.id), [
      "progress", "edit", "final", "post-snapshot",
    ]);
    assert.equal(view?.turns[0]?.status, "completed");
  } finally {
    await harness.close();
  }
});

for (const background of [false, true]) {
  test(`${background ? "background drain" : "older page"} preserves concurrent streaming and Thread identity through the transport`, async () => {
    let release = () => {};
    let captured = () => {};
    const requested = new Promise<void>(resolve => { captured = resolve; });
    const active = {
      id: "active", status: "inProgress", itemsView: "full", items: [
        { id: "user", type: "userMessage", content: [{ type: "text", text: "Current prompt" }] },
        { id: "reply", type: "agentMessage", phase: "commentary", text: "A" },
      ],
    };
    const harness = await createHarness({
      drainTailHistory: background,
      initialTurnsPage: { data: [active], nextCursor: "older" },
      turnsPages: { older: { data: [active, { id: "older", status: "completed", itemsView: "full", items: [] }], nextCursor: null } },
      holdTurnsResponse: respond => { release = respond; captured(); },
    });
    try {
      await harness.runtime.resume.resume({ threadId: "thread-one" });
      const loading = background ? harness.runtime.resume.waitForBackgroundHistory("thread-one")
        : harness.runtime.resume.loadOlder("thread-one");
      await requested;
      await harness.emit("item/agentMessage/delta", { threadId: "thread-one", turnId: "active", itemId: "reply", delta: "B" });
      await harness.emit("item/started", { threadId: "thread-one", turnId: "active", item: {
        id: "final", type: "agentMessage", phase: "final_answer", text: "New answer",
      } });
      await harness.emit("item/agentMessage/delta", { threadId: "thread-other", turnId: "active", itemId: "reply", delta: "Foreign" });
      await harness.emit("turn/completed", { threadId: "thread-one", turn: { id: "active", status: "completed", itemsView: "summary", durationMs: 120, items: [] } });
      release();
      await loading;
      const view = harness.runtime.views.get("thread-one")!;
      assert.deepEqual(view.turns.map(turn => turn.id), ["older", "active"]);
      assert.deepEqual(view.turns[1]?.items?.map(item => item.id), ["user", "reply", "final"]);
      assert.equal(view.turns[1]?.items?.[1]?.text, "AB");
      assert.equal(view.turns[1]?.items?.[2]?.text, "New answer");
      assert.equal(view.turns[1]?.status, "completed");
      assert.equal(view.turns[1]?.durationMs, 120);
    } finally { release(); await harness.close(); }
  });
}

test("paginated Resume respects the ordered Item page when the cached View contains final first", async () => {
  const harness = await createHarness({
    historyMode: "paginated",
    turnsPages: {
      "turns:head": {
        data: [{ id: "turn-one", status: "completed", items: [] }], nextCursor: null,
      },
    },
    itemsByTurnId: {
      "turn-one": [
        { id: "final", type: "agentMessage", phase: "final_answer", text: "Done" },
        { id: "edit", type: "fileChange", changes: [] },
        { id: "progress", type: "agentMessage", phase: "commentary", text: "Working" },
      ],
    },
  });
  try {
    harness.runtime.views.update("thread-one", (view) => ({
      ...view,
      turns: [{ id: "turn-one", status: "completed", items: [{ id: "final", type: "agentMessage", text: "Done" }] }],
    }));
    const view = await harness.runtime.resume.resume({ threadId: "thread-one" });
    assert.deepEqual(view.turns[0]?.items?.map((item) => item.id), ["progress", "edit", "final"]);
    assert.equal(view.itemsPaginationByTurnId["turn-one"]?.hasLoadedOldest, true);
  } finally {
    await harness.close();
  }
});

test("ordered history repositions cached Turns and a partial Item window without discarding outside rows", () => {
  const cached = [{
    id: "turn-one", status: "completed", itemsView: "summary",
    items: [
      { id: "older", type: "agentMessage" },
      { id: "final", type: "agentMessage", phase: "final_answer" },
      { id: "newer", type: "agentMessage" },
    ],
  }, {
    id: "turn-three", itemsView: "full", items: [],
  }];
  const history = [{
    id: "turn-one", status: "completed", itemsView: "summary",
    items: [
      { id: "progress", type: "agentMessage" },
      { id: "edit", type: "fileChange" },
      { id: "final", type: "agentMessage", phase: "final_answer" },
    ],
  }, {
    id: "turn-two", itemsView: "full", items: [],
  }, {
    id: "turn-three", itemsView: "full", items: [],
  }];
  const merged = reconcileHistoryTurns(cached, history, "latest");
  assert.deepEqual(merged.map((turn) => turn.id), ["turn-one", "turn-two", "turn-three"]);
  assert.deepEqual(merged[0]?.items?.map((item) => item.id), [
    "older", "progress", "edit", "final", "newer",
  ]);
  assert.deepEqual(reconcileHistoryTurns(merged, history, "latest"), merged);
});

test("stale in-progress history cannot regress a completed Turn or its final Item", () => {
  const cached = [{
    id: "turn-one", status: "completed", completedAt: 30, itemsView: "full",
    items: [{ id: "final", type: "agentMessage", text: "Complete", completed: true }],
  }];
  const history = [{
    id: "turn-one", status: "inProgress", completedAt: null, itemsView: "full",
    items: [
      { id: "progress", type: "agentMessage", text: "Working" },
      { id: "final", type: "agentMessage", text: "Partial" },
    ],
  }];
  const merged = reconcileHistoryTurns(cached, history, "latest");
  assert.equal(merged[0]?.status, "completed");
  assert.equal(merged[0]?.completedAt, 30);
  assert.deepEqual(merged[0]?.items?.map((item) => item.id), ["progress", "final"]);
  assert.equal(merged[0]?.items?.[1]?.text, "Complete");
});

test("history replaces only the membership it actually covers", () => {
  const cached = [{
    id: "turn-one", status: "completed", itemsView: "full",
    items: [
      { id: "older", type: "agentMessage" },
      { id: "removed", type: "agentMessage" },
      { id: "stale-within-window", type: "agentMessage" },
      { id: "final", type: "agentMessage" },
      { id: "newer", type: "agentMessage" },
    ],
  }];
  const partial = reconcileHistoryTurns(cached, [{
    id: "turn-one", status: "completed", itemsView: "summary",
    items: [{ id: "removed", type: "agentMessage" }, { id: "final", type: "agentMessage" }],
  }], "latest");
  assert.deepEqual(partial[0]?.items?.map((item) => item.id), ["older", "removed", "final", "newer"]);
  assert.equal(partial[0]?.itemsView, "full");
  const notLoaded = reconcileHistoryTurns(partial, [{
    id: "turn-one", status: "completed", itemsView: "notLoaded", items: [],
  }], "latest");
  assert.deepEqual(notLoaded[0]?.items?.map((item) => item.id), ["older", "removed", "final", "newer"]);
  assert.equal(notLoaded[0]?.itemsView, "full");
  const full = reconcileHistoryTurns(notLoaded, [{
    id: "turn-one", status: "completed", itemsView: "full",
    items: [{ id: "older", type: "agentMessage" }, { id: "final", type: "agentMessage" }],
  }], "latest");
  assert.deepEqual(full[0]?.items?.map((item) => item.id), ["older", "final"]);
  const settled = reconcileHistoryTurns([{
    id: "turn-two", status: "inProgress", itemsView: "summary",
    items: [{ id: "final", type: "agentMessage", text: "Partial", status: "inProgress", completed: false }],
  }], [{
    id: "turn-two", status: "completed", itemsView: "full",
    items: [{ id: "final", type: "agentMessage", text: "Complete" }],
  }], "latest");
  assert.equal(settled[0]?.items?.[0]?.text, "Complete");
  assert.equal(settled[0]?.items?.[0]?.status, undefined);
  assert.equal(settled[0]?.items?.[0]?.completed, undefined);
});

test("tail hydration falls back to thread/read when the extension page is absent", async () => {
  const harness = await createHarness({
    fallbackTurns: [{ id: "turn-1", items: [] }],
  });
  try {
    const view = await harness.runtime.resume.resume({ threadId: "thread-one" });
    assert.equal(view.historySource, "thread-read-fallback");
    assert.deepEqual(view.turns.map((turn) => turn.id), ["turn-1"]);
    assert.equal(harness.requests.filter((entry) => entry.method === "thread/read").length, 2);
  } finally {
    await harness.close();
  }
});

test("paginated hydration follows Resume cursor heads and loads older pages on demand", async () => {
  const harness = await createHarness({
    historyMode: "paginated",
    turnsPages: {
      "turns:head": {
        data: [{ id: "turn-3" }, { id: "turn-2" }],
        nextCursor: "turns:older",
      },
      "turns:older": {
        data: [{ id: "turn-1" }],
        nextCursor: null,
      },
    },
    itemsByTurnId: {
      "turn-1": [{ id: "item-1", type: "userMessage" }],
      "turn-2": [{ id: "item-2", type: "userMessage" }],
      "turn-3": [{ id: "item-3", type: "agentMessage" }],
    },
  });
  try {
    const initial = await harness.runtime.resume.resume({ threadId: "thread-one" });
    assert.equal(initial.historySource, "paginated");
    assert.deepEqual(initial.turns.map((turn) => turn.id), ["turn-2", "turn-3"]);
    assert.equal(initial.turnsPagination.olderCursor, "turns:older");
    const resumeRequest = harness.requests.find((entry) => entry.method === "thread/resume");
    assert.equal("initialTurnsPage" in (resumeRequest?.params ?? {}), false);

    const complete = await harness.runtime.resume.loadOlder("thread-one");
    assert.deepEqual(complete.turns.map((turn) => turn.id), ["turn-1", "turn-2", "turn-3"]);
    assert.deepEqual(complete.turns[0]?.items?.map((item) => item.id), ["item-1"]);
    assert.equal(complete.turnsPagination.hasLoadedOldest, true);
  } finally {
    await harness.close();
  }
});

test("catalog metadata selects paginated Resume without a redundant Thread read", async () => {
  const harness = await createHarness({
    historyMode: "paginated",
    turnsPages: {
      "turns:head": {
        data: [{ id: "turn-1" }],
        nextCursor: null,
      },
    },
    itemsByTurnId: {
      "turn-1": [{ id: "item-1", type: "agentMessage" }],
    },
  });
  try {
    const seeded = harness.runtime.views.seedMetadata(thread("thread-one", [{ id: "catalog-turn" }], "paginated"));
    assert.equal(seeded.resumeState, "needs_resume");
    assert.deepEqual(seeded.turns, []);
    assert.deepEqual(seeded.thread?.turns, []);
    const refreshed = harness.runtime.views.seedMetadata({
      ...thread("thread-one", [{ id: "newer-catalog-turn" }], "paginated"),
      name: "Refreshed catalog title",
    });
    assert.equal(refreshed.thread?.name, "Refreshed catalog title");
    assert.deepEqual(refreshed.thread?.turns, []);

    const resumed = await harness.runtime.resume.resume({ threadId: "thread-one" });
    assert.equal(resumed.historySource, "paginated");
    assert.deepEqual(resumed.turns.map((turn) => turn.id), ["turn-1"]);
    assert.equal(harness.requests.some((request) => request.method === "thread/read"), false);
    assert.equal(harness.requests.filter((request) => request.method === "thread/resume").length, 1);
  } finally {
    await harness.close();
  }
});

test("Host history capability removes metadata preflight for a deep link", async () => {
  const harness = await createHarness({
    historyMode: "paginated",
    historyModeHint: "paginated",
    turnsPages: {
      "turns:head": { data: [], nextCursor: null },
    },
  });
  try {
    const resumed = await harness.runtime.resume.resume({ threadId: "thread-one" });
    assert.equal(resumed.historySource, "paginated");
    assert.equal(harness.requests.some((request) => request.method === "thread/read"), false);
    assert.equal(harness.requests.filter((request) => request.method === "thread/resume").length, 1);
  } finally {
    await harness.close();
  }
});

test("Durable hydration loads Turn Items separately with full projections", async () => {
  const harness = await createHarness({
    hostId: "durable",
    hostKind: "durable",
    historyMode: "paginated",
    turnsPages: {
      null: { data: [{ id: "turn-2" }, { id: "turn-1" }], nextCursor: null },
    },
    itemsByTurnId: {
      "turn-1": [{ id: "item-1", type: "userMessage" }],
      "turn-2": [{ id: "item-2", type: "agentMessage" }],
    },
  });
  try {
    const view = await harness.runtime.resume.resume({ threadId: "thread-one" });
    assert.equal(view.historySource, "durable");
    assert.deepEqual(view.turns.map((turn) => turn.id), ["turn-1", "turn-2"]);
    assert.equal(harness.requests.filter((entry) => entry.method === "thread/items/list").length, 2);
    const resumeRequest = harness.requests.find((entry) => entry.method === "thread/resume");
    assert.equal("initialTurnsPage" in (resumeRequest?.params ?? {}), false);
  } finally {
    await harness.close();
  }
});

test("durable Hosts restore legacy full history without paginated Item requests", async () => {
  const harness = await createHarness({
    hostId: "history-host", hostKind: "durable", historyMode: "legacy",
    fallbackTurns: [{ id: "native-turn", items: [{ id: "native-message", type: "userMessage", content: [{ type: "inputText", text: "Linked task history" }] }] }],
  });
  try {
    const view = await harness.runtime.resume.resume({ threadId: "thread-one" });
    assert.equal(view.resumeState, "resumed");
    assert.equal(view.historySource, "thread-read-fallback");
    assert.equal(view.turns[0]?.items?.[0]?.id, "native-message");
    assert.equal(view.turnsPagination.hasLoadedOldest, true);
    assert.equal(harness.requests.some(entry => ["thread/turns/list", "thread/items/list"].includes(entry.method)), false);
    assert.equal(harness.requests.filter(entry => entry.method === "thread/read" && entry.params.includeTurns === true).length, 1);
  } finally { await harness.close(); }
});

test("legacy Resume projects inline thread.turns without secondary history requests", async () => {
  const harness = await createHarness({
    useTailHydration: false,
    responseTurns: [{ id: "turn-1", items: [] }, { id: "turn-2", items: [] }],
  });
  try {
    const view = await harness.runtime.resume.resume({ threadId: "thread-one" });
    assert.equal(view.historySource, "legacy");
    assert.deepEqual(view.turns.map((turn) => turn.id), ["turn-1", "turn-2"]);
    assert.equal(harness.requests.some((entry) => entry.method === "thread/turns/list"), false);
    assert.equal(harness.requests.find((entry) => entry.method === "thread/resume")?.params.excludeTurns, false);
  } finally {
    await harness.close();
  }
});

test("historical projections wait for View commit while shared notifications and native requests proceed", async () => {
  const harness = await createHarness({
    initialTurnsPage: { data: [], nextCursor: null },
    emitDuringResume: true,
    requestDuringResume: true,
  });
  const observedStates: string[] = [], projectedStates: string[] = [];
  const removeProjector = harness.runtime.notificationProjectors.register({ name: "commit-order-probe", priority: 1000, project(view) { projectedStates.push(view.resumeState); return view; } });
  const removeNotification = harness.client.subscribeNotification(() => {
    observedStates.push(harness.runtime.views.get("thread-one")?.resumeState ?? "missing");
  });
  harness.client.handleServerRequest("item/permissions/requestApproval", () => {
    observedStates.push(harness.runtime.views.get("thread-one")?.resumeState ?? "missing");
    return { decision: "accept" };
  });
  try {
    const view = await harness.runtime.resume.resume({ threadId: "thread-one" });
    assert.equal(view.resumeState, "resumed");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(observedStates, ["resuming", "resuming"]);
    assert.deepEqual(projectedStates, ["resumed"]);
    assert.equal(harness.runtime.views.get("thread-one")?.notificationRevision, 1);
    assert.deepEqual(harness.approvalResponses, [{ decision: "accept" }]);
  } finally {
    removeNotification(); removeProjector();
    await harness.close();
  }
});

test("plan notifications become ordered todo observations through the session runtime", async () => {
  const harness = await createHarness({ useTailHydration: false, responseTurns: [{ id: "turn-plan", status: "inProgress", items: [] }] });
  try {
    await harness.runtime.resume.resume({ threadId: "thread-one" });
    for (const status of ["pending", "completed"]) await harness.emit("turn/plan/updated", {
      threadId: "thread-one", turnId: "turn-plan", explanation: "Inspect first", plan: [{ step: "Read source", status }],
    });
    const turn = harness.runtime.views.get("thread-one")!.turns[0]!;
    const items = turn.items as readonly Record<string, any>[];
    assert.equal(items.length, 2);
    assert.notEqual(items[0]!.id, items[1]!.id);
    assert.deepEqual(items.map((item) => [item.type, item.explanation, item.plan[0].step, item.plan[0].status]), [
      ["todo-list", "Inspect first", "Read source", "pending"], ["todo-list", "Inspect first", "Read source", "completed"],
    ]);
    assert.equal(turn.status, "inProgress");
    assert.equal(turn.plan, undefined);
  } finally { await harness.close(); }
});

test("streaming Item deltas update in place without reordering the Turn", async () => {
  const harness = await createHarness({
    useTailHydration: false,
    responseTurns: [{
      id: "turn-stream",
      status: "inProgress",
      items: [
        { id: "assistant-stream", type: "agentMessage", text: "" },
        { id: "reasoning-stream", type: "reasoning", summary: [], content: [] },
        {
          id: "command-stream",
          type: "commandExecution",
          command: "npm test",
          aggregatedOutput: "",
          status: "inProgress",
        },
      ],
    }],
  });
  try {
    await harness.runtime.resume.resume({ threadId: "thread-one" });
    await harness.emit("item/agentMessage/delta", {
      threadId: "thread-one",
      turnId: "turn-stream",
      itemId: "assistant-stream",
      delta: "Hello",
    });
    await harness.emit("item/reasoning/summaryPartAdded", {
      threadId: "thread-one",
      turnId: "turn-stream",
      itemId: "reasoning-stream",
      summaryIndex: 0,
    });
    await harness.emit("item/reasoning/summaryTextDelta", {
      threadId: "thread-one",
      turnId: "turn-stream",
      itemId: "reasoning-stream",
      summaryIndex: 0,
      delta: "Inspecting",
    });
    await harness.emit("item/reasoning/textDelta", {
      threadId: "thread-one",
      turnId: "turn-stream",
      itemId: "reasoning-stream",
      contentIndex: 0,
      delta: "Read the real source.",
    });
    await harness.emit("item/commandExecution/outputDelta", {
      threadId: "thread-one",
      turnId: "turn-stream",
      itemId: "command-stream",
      delta: "60 tests passed\n",
    });

    const items = harness.runtime.views.get("thread-one")?.turns[0]?.items ?? [];
    assert.deepEqual(items.map((item) => item.id), [
      "assistant-stream",
      "reasoning-stream",
      "command-stream",
    ]);
    assert.equal(items[0]?.text, "Hello");
    assert.deepEqual(items[1]?.summary, ["Inspecting"]);
    assert.deepEqual(items[1]?.content, ["Read the real source."]);
    assert.equal(items[2]?.aggregatedOutput, "60 tests passed\n");

    await harness.emit("item/completed", {
      threadId: "thread-one",
      turnId: "turn-stream",
      completedAtMs: 10,
      item: { id: "assistant-stream", type: "agentMessage", text: "Hello world" },
    });
    const completedItems = harness.runtime.views.get("thread-one")?.turns[0]?.items ?? [];
    assert.deepEqual(completedItems.map((item) => item.id), [
      "assistant-stream",
      "reasoning-stream",
      "command-stream",
    ]);
    assert.equal(completedItems[0]?.status, "completed");
    assert.equal(completedItems[0]?.completed, true);
  } finally {
    await harness.close();
  }
});

test("Hook notifications retain Codex run identity across start, completion, and reused IDs", async () => {
  const harness = await createHarness({
    useTailHydration: false,
    responseTurns: [
      { id: "turn-hook", status: "inProgress", items: [] },
      { id: "turn-latest", status: "inProgress", items: [] },
    ],
  });
  const run = (overrides: Record<string, unknown> = {}) => ({
    id: "hook-reused",
    eventName: "afterToolUse",
    handlerType: "command",
    executionMode: "sync",
    scope: "project",
    sourcePath: "/workspace/.codex/hooks.json",
    source: "project",
    displayOrder: 1,
    status: "running",
    statusMessage: null,
    startedAt: 10,
    completedAt: null,
    durationMs: null,
    entries: [],
    ...overrides,
  });
  try {
    await harness.runtime.resume.resume({ threadId: "thread-one" });
    await harness.emit("hook/started", {
      threadId: "thread-one",
      turnId: "turn-hook",
      run: run(),
    });
    await harness.emit("hook/completed", {
      threadId: "thread-one",
      turnId: "turn-hook",
      run: run({ status: "completed", completedAt: 20, durationMs: 10 }),
    });
    await harness.emit("hook/completed", {
      threadId: "thread-one",
      turnId: "turn-hook",
      run: run({ status: "completed", completedAt: 20, durationMs: 10 }),
    });
    await harness.emit("hook/started", {
      threadId: "thread-one",
      turnId: "turn-hook",
      run: run({ startedAt: 30 }),
    });
    await harness.emit("hook/completed", {
      threadId: "thread-one",
      turnId: "turn-hook",
      run: run({ status: "blocked", startedAt: 30, completedAt: 40, durationMs: 10 }),
    });
    await harness.emit("hook/completed", {
      threadId: "thread-one",
      turnId: null,
      run: run({ id: "latest-hook", status: "failed", completedAt: 50 }),
    });

    const turns = harness.runtime.views.get("thread-one")?.turns ?? [];
    const hookTurn = turns.find((turn) => turn.id === "turn-hook") as (typeof turns)[number] & {
      hookRuns?: readonly { id: string; run: Record<string, unknown> }[];
    };
    assert.deepEqual(hookTurn.hookRuns?.map((entry) => entry.id), ["hook-reused", "hook-reused:1"]);
    assert.deepEqual(hookTurn.hookRuns?.map((entry) => entry.run.status), ["completed", "blocked"]);
    assert.equal(hookTurn.hookRuns?.[0]?.run.sourcePath, "/workspace/.codex/hooks.json");

    const latestTurn = turns.find((turn) => turn.id === "turn-latest") as (typeof turns)[number] & {
      hookRuns?: readonly { id: string; run: Record<string, unknown> }[];
    };
    assert.deepEqual(latestTurn.hookRuns?.map((entry) => entry.id), ["latest-hook"]);
    assert.equal(latestTurn.hookRuns?.[0]?.run.status, "failed");
  } finally {
    await harness.close();
  }
});

test("tool stream notifications preserve Codex patch, terminal-input, and output truncation semantics", async () => {
  const harness = await createHarness({
    useTailHydration: false,
    responseTurns: [{
      id: "turn-tool-stream",
      status: "inProgress",
      items: [
        { id: "command-tool-stream", type: "commandExecution", command: "python", commandActions: [], aggregatedOutput: "", status: "inProgress" },
        { id: "patch-tool-stream", type: "fileChange", changes: [], status: "inProgress" },
        { id: "mcp-tool-stream", type: "mcpToolCall", server: "files", tool: "read", status: "inProgress" },
      ],
    }],
  });
  try {
    await harness.runtime.resume.resume({ threadId: "thread-one" });
    await harness.emit("item/started", {
      threadId: "thread-one",
      turnId: "turn-tool-stream",
      startedAtMs: 77,
      item: { id: "command-tool-stream", type: "commandExecution", command: "python", commandActions: [], aggregatedOutput: "", processId: null, status: "inProgress" },
    });
    await harness.emit("item/commandExecution/terminalInteraction", {
      threadId: "thread-one",
      turnId: "turn-tool-stream",
      itemId: "command-tool-stream",
      processId: "process-one",
      stdin: "prix\bnt('ok')\rnext",
    });
    await harness.emit("item/commandExecution/terminalInteraction", {
      threadId: "thread-one",
      turnId: "turn-tool-stream",
      itemId: "command-tool-stream",
      processId: "process-one",
      stdin: " line\n",
    });
    await harness.emit("item/fileChange/patchUpdated", {
      threadId: "thread-one",
      turnId: "turn-tool-stream",
      itemId: "patch-tool-stream",
      changes: [{ path: "src/app.ts", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" }],
    });
    await harness.emit("item/mcpToolCall/progress", {
      threadId: "thread-one",
      turnId: "turn-tool-stream",
      itemId: "mcp-tool-stream",
      message: "Reading files",
    });
    await harness.emit("item/commandExecution/outputDelta", {
      threadId: "thread-one",
      turnId: "turn-tool-stream",
      itemId: "command-tool-stream",
      delta: "x".repeat(20_001),
    });
    const items = harness.runtime.views.get("thread-one")?.turns[0]?.items ?? [];
    const command = items.find((item) => item.id === "command-tool-stream");
    assert.deepEqual(command?.commandActions, [
      { type: "unknown", command: "print('ok')" },
      { type: "unknown", command: "next line" },
    ]);
    assert.equal(command?.terminalInputBuffer, "");
    assert.equal(command?.startedAtMs, 77);
    assert.equal(command?.processId, "process-one");
    assert.equal(String(command?.aggregatedOutput).startsWith("[output truncated]\n"), true);
    assert.equal(String(command?.aggregatedOutput).length, 20_000 + "[output truncated]\n".length);
    const patch = items.find((item) => item.id === "patch-tool-stream");
    assert.deepEqual(patch?.changes, [{ path: "src/app.ts", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" }]);
    assert.equal(patch?.status, "inProgress");
    const mcp = items.find((item) => item.id === "mcp-tool-stream");
    assert.equal("progress" in (mcp ?? {}), false);
  } finally {
    await harness.close();
  }
});

test("Guardian auto-approval reviews retain stable identity from started through completed", async () => {
  const harness = await createHarness({
    useTailHydration: false,
    responseTurns: [{
      id: "turn-review",
      status: "inProgress",
      items: [{ id: "command-review", type: "commandExecution", command: "git status", status: "inProgress" }],
    }],
  });
  const action = {
    type: "command",
    source: "shell",
    command: "git status",
    cwd: "/workspace",
  };
  try {
    await harness.runtime.resume.resume({ threadId: "thread-one" });
    await harness.emit("item/autoApprovalReview/started", {
      threadId: "thread-one",
      turnId: "turn-review",
      reviewId: "review-one",
      targetItemId: "command-review",
      startedAtMs: 100,
      review: {
        status: "inProgress",
        riskLevel: null,
        userAuthorization: null,
        rationale: null,
      },
      action,
    });
    const started = harness.runtime.views.get("thread-one")?.guardianApprovalReviews[0];
    assert.equal(started?.reviewId, "review-one");
    assert.equal(started?.status, "inProgress");
    assert.equal(started?.completedAtMs, null);

    await harness.emit("item/autoApprovalReview/completed", {
      threadId: "thread-one",
      turnId: "turn-review",
      reviewId: "review-one",
      targetItemId: "command-review",
      startedAtMs: 100,
      completedAtMs: 140,
      decisionSource: "agent",
      review: {
        status: "denied",
        riskLevel: "high",
        userAuthorization: "low",
        rationale: "The command can expose repository metadata.",
      },
      action,
    });
    const reviews = harness.runtime.views.get("thread-one")?.guardianApprovalReviews ?? [];
    assert.equal(reviews.length, 1);
    assert.deepEqual(reviews[0], {
      reviewId: "review-one",
      turnId: "turn-review",
      targetItemId: "command-review",
      startedAtMs: 100,
      completedAtMs: 140,
      status: "denied",
      riskLevel: "high",
      userAuthorization: "low",
      rationale: "The command can expose repository metadata.",
      action,
      decisionSource: "agent",
    });
  } finally {
    await harness.close();
  }
});

test("only the repeated-denial Guardian warning becomes the Codex interruption Item", async () => {
  const harness = await createHarness({
    useTailHydration: false,
    responseTurns: [{ id: "turn-review-warning", status: "inProgress", items: [] }],
  });
  try {
    await harness.runtime.resume.resume({ threadId: "thread-one" });
    await harness.emit("guardianWarning", {
      threadId: "thread-one",
      message: "A normal guardian warning",
    });
    assert.equal(harness.runtime.views.get("thread-one")?.turns[0]?.items?.length, 0);
    await harness.emit("guardianWarning", {
      threadId: "thread-one",
      message: "Automatic approval review rejected too many approval requests for this turn; stopping.",
    });
    const item = harness.runtime.views.get("thread-one")?.turns[0]?.items?.[0];
    assert.equal(item?.type, "autoReviewInterruptionWarning");
    assert.match(String(item?.message), /rejected too many approval requests/u);
  } finally {
    await harness.close();
  }
});

test("failed Turn notifications retain the top-level AppServer error", async () => {
  const harness = await createHarness({
    useTailHydration: false,
    responseTurns: [{ id: "turn-failed", status: "inProgress", items: [] }],
  });
  try {
    await harness.runtime.resume.resume({ threadId: "thread-one" });
    await harness.emit("turn/completed", {
      threadId: "thread-one",
      turn: {
        id: "turn-failed",
        status: "failed",
        items: [],
        error: {
          message: "Model stream disconnected",
          codexErrorInfo: { type: "streamDisconnected" },
          additionalDetails: null,
        },
      },
    });
    const turn = harness.runtime.views.get("thread-one")?.turns[0];
    assert.equal(turn?.status, "failed");
    assert.deepEqual(turn?.error, {
      message: "Model stream disconnected",
      codexErrorInfo: { type: "streamDisconnected" },
      additionalDetails: null,
    });
  } finally {
    await harness.close();
  }
});

test("a completed full Turn snapshot owns Item membership and removes stale live Items", async () => {
  const harness = await createHarness({
    useTailHydration: false,
    responseTurns: [{
      id: "turn-authoritative-completion",
      itemsView: "full",
      status: "inProgress",
      items: [
        { id: "interim", type: "agentMessage", text: "same answer", phase: "commentary" },
        { id: "final", type: "agentMessage", text: "same answer", phase: null },
      ],
    }],
  });
  try {
    await harness.runtime.resume.resume({ threadId: "thread-one" });
    await harness.emit("turn/completed", {
      threadId: "thread-one",
      turn: {
        id: "turn-authoritative-completion",
        itemsView: "full",
        status: "completed",
        items: [{ id: "final", type: "agentMessage", text: "same answer", phase: null }],
        error: null,
        startedAt: 10,
        completedAt: 12,
        durationMs: 2_000,
      },
    });

    const turn = harness.runtime.views.get("thread-one")?.turns[0];
    assert.deepEqual(turn?.items?.map(({ id }) => id), ["final"]);
  } finally {
    await harness.close();
  }
});

test("a follower uses its owner projection and never sends thread/resume", async () => {
  const harness = await createHarness();
  try {
    harness.runtime.resume.setStreamRole("thread-one", { role: "follower", ownerClientId: "window-a" });
    const view = await harness.runtime.resume.resume({ threadId: "thread-one" });
    assert.deepEqual(view.streamRole, { role: "follower", ownerClientId: "window-a" });
    assert.equal(view.resumeState, "resumed");
    assert.equal(harness.requests.some((entry) => entry.method === "thread/resume"), false);
  } finally {
    await harness.close();
  }
});

test("item/updated patches preserve lifecycle and identity without restarting work", async () => {
  const harness = await createHarness({ useTailHydration: false });
  try {
    await harness.runtime.resume.resume({ threadId: "thread-one" });
    await harness.emit("turn/started", { threadId: "thread-one", turn: { id: "updated", status: "inProgress", items: [] } });
    await harness.emit("item/started", { threadId: "thread-one", turnId: "updated", startedAtMs: 100,
      item: { id: "tool", type: "dynamicToolCall", namespace: "hermes", tool: "terminal", arguments: { command: "ls" }, status: "inProgress" } });
    await harness.emit("item/updated", { threadId: "thread-one", turnId: "updated",
      item: { id: "tool", type: "dynamicToolCall", progressText: "Reading directory" } });
    const turn = harness.runtime.views.get("thread-one")?.turns.find(turn => turn.id === "updated");
    assert.equal(turn?.items.length, 1);
    assert.equal(turn?.items[0]?.startedAtMs, 100);
    assert.equal(turn?.items[0]?.tool, "terminal");
    assert.equal(turn?.items[0]?.progressText, "Reading directory");
    assert.equal(turn?.items[0]?.status, "inProgress");
  } finally { await harness.close(); }
});

test("work clocks survive completion membership replacement without reviving obsolete content", async () => {
  const harness = await createHarness({ useTailHydration: false });
  try {
    await harness.runtime.resume.resume({ threadId: "thread-one" });
    await harness.emit("turn/started", { threadId: "thread-one", turn: { id: "timed", status: "inProgress", startedAt: 10, items: [] } });
    await harness.emit("item/started", { threadId: "thread-one", turnId: "timed", startedAtMs: 10_100, item: { id: "work", type: "reasoning", summary: [] } });
    await harness.emit("item/started", { threadId: "thread-one", turnId: "timed", startedAtMs: 12_600, item: { id: "answer", type: "agentMessage", phase: "final_answer", text: "" } });
    // Replaying the same started Item must not move its start clock.
    await harness.emit("item/started", { threadId: "thread-one", turnId: "timed", startedAtMs: 13_600, item: { id: "answer", type: "agentMessage", phase: "final_answer", text: "" } });
    await harness.emit("turn/completed", { threadId: "thread-one", turn: {
      id: "timed", status: "completed", itemsView: "full", durationMs: 20_000,
      items: [{ id: "answer", type: "agentMessage", phase: "final_answer", text: "Done" }],
    } });
    const turn = harness.runtime.views.get("thread-one")?.turns.find((turn) => turn.id === "timed");
    assert.equal(turn?.turnStartedAtMs, 10_000);
    assert.equal(turn?.firstTurnWorkItemStartedAtMs, 10_100);
    assert.equal(turn?.finalAssistantStartedAtMs, 12_600);
    assert.deepEqual(turn?.items?.map((item) => item.id), ["answer"]);
    assert.equal(turn?.items?.[0]?.startedAtMs, 12_600);
    assert.equal(turn?.items?.[0]?.text, "Done");
    // A later Turn gets independent clocks even for identical text/phase.
    await harness.emit("turn/started", { threadId: "thread-one", turn: { id: "next", status: "inProgress", startedAt: 40, items: [] } });
    const next = harness.runtime.views.get("thread-one")?.turns.find((turn) => turn.id === "next");
    assert.equal(next?.turnStartedAtMs, 40_000);
    assert.equal(next?.firstTurnWorkItemStartedAtMs, undefined);
  } finally {
    await harness.close();
  }
});

test("Resume failure rolls provisional ownership back and releases buffered notifications", async () => {
  const harness = await createHarness({ failResume: true, emitDuringResume: true });
  const delivered: string[] = [];
  harness.client.subscribeNotification((notification) => delivered.push(notification.method));
  try {
    await assert.rejects(
      harness.runtime.resume.resume({ threadId: "thread-one" }),
      (error: unknown) => error instanceof AppServerRpcError && error.code === -32022,
    );
    const view = harness.runtime.views.get("thread-one");
    assert.equal(view?.resumeState, "needs_resume");
    assert.equal(view?.streamRole, null);
    assert.equal(harness.runtime.ownership.get("thread-one"), null);
    assert.deepEqual(delivered, ["thread/status/changed"]);
  } finally {
    await harness.close();
  }
});

test("concurrent Resume calls deduplicate one physical RPC", async () => {
  const harness = await createHarness({
    resumeDelayMs: 15,
    initialTurnsPage: { data: [], nextCursor: null },
  });
  try {
    const [first, second] = await Promise.all([
      harness.runtime.resume.resume({ threadId: "thread-one" }),
      harness.runtime.resume.resume({ threadId: "thread-one" }),
    ]);
    assert.equal(first, second);
    assert.equal(harness.requests.filter((entry) => entry.method === "thread/resume").length, 1);
  } finally {
    await harness.close();
  }
});

test("a physical disconnect invalidates ownership and marks mounted Views for Resume", async () => {
  const harness = await createHarness({ initialTurnsPage: { data: [], nextCursor: null } });
  try {
    await harness.runtime.resume.resume({ threadId: "thread-one" });
    await harness.transport.close();
    const view = harness.runtime.views.get("thread-one");
    assert.equal(view?.resumeState, "needs_resume");
    assert.equal(view?.streamRole, null);
    assert.equal(harness.runtime.ownership.get("thread-one"), null);
  } finally {
    await harness.close();
  }
});

test("malformed Resume identity fails closed instead of committing a View", async () => {
  const harness = await createHarness({ malformedResume: true });
  try {
    await assert.rejects(
      harness.runtime.resume.resume({ threadId: "thread-one" }),
      /invalid Thread/,
    );
    assert.equal(harness.runtime.views.get("thread-one")?.resumeState, "needs_resume");
  } finally {
    await harness.close();
  }
});

test("Resume projectors are Cordis extension points with deterministic priority", async () => {
  const harness = await createHarness({ initialTurnsPage: { data: [], nextCursor: null } });
  const remove = harness.runtime.resumeProjectors.register({
    name: "agent-annotation",
    priority: 100,
    project(view) {
      return { ...view, execution: { ...view.execution, model: `${view.execution.model}:projected` } };
    },
  });
  try {
    const view = await harness.runtime.resume.resume({ threadId: "thread-one" });
    assert.equal(view.execution.model, "fixture-model:projected");
  } finally {
    remove();
    await harness.close();
  }
});

test("Resume request extensions cannot override Coordinator-owned identity and history fields", async () => {
  const harness = await createHarness({ initialTurnsPage: { data: [], nextCursor: null } });
  try {
    await harness.runtime.resume.resume({
      threadId: "thread-one",
      history: { entries: ["recorded"] },
      path: "/explicit/path.jsonl",
      modelProvider: "custom-provider",
      requestOverrides: {
        threadId: "thread-evil",
        history: "evil-history",
        path: "/evil/path",
        excludeTurns: false,
        initialTurnsPage: { limit: 999 },
        customExtension: "kept",
      },
    });
    const request = harness.requests.find((entry) => entry.method === "thread/resume");
    assert.equal(request?.params.threadId, "thread-one");
    assert.deepEqual(request?.params.history, { entries: ["recorded"] });
    assert.equal(request?.params.path, "/explicit/path.jsonl");
    assert.equal(request?.params.excludeTurns, true);
    assert.deepEqual(request?.params.initialTurnsPage, {
      limit: 5,
      itemsView: "full",
      sortDirection: "desc",
    });
    assert.equal(request?.params.modelProvider, "custom-provider");
    assert.equal(request?.params.customExtension, "kept");
  } finally {
    await harness.close();
  }
});

test("a server-rejected Resume pauses automatic retries but permits explicit retry", async () => {
  const options: HarnessOptions = { failResume: true, initialTurnsPage: { data: [], nextCursor: null } };
  const harness = await createHarness(options);
  try {
    await assert.rejects(harness.runtime.resume.resume({ threadId: "thread-one" }), /resume failed/);
    options.failResume = false;
    await assert.rejects(harness.runtime.resume.resume({ threadId: "thread-one", force: true }), /resume failed/);
    assert.equal(harness.requests.filter((entry) => entry.method === "thread/resume").length, 1);
    const recovered = await harness.runtime.resume.resume({ threadId: "thread-one", retryRejected: true });
    assert.equal(recovered.resumeState, "resumed");
    assert.deepEqual(recovered.streamRole, { role: "owner" });
    assert.equal(harness.requests.filter((entry) => entry.method === "thread/resume").length, 2);
  } finally {
    await harness.close();
  }
});

test("an explicitly retryable Resume rejection is not memoized in its generation", async () => {
  const options: HarnessOptions = { failResume: true, resumeErrorData: { retryable: true }, initialTurnsPage: { data: [], nextCursor: null } };
  const harness = await createHarness(options);
  try {
    await assert.rejects(harness.runtime.resume.resume({ threadId: "thread-one" }), /resume failed/);
    options.failResume = false;
    const recovered = await harness.runtime.resume.resume({ threadId: "thread-one" });
    assert.equal(recovered.resumeState, "resumed");
    assert.equal(harness.requests.filter(entry => entry.method === "thread/resume").length, 2);
  } finally { await harness.close(); }
});

test("a new connection generation can retry a previously rejected Resume", async () => {
  const options: HarnessOptions = { failResume: true, initialTurnsPage: { data: [], nextCursor: null } };
  const harness = await createHarness(options);
  try {
    await assert.rejects(harness.runtime.resume.resume({ threadId: "thread-one" }), /resume failed/);
    await harness.transport.close();
    options.failResume = false;
    await harness.client.connect({ clientInfo: { name: "session-test", version: "1" } });
    const recovered = await harness.runtime.resume.resume({ threadId: "thread-one" });
    assert.equal(recovered.connectionGeneration, 2);
    assert.equal(harness.requests.filter((entry) => entry.method === "thread/resume").length, 2);
  } finally {
    await harness.close();
  }
});

test("reconnect advances generation and resumes the same mounted Thread ID", async () => {
  const harness = await createHarness({ initialTurnsPage: { data: [], nextCursor: null } });
  try {
    const first = await harness.runtime.resume.resume({ threadId: "thread-one" });
    assert.equal(first.connectionGeneration, 1);
    await harness.transport.close();
    await harness.client.connect({ clientInfo: { name: "session-test", version: "1" } });
    const second = await harness.runtime.resume.resume({ threadId: "thread-one" });
    assert.equal(second.threadId, "thread-one");
    assert.equal(second.connectionGeneration, 2);
    assert.equal(harness.requests.filter((entry) => entry.method === "thread/resume").length, 2);
  } finally {
    await harness.close();
  }
});

test("paginated Item cursor corruption fails Resume and rolls ownership back", async () => {
  const harness = await createHarness({
    historyMode: "paginated",
    repeatItemCursor: true,
    turnsPages: {
      "turns:head": { data: [{ id: "turn-1" }], nextCursor: null },
    },
    itemsByTurnId: {
      "turn-1": [{ id: "item-1", type: "userMessage" }],
    },
  });
  try {
    await assert.rejects(
      harness.runtime.resume.resume({ threadId: "thread-one" }),
      /unchanged cursor/,
    );
    assert.equal(harness.runtime.views.get("thread-one")?.resumeState, "needs_resume");
    assert.equal(harness.runtime.ownership.get("thread-one"), null);
  } finally {
    await harness.close();
  }
});

test("tail background cursor corruption is isolated as historyError after a valid View commit", async () => {
  const harness = await createHarness({
    drainTailHistory: true,
    repeatTurnsCursor: true,
    initialTurnsPage: { data: [{ id: "turn-2", items: [] }], nextCursor: "turns:older" },
    turnsPages: {
      "turns:older": { data: [{ id: "turn-1", items: [] }], nextCursor: "turns:older" },
    },
  });
  try {
    const view = await harness.runtime.resume.resume({ threadId: "thread-one" });
    assert.equal(view.resumeState, "resumed");
    await harness.runtime.resume.waitForBackgroundHistory("thread-one");
    const afterDrain = harness.runtime.views.get("thread-one");
    assert.equal(afterDrain?.resumeState, "resumed");
    assert.match(afterDrain?.historyError?.message ?? "", /repeated cursor/);
  } finally {
    await harness.close();
  }
});

test("late tail hydration completion is inert after the Cordis Session is disposed", async () => {
  const harness = await createHarness({
    turnsDelayMs: 30,
    initialTurnsPage: { data: [{ id: "turn-2", items: [] }], nextCursor: "turns:older" },
    turnsPages: {
      "turns:older": { data: [{ id: "turn-1", items: [] }], nextCursor: null },
    },
  });
  const view = await harness.runtime.resume.resume({ threadId: "thread-one" });
  assert.equal(view.resumeState, "resumed");
  await harness.close();
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
});

test("releasing a Thread fences a late history page and later notifications", async () => {
  let release = () => {};
  let requested = () => {};
  const captured = new Promise<void>(resolve => { requested = resolve; });
  const harness = await createHarness({
    initialTurnsPage: { data: [{ id: "tail", status: "completed", itemsView: "full", items: [] }], nextCursor: "older" },
    turnsPages: { older: { data: [{ id: "old", status: "completed", itemsView: "full", items: [] }], nextCursor: null } },
    holdTurnsResponse: respond => { release = respond; requested(); },
  });
  try {
    await harness.runtime.resume.resume({ threadId: "thread-one" });
    const loading = harness.runtime.resume.loadOlder("thread-one");
    const cancelled = assert.rejects(loading, error => error instanceof AppServerClientError && error.code === "ABORTED");
    await captured;
    harness.runtime.resume.release("thread-one");
    await cancelled; // Local release settles before the held page replies.
    release();
    await harness.emit("item/agentMessage/delta", { threadId: "thread-one", turnId: "tail", itemId: "reply", delta: "late" });
    assert.equal(harness.runtime.views.get("thread-one"), null);
    assert.equal(harness.runtime.views.getAll().length, 0);
  } finally { release(); await harness.close(); }
});

test("hidden frame fallback batches text while lifecycle barriers flush immediately", async () => {
  const scheduler = createThreadViewFrameScheduler(() => undefined, () => 250);
  const harness = await createHarness({ frameScheduler: scheduler });
  try {
    harness.runtime.resume.adoptFork(resumeResult({ responseTurns: [{ id: "turn-one", status: "inProgress", items: [{ id: "reply", type: "agentMessage", text: "A" }] }] }) as never,
      harness.client.connectionGeneration);
    let publications = 0;
    harness.runtime.views.subscribeThread("thread-one", () => { publications++; });
    await harness.emit("item/agentMessage/delta", { threadId: "thread-one", turnId: "turn-one", itemId: "reply", delta: "B" });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(publications, 0, "reading get() would itself flush the pending projection");
    await harness.emit("turn/completed", { threadId: "thread-one", turn: { id: "turn-one", status: "completed", items: [] } });
    assert.equal(harness.runtime.views.get("thread-one")?.turns[0]?.items?.[0]?.text, "AB");
    assert.equal(harness.runtime.views.get("thread-one")?.turns[0]?.status, "completed");
  } finally { await harness.close(); }
});


test("provider unchanged recovery preserves the immutable transcript across connection generations", async () => {
  const options: HarnessOptions = { historyMode: "paginated", initialTurnsPage: {
    data: [{ id: "stable", status: "completed", itemsView: "full", items: [{ id: "answer", type: "agentMessage", text: "unchanged" }] }], nextCursor: null,
  }, historyRecovery: { checkpoint: { epoch: "provider-history", nextSeq: 4 }, mode: "replace" } };
  const h = await createHarness(options);
  try {
    const first = await h.runtime.resume.resume({ threadId: "thread-one" });
    options.historyRecovery = { checkpoint: { epoch: "provider-history", nextSeq: 4 }, mode: "unchanged" };
    // Force the old path to request a full Turn page; unchanged recovery must not use it.
    options.initialTurnsPage = null;
    const turnsBefore = h.requests.filter(request => request.method === "thread/turns/list").length;
    await h.transport.close();
    await h.client.connect({ clientInfo: { name: "test", version: "1" } });
    const next = await h.runtime.resume.resume({ threadId: "thread-one", force: true });
    assert.equal(next.turns, first.turns);
    assert.notEqual(next.connectionGeneration, first.connectionGeneration);
    assert.equal(next.historyCheckpoint?.epoch, "provider-history");
    assert.equal(next.execution.approvalPolicy, "on-request");
    assert.equal(h.requests.filter(request => request.method === "thread/turns/list").length, turnsBefore,
      "unchanged recovery must not rebuild the full Turn history");
    const resumes = h.requests.filter(request => request.method === "thread/resume");
    assert.deepEqual(resumes.at(-1)?.params.historyCheckpoint, { epoch: "provider-history", nextSeq: 4 });
  } finally { await h.close(); }
});

test("an explicitly suppressed history checkpoint is not sent on reconnect", async () => {
  const options: HarnessOptions = { historyMode: "paginated", initialTurnsPage: {
    data: [{ id: "stable", status: "completed", itemsView: "full", items: [{ id: "answer", type: "agentMessage", text: "unchanged" }] }], nextCursor: null,
  }, historyRecovery: { checkpoint: { epoch: "provider-history", nextSeq: 4 }, mode: "replace" } };
  const h = await createHarness(options);
  try {
    await h.runtime.resume.resume({ threadId: "thread-one" });
    await h.transport.close();
    await h.client.connect({ clientInfo: { name: "test", version: "1" } });
    await h.runtime.resume.resume({ threadId: "thread-one", force: true, historyCheckpoint: null });
    const request = h.requests.filter(entry => entry.method === "thread/resume").at(-1)!;
    assert.equal("historyCheckpoint" in request.params, false, "a non-authoritative or active reconnect must not offer its checkpoint");
    assert.equal(request.params.historyCheckpoint, undefined);
  } finally { await h.close(); }
});


test("bounded replacement accepts terminal authority, drops old running coverage and keeps explicit unresolved/new observations", async () => {
  const { reconcileRecoveryWindow } = await import("@opencraft/appserver-session");
  const cached = { id: "cached-running", status: "inProgress", items: [] };
  const same = { id: "current", status: "inProgress", items: [] };
  const unresolved = { id: "accepted", status: "inProgress", items: [] };
  const fresh = { id: "notification", status: "completed", items: [] };
  const terminal = { id: "current", status: "completed", itemsView: "full" as const, items: [] };
  const result = reconcileRecoveryWindow([cached, same, unresolved, fresh], [terminal], [cached, same, unresolved], ["accepted"]);
  assert.equal(result.some(turn => turn.id === "cached-running"), false);
  assert.equal(result.find(turn => turn.id === "current")?.status, "completed");
  assert.equal(result.find(turn => turn.id === "accepted"), unresolved);
  assert.equal(result.find(turn => turn.id === "notification"), fresh);
});


test("message-window refresh rejects a tail from an older connection generation", async () => {
  let respond!: () => void;
  const h = await createHarness({ historyMode: "message-window", initialTurnsPage: { data: [], nextCursor: null },
    turnsPages: { null: { data: [{ id: "new-tail", items: [], status: "completed" }], nextCursor: null } },
    holdTurnsResponse: send => { respond = send; } });
  try {
    await h.runtime.resume.resume({ threadId: "thread-one" });
    h.runtime.views.update("thread-one", view => ({ ...view, thread: { ...view.thread!, updatedAt: -1 } }));
    const refresh = h.runtime.resume.refreshHistory("thread-one");
    for (let i = 0; i < 30 && !respond; i++) await new Promise(r => setTimeout(r, 0));
    assert.ok(respond);
    const generation = h.client.connectionGeneration;
    Object.defineProperty(h.client, "connectionGeneration", { configurable: true, value: generation + 1 });
    respond(); assert.equal(await refresh, false);
    assert.equal(h.runtime.views.get("thread-one")!.turns.some(t => t.id === "new-tail"), false);
  } finally { delete (h.client as unknown as Record<string, unknown>).connectionGeneration; await h.close(); }
});

test("loadOlder waits for an active message-window tail refresh", async () => {
  const pending: Array<() => void> = [];
  const h = await createHarness({ historyMode: "message-window", initialTurnsPage: { data: [], nextCursor: "older" },
    turnsPages: { null: { data: [{ id: "tail", items: [], status: "completed" }], nextCursor: "older" },
      older: { data: [{ id: "older", items: [], status: "completed" }], nextCursor: null } },
    holdTurnsResponse: send => { pending.push(send); } });
  try {
    await h.runtime.resume.resume({ threadId: "thread-one" });
    h.runtime.views.update("thread-one", view => ({ ...view, thread: { ...view.thread!, updatedAt: -1 } }));
    const refresh = h.runtime.resume.refreshHistory("thread-one");
    for (let i = 0; i < 30 && !pending.length; i++) await new Promise(r => setTimeout(r, 0));
    assert.equal(pending.length, 1);
    const older = h.runtime.resume.loadOlder("thread-one");
    await new Promise(r => setTimeout(r, 0)); assert.equal(pending.length, 1, "older read cannot invalidate an in-flight tail");
    pending.shift()!(); await refresh;
    for (let i = 0; i < 30 && !pending.length; i++) await new Promise(r => setTimeout(r, 0));
    assert.equal(pending.length, 1); pending.shift()!(); await older;
    assert.deepEqual(h.runtime.views.get("thread-one")!.turns.map(t => t.id), ["older", "tail"]);
  } finally { for (const respond of pending) respond(); await h.close(); }
});

test("message-window refresh advances history without Resume and skips an unchanged revision", async () => {
  const h = await createHarness({ historyMode: "message-window", initialTurnsPage: { data: [], nextCursor: null },
    turnsPages: { null: { data: [{ id: "external-tail", items: [], status: "completed" }], nextCursor: null } } });
  try {
    await h.runtime.resume.resume({ threadId: "thread-one" });
    h.runtime.views.update("thread-one", view => ({ ...view, thread: { ...view.thread!, updatedAt: -1 } }));
    assert.equal(await h.runtime.resume.refreshHistory("thread-one"), true);
    assert.deepEqual(h.runtime.views.get("thread-one")!.turns.map(turn => turn.id), ["external-tail"]);
    assert.equal(h.requests.filter(request => request.method === "thread/resume").length, 1);
    const reads = h.requests.filter(request => request.method === "thread/turns/list").length;
    assert.equal(await h.runtime.resume.refreshHistory("thread-one"), false);
    assert.equal(h.requests.filter(request => request.method === "thread/turns/list").length, reads);
    assert.equal(h.runtime.views.get("thread-one")!.resumeState, "resumed");
  } finally { await h.close(); }
});

test("a cancelled history refresh cannot publish its delayed tail", async () => {
  let respond!: () => void;
  const h = await createHarness({ historyMode: "message-window", initialTurnsPage: { data: [], nextCursor: null },
    turnsPages: { null: { data: [{ id: "cancelled-tail", items: [] }], nextCursor: null } },
    holdTurnsResponse: send => { respond = send; } });
  try {
    await h.runtime.resume.resume({ threadId: "thread-one" });
    h.runtime.views.update("thread-one", view => ({ ...view, thread: { ...view.thread!, updatedAt: -1 } }));
    const controller = new AbortController();
    const refresh = h.runtime.resume.refreshHistory("thread-one", controller.signal);
    const settled = refresh.catch(() => false);
    for (let i = 0; i < 30 && !respond; i++) await new Promise(r => setTimeout(r, 0));
    assert.ok(respond); controller.abort(); respond();
    assert.equal(await settled, false);
    assert.deepEqual(h.runtime.views.get("thread-one")!.turns, []);
    assert.equal(h.runtime.views.get("thread-one")!.resumeState, "resumed");
  } finally { await h.close(); }
});

test("a released history owner cannot be recreated by a delayed refresh", async () => {
  let respond!: () => void;
  const h = await createHarness({ historyMode: "message-window", initialTurnsPage: { data: [], nextCursor: null },
    turnsPages: { null: { data: [{ id: "retired-tail", items: [] }], nextCursor: null } },
    holdTurnsResponse: send => { respond = send; } });
  try {
    await h.runtime.resume.resume({ threadId: "thread-one" });
    h.runtime.views.update("thread-one", view => ({ ...view, thread: { ...view.thread!, updatedAt: -1 } }));
    const refresh = h.runtime.resume.refreshHistory("thread-one");
    for (let i = 0; i < 30 && !respond; i++) await new Promise(r => setTimeout(r, 0));
    assert.ok(respond); h.runtime.resume.release("thread-one"); respond();
    assert.equal(await refresh, false);
    assert.equal(h.runtime.views.get("thread-one"), null);
  } finally { await h.close(); }
});

test("history refresh coalesces reads and preserves notifications arriving during a tail fetch", async () => {
  let respond!: () => void;
  const h = await createHarness({ historyMode: "message-window", initialTurnsPage: { data: [], nextCursor: null },
    turnsPages: { null: { data: [{ id: "external", status: "completed", items: [] }], nextCursor: null } },
    holdTurnsResponse: send => { respond = send; } });
  try {
    await h.runtime.resume.resume({ threadId: "thread-one" });
    h.runtime.views.update("thread-one", view => ({ ...view, thread: { ...view.thread!, updatedAt: -1 } }));
    const first = h.runtime.resume.refreshHistory("thread-one");
    const second = h.runtime.resume.refreshHistory("thread-one");
    assert.equal(first, second);
    for (let i = 0; i < 30 && !respond; i++) await new Promise(r => setTimeout(r, 0));
    assert.ok(respond);
    await h.emit("turn/started", { threadId: "thread-one", turn: { id: "live", status: "inProgress", items: [] } });
    await h.emit("item/started", { threadId: "thread-one", turnId: "live", item: { id: "answer", type: "agentMessage", text: "new observation" } });
    respond(); assert.equal(await first, true);
    const turns = h.runtime.views.get("thread-one")!.turns;
    assert.deepEqual(turns.map(turn => turn.id), ["external", "live"]);
    assert.equal(turns[1]?.items[0]?.text, "new observation");
    assert.equal(h.requests.filter(request => request.method === "thread/turns/list").length, 1);
  } finally { respond?.(); await h.close(); }
});

test("history refresh does not request paginated or legacy transcripts", async () => {
  for (const historyMode of ["paginated", "legacy"] as const) {
    const h = await createHarness({ historyMode, useTailHydration: false });
    try {
      await h.runtime.resume.resume({ threadId: "thread-one" });
      const reads = h.requests.length;
      assert.equal(await h.runtime.resume.refreshHistory("thread-one"), false);
      assert.equal(h.requests.length, reads);
    } finally { await h.close(); }
  }
});

test("durable paginated restore consumes full Turns without Item request waterfalls", async () => {
  const turns = [{ id: "new", itemsView: "full", items: [{ id: "answer", type: "agentMessage", text: "Latest answer" }] },
    { id: "old", itemsView: "full", items: [{ id: "question", type: "userMessage" }] }];
  const h = await createHarness({ hostKind: "durable", historyMode: "paginated",
    historyRecovery: { mode: "replace", checkpoint: { epoch: "engine", nextSeq: 4 } },
    turnsPages: { null: { data: turns, nextCursor: "older" } } });
  try {
    const view = await h.runtime.resume.resume({ threadId: "thread-one" });
    assert.deepEqual(view.turns.map(t => t.id), ["old", "new"]);
    assert.equal(view.turns[1]?.items?.[0]?.id, "answer");
    assert.equal(view.turnsPagination.olderCursor, "older");
    assert.equal(h.requests.filter(r => r.method === "thread/items/list").length, 0);
    assert.equal(h.requests.find(r => r.method === "thread/turns/list")?.params.itemsView, "full");
  } finally { await h.close(); }
});

test("durable provider's advertised initial page restores without a second history read", async () => {
  const h = await createHarness({ hostKind: "durable", historyMode: "paginated", historyModeHint: "paginated",
    historyRecovery: { mode: "replace", checkpoint: { epoch: "engine", nextSeq: 4 } },
    initialTurnsPage: { data: [{ id: "tail", itemsView: "full", items: [{ id: "answer", type: "agentMessage", text: "Loaded once" }] }], nextCursor: "older" } });
  try {
    const view = await h.runtime.resume.resume({ threadId: "thread-one" });
    assert.equal(view.turns[0]?.items?.[0]?.id, "answer");
    assert.equal(view.turnsPagination.olderCursor, "older");
    assert.ok(h.requests.find(r => r.method === "thread/resume")?.params.initialTurnsPage);
    assert.equal(h.requests.filter(r => r.method === "thread/turns/list" || r.method === "thread/items/list").length, 0);
  } finally { await h.close(); }
});


test("oversized durable full page retains adaptive Item pagination and all messages", async () => {
  const h = await createHarness({ hostKind: "durable", historyMode: "paginated", oversizedFullPage: true,
    historyRecovery: { mode: "replace", checkpoint: { epoch: "engine", nextSeq: 4 } },
    turnsPages: { null: { data: [{ id: "tail", itemsView: "notLoaded" }], nextCursor: null } },
    itemsByTurnId: { tail: [{ id: "answer", type: "agentMessage", text: "Still available" }] } });
  try {
    const view = await h.runtime.resume.resume({ threadId: "thread-one" });
    assert.equal(view.turns[0]?.items?.[0]?.id, "answer");
    assert.deepEqual(h.requests.filter(r => r.method === "thread/turns/list").map(r => r.params.itemsView), ["full", "notLoaded"]);
    assert.equal(h.requests.filter(r => r.method === "thread/items/list").length, 1);
  } finally { await h.close(); }
});


test("oversized advertised Resume page falls back without dropping history", async () => {
  const h = await createHarness({ hostKind: "durable", historyMode: "paginated", oversizedResumePage: true,
    historyRecovery: { mode: "replace", checkpoint: { epoch: "engine", nextSeq: 4 } },
    turnsPages: { null: { data: [{ id: "tail", itemsView: "full", items: [{ id: "answer", type: "agentMessage", text: "Kept" }] }], nextCursor: null } } });
  try {
    const view = await h.runtime.resume.resume({ threadId: "thread-one" });
    assert.equal(view.turns[0]?.items?.[0]?.id, "answer");
    const requests = h.requests.filter(r => r.method === "thread/resume");
    assert.equal(requests.length, 2);
    assert.ok(requests[0]?.params.initialTurnsPage);
    assert.equal(requests[1]?.params.initialTurnsPage, undefined);
    assert.equal(h.requests.filter(r => r.method === "thread/turns/list").length, 1);
  } finally { await h.close(); }
});


test("unadvertised durable providers preserve bounded Item reads", async () => {
  const h = await createHarness({ hostKind: "durable", historyMode: "paginated",
    turnsPages: { null: { data: [{ id: "tail", itemsView: "notLoaded" }], nextCursor: null } },
    itemsByTurnId: { tail: [{ id: "answer", type: "agentMessage", text: "Kept" }] } });
  try {
    const view = await h.runtime.resume.resume({ threadId: "thread-one" });
    assert.equal(view.turns[0]?.items?.[0]?.id, "answer");
    assert.equal(h.requests.find(r => r.method === "thread/resume")?.params.initialTurnsPage, undefined);
    assert.deepEqual(h.requests.filter(r => r.method === "thread/turns/list").map(r => r.params.itemsView), ["notLoaded"]);
    assert.equal(h.requests.filter(r => r.method === "thread/items/list").length, 1);
  } finally { await h.close(); }
});


test("paged history retains finite lifecycle clocks from Item envelopes", async () => {
  const harness = await createHarness({ hostId: "durable", hostKind: "durable", historyMode: "paginated",
    turnsPages: { null: { data: [{ id: "timed" }], nextCursor: null } },
    itemsByTurnId: { timed: [{ id: "answer", type: "agentMessage" }, { id: "late", type: "commandExecution", status: "failed", exitCode: 137 }] },
    itemClocksById: { answer: { startedAtMs: 300, completedAtMs: 310 }, late: { startedAtMs: 100, completedAtMs: 400 } },
  });
  try {
    const view = await harness.runtime.resume.resume({ threadId: "thread-one" });
    const items = view.turns.find(turn => turn.id === "timed")!.items;
    assert.deepEqual(items.map(item => [item.id, item.startedAtMs, item.completedAtMs]), [["answer", 300, 310], ["late", 100, 400]]);
    assert.equal(items[1]?.exitCode, 137);
  } finally { await harness.close(); }
});

test("command completions update known executions and do not invent an untimed tail", async () => {
  const harness = await createHarness({ useTailHydration: false });
  try {
    await harness.runtime.resume.resume({ threadId: "thread-one" });
    await harness.emit("turn/started", { threadId: "thread-one", turn: { id: "late", status: "inProgress", items: [] } });
    await harness.emit("item/started", { threadId: "thread-one", turnId: "late", startedAtMs: 100,
      item: { id: "known", type: "commandExecution", command: "check" } });
    await harness.emit("item/started", { threadId: "thread-one", turnId: "late", startedAtMs: 300,
      item: { id: "answer", type: "agentMessage", text: "Done", phase: "final_answer" } });
    await harness.emit("item/completed", { threadId: "thread-one", turnId: "late", startedAtMs: 900, completedAtMs: 400,
      item: { id: "known", type: "commandExecution", status: "failed", exitCode: 137 } });
    await harness.emit("item/completed", { threadId: "thread-one", turnId: "late",
      item: { id: "orphan", type: "commandExecution", status: "failed", exitCode: 137 } });
    let items = harness.runtime.views.get("thread-one")!.turns.find(turn => turn.id === "late")!.items;
    assert.deepEqual(items.map(item => item.id), ["known", "answer"]);
    assert.equal(items[0]?.startedAtMs, 100);
    assert.equal(items[0]?.completedAtMs, 400);
    assert.equal(items[0]?.exitCode, 137);
    await harness.emit("item/completed", { threadId: "thread-one", turnId: "late", completedAtMs: 500,
      item: { id: "recoverable", type: "commandExecution", command: "check again", durationMs: 300, status: "failed", exitCode: 137 } });
    items = harness.runtime.views.get("thread-one")!.turns.find(turn => turn.id === "late")!.items;
    assert.equal(items.find(item => item.id === "recoverable")?.startedAtMs, 200);
  } finally { await harness.close(); }
});

const typedHistoryBudgetError = { code: -32072, message: "History response is too large; use a smaller history page",
  data: { code: "HISTORY_RESPONSE_TOO_LARGE", retryable: false } };
for (const hostKind of ["local", "durable"] as const) test(`typed history budgets adapt Resume and Item pages without losing ${hostKind} history`, async () => {
  const h = await createHarness({ hostKind, historyMode: "paginated", oversizedResumePage: true, oversizedFullPage: true,
    historySizeError: typedHistoryBudgetError, maxItemsLimit: 1,
    historyRecovery: { mode: "replace", checkpoint: { epoch: "engine", nextSeq: 4 } },
    turnsPages: Object.fromEntries(["null", "turns:head"].map(cursor => [cursor, { data: [{ id: "tail", itemsView: "notLoaded", items: [] }], nextCursor: null }])),
    itemsByTurnId: { tail: ["one", "two", "three"].map(id => ({ id, type: "agentMessage", text: id })) } });
  try {
    const view = await h.runtime.resume.resume({ threadId: "thread-one" });
    assert.deepEqual(view.turns[0]?.items?.map(item => item.id), ["one", "two", "three"]);
    assert.equal(view.resumeState, "resumed");
    assert.deepEqual(h.requests.filter(r => r.method === "thread/resume").map(r => Boolean(r.params.initialTurnsPage)), [true, false]);
    const reads = h.requests.filter(r => r.method === "thread/items/list");
    assert.equal(reads[0]?.params.limit, 100); assert.equal(reads.at(-1)?.params.limit, 1); assert(reads.length < 12);
    assert.equal(h.requests.filter(r => r.method === "turn/start").length, 0);
  } finally { await h.close(); }
});

test("a single oversized history Item fails finitely without repeatedly resuming", async () => {
  const h = await createHarness({ hostKind: "durable", historyMode: "paginated", oversizedResumePage: true,
    historySizeError: typedHistoryBudgetError, maxItemsLimit: 0,
    historyRecovery: { mode: "replace", checkpoint: { epoch: "engine", nextSeq: 4 } },
    turnsPages: { null: { data: [{ id: "tail", itemsView: "notLoaded", items: [] }], nextCursor: null } } });
  try {
    await assert.rejects(h.runtime.resume.resume({ threadId: "thread-one" }), (error: any) => error.data?.code === "HISTORY_RESPONSE_TOO_LARGE");
    const count = h.requests.length;
    await assert.rejects(h.runtime.resume.resume({ threadId: "thread-one" })); assert.equal(h.requests.length, count);
    assert.equal(h.requests.filter(r => r.method === "thread/resume").length, 2);
    const reads = h.requests.filter(r => r.method === "thread/items/list"); assert.equal(reads.at(-1)?.params.limit, 1); assert(reads.length <= 8);
  } finally { await h.close(); }
});

test("Read opens historical Turns and older pages without Resume; explicit continuation can Resume", async () => {
  const harness = await createHarness({ historyMode: "paginated", turnsPages: {
    null: { data: [{ id: "newer", items: [] }], nextCursor: "older" },
    older: { data: [{ id: "older", items: [] }], nextCursor: null },
  } });
  try {
    const read = await harness.runtime.resume.read("thread-one");
    assert.equal(read.resumeState, "needs_resume");
    assert.equal(read.streamRole, null);
    assert.equal(harness.requests.filter(r => r.method === "thread/resume").length, 0);
    assert.equal(harness.requests.filter(r => r.method === "model/list").length, 0);
    const older = await harness.runtime.resume.loadOlder("thread-one");
    assert.deepEqual(older.turns.map(t => t.id), ["older", "newer"]);
    assert.equal(harness.requests.filter(r => r.method === "thread/resume").length, 0);
    const resumed = await harness.runtime.resume.resume({ threadId: "thread-one" });
    assert.equal(resumed.resumeState, "resumed");
    assert.equal(harness.requests.filter(r => r.method === "thread/resume").length, 1);
  } finally { await harness.close(); }
});

test("live completions arriving during a read baseline obtain a quiet canonical cut without Resume", async () => {
  let release: (() => void) | undefined, pages = 0;
  const turnsPages = { null: { data: [{ id: "live-read", status: "inProgress", itemsView: "full", items: [{ id: "answer", type: "agentMessage", text: "old" }] }], nextCursor: null } };
  const h = await createHarness({ historyMode: "paginated", holdTurnsResponse: respond => { if (++pages === 1) release = respond; else respond(); }, turnsPages });
  try {
    const reading = h.runtime.resume.read("thread-one");
    for (let n = 0; n < 50 && !release; n++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(release);
    await h.emit("item/completed", { threadId: "thread-one", turnId: "live-read", item: { id: "answer", type: "agentMessage", text: "new final" } });
    release();
    turnsPages.null = { data: [{ id: "live-read", status: "completed", itemsView: "full", items: [{ id: "answer", type: "agentMessage", text: "new final" }] }], nextCursor: null };
    const view = await reading;
    assert.equal(view.turns[0]?.items?.[0]?.text, "new final");
    assert.equal(view.turns[0]?.status, "completed");
    assert.equal(pages, 2);
    assert.equal(h.requests.some(r => r.method === "thread/resume"), false);
  } finally { await h.close(); }
});

for (const included of [false, true]) test(`Read obtains a quiet snapshot instead of duplicating buffered deltas (already included=${included})`, async () => {
  let release!: () => void, pages = 0;
  const turnsPages = { null: { data: [{ id: "live-read", status: "inProgress", itemsView:"full", items: [{ id: "answer", type: "agentMessage", text: included ? "AB" : "A" }] }], nextCursor: null } };
  const h = await createHarness({ historyMode: "paginated", turnsPages,
    holdTurnsResponse: respond => { if (++pages === 1) release = respond; else respond(); } });
  try {
    const reading = h.runtime.resume.read("thread-one");
    for (let n = 0; n < 100 && !release; n++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(release);
    await h.emit("item/agentMessage/delta", { threadId: "thread-one", turnId: "live-read", itemId: "answer", delta: "B" });
    release();
    turnsPages.null = { data: [{ id: "live-read", status: "completed", itemsView:"full", items: [{ id: "answer", type: "agentMessage", text: "AB" }] }], nextCursor: null };
    const view = await reading;
    assert.equal(view.turns[0]?.items[0]?.text, "AB");
    assert.equal(view.turns[0]?.status, "completed");
    assert.equal(pages, 2);
    assert.equal(h.requests.some(r => r.method === "thread/resume"), false);
  } finally { await h.close(); }
});

test("Read and older history adapt full-page and Item budgets without Resume", async () => {
  const h = await createHarness({ historyMode: "paginated", readHistory: true, oversizedResumePage: true,
    oversizedFullPage: true, historySizeError: typedHistoryBudgetError, maxItemsLimit: 1,
    turnsPages: {
      null: { data: [{ id: "tail", itemsView: "notLoaded", items: [] }], nextCursor: "older" },
      older: { data: [{ id: "old", itemsView: "notLoaded", items: [] }], nextCursor: null },
    },
    itemsByTurnId: Object.fromEntries(["tail", "old"].map(turn => [turn, ["a", "b", "c"].map(id => ({ id: `${turn}-${id}`, type: "agentMessage", text: id }))])),
  });
  try {
    await h.runtime.resume.read("thread-one");
    const view = await h.runtime.resume.loadOlder("thread-one");
    assert.deepEqual(view.turns.map(t => t.id), ["old", "tail"]);
    assert.deepEqual(view.turns.map(t => t.items.length), [3, 3]);
    assert.equal(h.requests.filter(r => r.method === "thread/resume").length, 0);
    assert.deepEqual(h.requests.filter(r => r.method === "thread/read").map(r => Boolean(r.params.initialTurnsPage)), [true, false]);
    assert.equal(h.requests.filter(r => r.method === "thread/turns/list" && r.params.itemsView === "notLoaded").length, 2);
    assert.equal(h.requests.filter(r => r.method === "thread/items/list").at(-1)?.params.limit, 1);
  } finally { await h.close(); }
});

for (const [method, type, field, extra] of [
  ["item/plan/delta", "plan", "text", {}],
  ["item/commandExecution/outputDelta", "commandExecution", "aggregatedOutput", {}],
  ["item/reasoning/summaryTextDelta", "reasoning", "summary", { summaryIndex: 0 }],
  ["item/reasoning/textDelta", "reasoning", "content", { contentIndex: 0 }],
] as const) test(`Read supersedes overlapping ${method} and preserves request resolution`, async () => {
  let release!: () => void, pages = 0;
  const resolutions: unknown[] = [];
  const value = type === "reasoning" ? ["AB"] : "AB";
  const h = await createHarness({ historyMode: "paginated",
    turnsPages: { null: { data: [{ id: "live", itemsView: "full", status: "completed", items: [{ id: "item", type, [field]: value }] }], nextCursor: null } },
    holdTurnsResponse: respond => { if (++pages === 1) release = respond; else respond(); } });
  const unsubscribe = h.client.subscribeNotification(notification => { if (notification.method === "serverRequest/resolved") resolutions.push(notification.params); });
  try {
    const reading = h.runtime.resume.read("thread-one");
    for (let n = 0; n < 100 && !release; n++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(release);
    await h.emit("serverRequest/resolved", { threadId: "thread-one", requestId: "approval-one" });
    await h.emit(method, { threadId: "thread-one", turnId: "live", itemId: "item", delta: "B", ...extra });
    release();
    const view = await reading;
    assert.deepEqual(view.turns[0]?.items[0]?.[field], value);
    assert.equal(view.turns[0]?.status, "completed");
    assert.equal(pages, 2);
    assert.deepEqual(resolutions, [{ threadId: "thread-one", requestId: "approval-one" }]);
    assert.equal(h.requests.filter(r => r.method === "thread/resume").length, 0);
  } finally { unsubscribe(); await h.close(); }
});
