import assert from "node:assert/strict";
import test from "node:test";

import { AppServerRpcError, JsonRpcAppServerClient } from "@opencraft/appserver-client";
import {
  createCordisThreadSessionRuntime,
  type CordisThreadSessionRuntime,
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
  historyMode?: "legacy" | "paginated";
  responseTurns?: readonly Record<string, unknown>[];
  initialTurnsPage?: { data: readonly Record<string, unknown>[]; nextCursor: string | null } | null;
  turnsPages?: Readonly<Record<string, { data: readonly Record<string, unknown>[]; nextCursor: string | null }>>;
  itemsByTurnId?: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  fallbackTurns?: readonly Record<string, unknown>[];
  resumeDelayMs?: number;
  turnsDelayMs?: number;
  failResume?: boolean;
  malformedResume?: boolean;
  emitDuringResume?: boolean;
  requestDuringResume?: boolean;
  repeatItemCursor?: boolean;
  repeatTurnsCursor?: boolean;
  hostId?: string;
  hostKind?: "local" | "durable";
  useTailHydration?: boolean;
  drainTailHistory?: boolean;
}

const initializeResult = {
  codexHome: "/tmp/codex",
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
    model: "codex",
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
        peer.send(encodeJsonRpcMessage({ id: message.id, result: initializeResult }));
        return;
      }
      if (message.method === "thread/read") {
        const turns = params.includeTurns === true ? options.fallbackTurns ?? [] : [];
        peer.send(encodeJsonRpcMessage({
          id: message.id,
          result: { thread: thread("thread-one", turns, options.historyMode) },
        }));
        return;
      }
      if (message.method === "thread/resume") {
        if (options.emitDuringResume) {
          peer.send(encodeJsonRpcMessage({
            method: "thread/status/changed",
            params: { threadId: "thread-one", status: { type: "active" } },
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
              error: { code: -32022, message: "resume failed" },
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
        const key = typeof params.cursor === "string" ? params.cursor : "null";
        const selected = options.turnsPages?.[key] ?? { data: [], nextCursor: null };
        const page = options.repeatTurnsCursor && typeof params.cursor === "string"
          ? { ...selected, nextCursor: params.cursor }
          : selected;
        const respond = () => peer.send(encodeJsonRpcMessage({ id: message.id, result: page }));
        if ((options.turnsDelayMs ?? 0) > 0) setTimeout(respond, options.turnsDelayMs);
        else respond();
        return;
      }
      if (message.method === "thread/items/list") {
        const turnId = String(params.turnId);
        const items = options.itemsByTurnId?.[turnId] ?? [];
        peer.send(encodeJsonRpcMessage({
          id: message.id,
          result: {
            data: items.map((item) => ({ turnId, item })),
            nextCursor: options.repeatItemCursor && typeof params.cursor === "string" ? params.cursor : null,
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
    hostKind: options.hostKind,
    useTailHydration: options.useTailHydration,
    drainTailHistory: options.drainTailHistory,
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

test("ordinary tail hydration commits newest Turns then drains older history", async () => {
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
    const drained = harness.runtime.views.get("thread-one");
    assert.deepEqual(drained?.turns.map((turn) => turn.id), ["turn-1", "turn-2", "turn-3"]);
    assert.equal(drained?.tailHydrationComplete, true);
    assert.equal(drained?.execution.model, "codex");
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

test("Durable hydration loads Turn Items separately with full projections", async () => {
  const harness = await createHarness({
    hostId: "durable",
    hostKind: "durable",
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

test("notifications and server requests stay buffered until the View commit", async () => {
  const harness = await createHarness({
    initialTurnsPage: { data: [], nextCursor: null },
    emitDuringResume: true,
    requestDuringResume: true,
  });
  const observedStates: string[] = [];
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
    assert.deepEqual(observedStates, ["resumed", "resumed"]);
    assert.equal(harness.runtime.views.get("thread-one")?.notificationRevision, 1);
    assert.deepEqual(harness.approvalResponses, [{ decision: "accept" }]);
  } finally {
    removeNotification();
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
    assert.equal(view.execution.model, "codex:projected");
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

test("a failed Resume can retry the same ID without leaked ownership or buffers", async () => {
  const options: HarnessOptions = { failResume: true, initialTurnsPage: { data: [], nextCursor: null } };
  const harness = await createHarness(options);
  try {
    await assert.rejects(harness.runtime.resume.resume({ threadId: "thread-one" }), /resume failed/);
    options.failResume = false;
    const recovered = await harness.runtime.resume.resume({ threadId: "thread-one" });
    assert.equal(recovered.resumeState, "resumed");
    assert.deepEqual(recovered.streamRole, { role: "owner" });
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
