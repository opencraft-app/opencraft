import assert from "node:assert/strict";
import test from "node:test";
import { TransparentBackendLifecycleService } from "../src/services/transparent-backend-lifecycle.ts";
import { TransparentBackendIngressService } from "../src/services/transparent-backend-ingress.ts";
import { TransparentBackendBootstrapService } from "../src/services/transparent-backend-bootstrap.ts";
import { TransparentBackendOpenService } from "../src/services/transparent-backend-open.ts";
import { TransparentHandoffService } from "../src/services/transparent-handoff.ts";
import { TransparentAccountEventService } from "../src/services/transparent-account-event.ts";
import { TransparentBackendRpcService } from "../src/services/transparent-backend-rpc.ts";
import { TransparentSubscriptionService } from "../src/services/transparent-subscription.ts";
import { TransparentProcessBridgeService } from "../src/services/transparent-process-bridge.ts";
import { TransparentRequestRouterService } from "../src/services/transparent-request-router.ts";
import { TransparentRequestDispatchService } from
  "../src/services/transparent-request-dispatch.ts";
import { TransparentThreadActivationService } from
  "../src/services/transparent-thread-activation.ts";
import { TransparentThreadAdmissionService } from
  "../src/services/transparent-thread-admission.ts";
import { AppServerProjectionService } from "../src/services/appserver-projection.ts";
import { TransparentWorkspaceControlService } from "../src/services/transparent-workspace-control.ts";
import { TransparentOuterDispatchService } from "../src/services/transparent-outer-dispatch.ts";
import { TransparentBackendMessageService } from "../src/services/transparent-backend-message.ts";
import { TransparentBackendOutboundService } from "../src/services/transparent-backend-outbound.ts";
import { TransparentForwardedResponseService } from "../src/services/transparent-forwarded-response.ts";
import { TransparentInternalResponseService } from "../src/services/transparent-internal-response.ts";
import {
  reconcileOrphanedCanonicalTurns,
  reconcileTransparentStartupRuntimes,
} from "../src/services/transparent-runtime-recovery.ts";
import { TransparentThreadBindingService } from "../src/services/transparent-thread-binding.ts";
import { hydrateTransparentBindings } from "../src/services/transparent-thread-binding.ts";

import {
  TransparentCodexThreadService,
} from "../src/services/transparent-codex-thread.ts";
import {
  projectedItemsPage,
  projectedTurnsPage,
} from "../src/services/transparent-thread-history.ts";
import {
  completeOrphanInterrupt,
} from "../src/services/transparent-thread-routing.ts";
import {
  attachTransparentBackendChannel,
  attachTransparentProtocolMapper,
} from "./support/transparent-protocol-mapper.mjs";

function transparentSubscription() {
  return Object.assign(Object.create(TransparentSubscriptionService.prototype), {
    threadSubscribers: new Map(),
    catalogBroadcasts: new Map(),
  });
}

function transparentBackendIngress() {
  return Object.create(TransparentBackendIngressService.prototype);
}

function transparentBackendBootstrap() {
  return Object.create(TransparentBackendBootstrapService.prototype);
}

function transparentAccountEvent() {
  return Object.create(TransparentAccountEventService.prototype);
}

function transparentBackendOpen() {
  return Object.create(TransparentBackendOpenService.prototype);
}

function transparentHandoff() {
  return Object.create(TransparentHandoffService.prototype);
}

function transparentRequestRouter() {
  return Object.create(TransparentRequestRouterService.prototype);
}

function attachTransparentRequestDispatch(ctx) {
  ctx.administrator ??= { hasAgent: () => true };
  ctx.threadManager.isRoot ??= () => false;
  ctx.appServer ??= {
    send: (connection, message) => connection.socket.send(message),
  };
  ctx.transparentSubscription ??= transparentSubscription();
  ctx.threadExecution ??= {};
  ctx.threadExecution.table ??= new Map();
  if (ctx.transparentThreadActivation) ctx.transparentThreadActivation.ctx = ctx;
  if (ctx.appServerProjection) ctx.appServerProjection.ctx = ctx;
  if (ctx.transparentWorkspaceControl) ctx.transparentWorkspaceControl.ctx = ctx;
  const dispatch = Object.create(TransparentRequestDispatchService.prototype);
  dispatch.ctx = ctx;
  ctx.transparentRequestDispatch = dispatch;
}

function transparentThreadActivation() {
  return Object.assign(Object.create(TransparentThreadActivationService.prototype), { ctx: null });
}

function appServerProjection() {
  return Object.assign(Object.create(AppServerProjectionService.prototype), {
    prepare: (method, params) => ({ method, params }),
  });
}

function transparentWorkspaceControl() {
  return Object.create(TransparentWorkspaceControlService.prototype);
}

function transparentBackendMessage() {
  return Object.create(TransparentBackendMessageService.prototype);
}

function transparentBackendOutbound() {
  return Object.create(TransparentBackendOutboundService.prototype);
}

function transparentForwardedResponse() {
  return Object.create(TransparentForwardedResponseService.prototype);
}

function transparentInternalResponse(ctx) {
  return Object.assign(Object.create(TransparentInternalResponseService.prototype), { ctx });
}

function transparentThreadBinding(host) {
  const service = Object.assign(Object.create(TransparentThreadBindingService.prototype), {
    bindings: new Map(),
    runtimeHints: new Map(),
    reverseBindings: new Map(),
  });
  service.host = () => host;
  hydrateTransparentBindings(service, host);
  return service;
}

test("interrupting an orphaned active projection converges it without a runtime", () => {
  const sent = [];
  const notifications = [];
  const interruptedTurn = { id: "turn-stale", status: "interrupted", items: [] };
  const ctx = {
    threadManager: {
      reconcileInterruptedRuntime: (threadId) => {
        assert.equal(threadId, "thread-1");
        return [interruptedTurn];
      },
    },
    appServer: {
      broadcastNotification: (method, params) => notifications.push({ method, params }),
    },
  };
  const connection = { socket: { send: (message) => sent.push(message) } };

  assert.equal(completeOrphanInterrupt(ctx, connection, "thread-1", "interrupt-1"), true);
  assert.deepEqual(sent, [{ id: "interrupt-1", result: {} }]);
  assert.deepEqual(notifications.map(({ method }) => method), [
    "turn/completed", "thread/status/changed",
  ]);
  assert.equal(notifications[0].params.turn.status, "interrupted");
  assert.equal(notifications[0].params.turn.itemsView, "summary");
});

test("interrupting an already idle orphan is idempotently successful", () => {
  const sent = [];
  const notifications = [];
  const completed = [];
  const ctx = {
    threadManager: { reconcileInterruptedRuntime: () => [] },
    threadExecution: {
      complete: (threadId, options) => completed.push({ threadId, options }),
    },
    appServer: {
      broadcastNotification: (method, params) => notifications.push({ method, params }),
    },
  };
  const connection = { socket: { send: (message) => sent.push(message) } };

  assert.equal(completeOrphanInterrupt(ctx, connection, "thread-idle", "interrupt-2"), true);
  assert.deepEqual(sent, [{ id: "interrupt-2", result: {} }]);
  assert.deepEqual(completed, [{
    threadId: "thread-idle",
    options: { reason: "interruptConverged" },
  }]);
  assert.deepEqual(notifications, [{
    method: "thread/status/changed",
    params: { threadId: "thread-idle", status: { type: "idle" } },
  }]);
});

test("new DSH threads defer a creator-scoped prewarm until after thread/start", () => {
  const deferred = [];
  const prepared = [];
  const service = Object.create(TransparentThreadAdmissionService.prototype);
  service.ctx = {
    appServer: {
      defer: (connection, delayMs, action) => deferred.push({ connection, delayMs, action }),
    },
    executionEngine: {
      prepareThread: (options) => prepared.push(options),
    },
  };
  const connection = { connectionId: "connection-1" };
  const options = {
    threadId: "thread-1",
    profile: { engineKind: "dsh", fingerprint: "profile-1" },
    credential: { userId: "user-1" },
    filesystem: { kind: "workspace" },
    viewId: "main",
    cwd: "/workspace/projects/demo",
  };

  service.scheduleDshPrewarm({ connection, ...options });

  assert.equal(prepared.length, 0);
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0].connection, connection);
  assert.equal(deferred[0].delayMs, 0);
  deferred[0].action();
  assert.deepEqual(prepared, [{
    ...options,
    // The deferred prewarm retains the exact creator connection so client-
    // hosted DSH capabilities cannot fall back to another live Renderer.
    connection,
    prewarm: true,
  }]);
});

function createHarness(pairs) {
  const sent = [];
  const projected = [];
  const connection = { socket: { send: (message) => sent.push(structuredClone(message)) } };
  const ownerUserId = "user:alice";
  const service = Object.create(TransparentCodexThreadService.prototype);
  service.bindings = new Map();
  service.reverseBindings = new Map();
  service.backends = new Map();
  service.threadSubscribers = new Map();
  service.persistBindings = () => {};
  const transparentProcessBridge = Object.create(TransparentProcessBridgeService.prototype);
  transparentProcessBridge.sequence = 0;
  const transparentBackendRpc = Object.create(TransparentBackendRpcService.prototype);
  service.ctx = {
    transparentBackendMessage: transparentBackendMessage(),
    transparentBackendOutbound: transparentBackendOutbound(),
    transparentForwardedResponse: transparentForwardedResponse(),
    transparentAccountEvent: transparentAccountEvent(),
    transparentBackendBootstrap: transparentBackendBootstrap(),
    transparentBackendIngress: transparentBackendIngress(),
    transparentBackendOpen: transparentBackendOpen(),
    transparentHandoff: transparentHandoff(),
    transparentOuterDispatch: Object.create(TransparentOuterDispatchService.prototype),
    transparentBackendRpc,
    transparentSubscription: transparentSubscription(),
    transparentProcessBridge,
    transparentRequestRouter: transparentRequestRouter(),
    transparentThreadActivation: transparentThreadActivation(),
    transparentWorkspaceControl: transparentWorkspaceControl(),
    canonicalTimeline: {
      recordAppServer() {},
      turns: (threadId) => service.ctx.threadManager.find(threadId)?.turns ?? [],
    },
    appServerProjection: appServerProjection(),
    virtualFilesystem: { toVirtual: (value) => value },
    threadManager: {
      ownerOf: () => ownerUserId,
      find: () => null,
      isTransparentCodex: () => true,
      project: (outerThreadId, thread) => projected.push({ type: "thread", outerThreadId, thread }),
      projectTurn: (outerThreadId, turn, phase) => projected.push({ type: "turn", outerThreadId, turn, phase }),
      archive: () => {},
      unarchive: () => {},
    },
  };
  service.ctx.appServerProjection.ctx = service.ctx;
  service.ctx.transparentInternalResponse = transparentInternalResponse(service.ctx);
  attachTransparentRequestDispatch(service.ctx);
  attachTransparentProtocolMapper(service);
  service.ctx.transparentOuterDispatch.ctx = service.ctx;
  service.ctx.transparentOuterDispatch.sequence = 0;

  const internalRequests = new Map();
  const pendingByOuter = new Map();
  for (const { requestId, outerThreadId } of pairs) {
    internalRequests.set(requestId, { outerThreadId, method: "thread/start" });
    pendingByOuter.set(outerThreadId, [{
      connection,
      message: { id: `client:${outerThreadId}`, method: "thread/start", params: { cwd: "/localhost" } },
      respondFromOpen: true,
    }]);
  }
  const state = {
    ownerUserId,
    user: null,
    connections: new Set([connection]),
    internalRequests,
    internalControlRequests: new Map(),
    forwardedRequests: new Map(),
    serverRequestIds: new Map(),
    abandonedRequestIds: new Set(),
    pendingThreadMessages: new Map(),
    opening: new Set(pairs.map(({ outerThreadId }) => outerThreadId)),
    opened: new Set(),
    openResults: new Map(),
    pendingByOuter,
    threadOwners: new Map(),
  };
  service.backends.set(ownerUserId, state);
  return { service, state, sent, projected };
}

test("thread notifications wait for thread/start binding and replay with the outer id", () => {
  const outerThreadId = "outer-thread";
  const innerThreadId = "inner-thread";
  const { service, state, sent, projected } = createHarness([{
    requestId: "backend-start",
    outerThreadId,
  }]);

  service.onBackendMessage(state, {
    method: "thread/started",
    params: { thread: { id: innerThreadId, cwd: "/tmp/alice" } },
  });
  service.onBackendMessage(state, {
    method: "thread/status/changed",
    params: { threadId: innerThreadId, status: { type: "idle" } },
  });

  assert.equal(sent.length, 0, "an unbound backend id must never reach the Renderer");
  assert.equal(projected.length, 0, "an unbound backend id must not create a second projection");
  assert.equal(state.pendingThreadMessages.get(innerThreadId)?.length, 2);

  service.onBackendMessage(state, {
    id: "backend-start",
    result: { thread: { id: innerThreadId, cwd: "/tmp/alice" } },
  });

  assert.deepEqual(sent.map((message) => message.method ?? "response"), [
    "thread/started",
    "thread/status/changed",
    "response",
  ]);
  assert.equal(sent[0].params.thread.id, outerThreadId);
  assert.equal(sent[1].params.threadId, outerThreadId);
  assert.equal(sent[2].result.thread.id, outerThreadId);
  assert.equal(JSON.stringify(sent).includes(innerThreadId), false);
  assert.equal(state.pendingThreadMessages.size, 0);
});

test("concurrent thread starts retain independent notification queues", () => {
  const pairs = [
    { requestId: "start-a", outerThreadId: "outer-a", innerThreadId: "inner-a" },
    { requestId: "start-b", outerThreadId: "outer-b", innerThreadId: "inner-b" },
  ];
  const { service, state, sent } = createHarness(pairs);

  for (const pair of pairs) {
    service.onBackendMessage(state, {
      method: "thread/started",
      params: { thread: { id: pair.innerThreadId } },
    });
  }
  assert.equal(sent.length, 0);

  service.onBackendMessage(state, {
    id: "start-b",
    result: { thread: { id: "inner-b" } },
  });
  assert.deepEqual(sent.map((message) => message.params?.thread?.id ?? message.result?.thread?.id), [
    "outer-b",
    "outer-b",
  ]);
  assert.equal(state.pendingThreadMessages.has("inner-a"), true);

  service.onBackendMessage(state, {
    id: "start-a",
    result: { thread: { id: "inner-a" } },
  });
  assert.deepEqual(sent.slice(2).map((message) => message.params?.thread?.id ?? message.result?.thread?.id), [
    "outer-a",
    "outer-a",
  ]);
  assert.equal(state.pendingThreadMessages.size, 0);
});

test("provisional thread reads are served from the outer catalog until the first Turn", () => {
  const sent = [];
  const forwarded = [];
  const outerThread = { id: "outer-thread", status: { type: "idle" }, turns: [] };
  const connection = { socket: { send: (message) => sent.push(message) } };
  const service = Object.create(TransparentCodexThreadService.prototype);
  service.bindings = new Map([[
    outerThread.id,
    { innerThreadId: "inner-provisional", durable: false, realm: "workspace", viewId: "main" },
  ]]);
  service.sequence = 0;
  service.ctx = {
    transparentOuterDispatch: Object.create(TransparentOuterDispatchService.prototype),
    threadManager: { get: () => outerThread },
  };
  attachTransparentBackendChannel(service);
  service.ctx.transparentOuterDispatch.ctx = service.ctx;
  service.ctx.transparentOuterDispatch.sequence = 0;
  service.filesystem = () => ({ send: (...args) => forwarded.push(args) });

  service.forwardNow({
    backendKey: "runtime", processId: "codex", forwardedRequests: new Map(),
  }, connection, outerThread.id, {
    id: "read", method: "thread/read", params: { threadId: outerThread.id, includeTurns: true },
  });

  assert.deepEqual(sent, [{ id: "read", result: { thread: outerThread } }]);
  assert.equal(forwarded.length, 0);
});

test("shared thread history pages come from the authoritative outer projection", () => {
  const thread = {
    id: "outer-thread",
    turns: [
      { id: "turn-1", items: [{ id: "item-1", type: "userMessage" }] },
      { id: "turn-2", items: [{ id: "item-2", type: "agentMessage" }] },
      { id: "turn-3", items: [{ id: "item-3", type: "agentMessage" }] },
    ],
  };
  const first = projectedTurnsPage(thread, {
    threadId: thread.id, limit: 2, sortDirection: "desc", itemsView: "notLoaded",
  });
  assert.deepEqual(first.data.map((turn) => turn.id), ["turn-3", "turn-2"]);
  assert.deepEqual(first.data.map((turn) => turn.items), [[], []]);
  assert.ok(first.nextCursor);
  const second = projectedTurnsPage(thread, {
    threadId: thread.id, limit: 2, sortDirection: "desc", cursor: first.nextCursor,
  });
  assert.deepEqual(second.data.map((turn) => turn.id), ["turn-1"]);
  assert.equal(second.nextCursor, null);

  const items = projectedItemsPage(thread, {
    threadId: thread.id, turnId: "turn-2", sortDirection: "asc",
  });
  assert.deepEqual(items.data, [{ turnId: "turn-2", item: thread.turns[1].items[0] }]);
});

test("summary history retains the first user message and final assistant message", () => {
  const thread = {
    id: "outer-thread",
    turns: [{
      id: "turn-1",
      items: [
        { id: "question", type: "userMessage" },
        { id: "tool", type: "commandExecution" },
        { id: "answer", type: "agentMessage" },
      ],
    }],
  };

  const page = projectedTurnsPage(thread, {
    threadId: thread.id, limit: 1, sortDirection: "desc", itemsView: "summary",
  });
  assert.equal(page.data[0].itemsView, "summary");
  assert.deepEqual(page.data[0].items.map(({ id }) => id), ["question", "answer"]);
});

test("shared thread resume returns the complete paginated-history contract", () => {
  const sent = [];
  const thread = {
    id: "outer-thread",
    cwd: "/workspace/projects/mono2",
    turns: [
      { id: "turn-1", items: [{ id: "item-1", type: "userMessage" }] },
      { id: "turn-2", items: [{ id: "item-2", type: "agentMessage" }] },
    ],
  };
  const connection = {
    identity: { id: "user:alice" },
    socket: { send: (message) => sent.push(structuredClone(message)) },
  };
  const service = Object.create(TransparentCodexThreadService.prototype);
  service.connections = new Map();
  service.send = (_connection, message) => sent.push(structuredClone(message));
  service.subscribeThread = () => {};
  service.ctx = {
    transparentRequestRouter: transparentRequestRouter(),
    transparentThreadActivation: transparentThreadActivation(),
    appServerProjection: appServerProjection(),
    canonicalTimeline: { turns: () => thread.turns },
    threadManager: {
      isTransparentCodex: (threadId) => threadId === thread.id,
      get: () => thread,
    },
    modelGateway: { activeForConnection: () => null },
  };
  attachTransparentRequestDispatch(service.ctx);

  assert.equal(service.intercept({
    id: "resume",
    method: "thread/resume",
    params: {
      threadId: thread.id,
      excludeTurns: true,
      initialTurnsPage: { limit: 1, sortDirection: "desc", itemsView: "notLoaded" },
    },
  }, connection), true);

  const result = sent[0].result;
  assert.deepEqual(result.thread.turns, []);
  assert.equal(typeof result.turnsBackwardsCursor, "string");
  assert.equal(typeof result.itemsBackwardsCursor, "string");
  assert.deepEqual(result.initialTurnsPage.data.map((turn) => turn.id), ["turn-2"]);
  assert.deepEqual(result.initialTurnsPage.data[0].items, []);
  assert.equal(sent[1].method, "thread/started");
  assert.deepEqual(sent[1].params.thread.turns, [],
    "thread/started must match native Codex and never replay hydrated history");
  assert.deepEqual(sent[2], {
    method: "thread/status/changed",
    params: { threadId: thread.id, status: { type: "idle" } },
  });

  const turns = projectedTurnsPage(thread, {
    threadId: thread.id,
    cursor: result.turnsBackwardsCursor,
    limit: 2,
    sortDirection: "desc",
  });
  assert.deepEqual(turns.data.map((turn) => turn.id), ["turn-2", "turn-1"]);

  const items = projectedItemsPage(thread, {
    threadId: thread.id,
    cursor: result.itemsBackwardsCursor,
    limit: 2,
    sortDirection: "desc",
  });
  assert.deepEqual(items.data.map(({ item }) => item.id), ["item-2", "item-1"]);
});

test("an interrupted shared turn remains visible while thread/started stays metadata-only", () => {
  const sent = [];
  const thread = {
    id: "outer-interrupted",
    cwd: "/workspace/projects/mono2",
    status: { type: "idle" },
    turns: [{
      id: "turn-interrupted",
      status: "interrupted",
      itemsView: "full",
      items: [
        { id: "question", type: "userMessage", content: [{ type: "text", text: "按钮不跟手" }] },
        { id: "commentary", type: "agentMessage", text: "正在定位", phase: "commentary" },
        { id: "command", type: "commandExecution", status: "failed", aggregatedOutput: "failed" },
      ],
    }],
  };
  const connection = {
    identity: { id: "user:observer" },
    socket: { send: (message) => sent.push(structuredClone(message)) },
  };
  const service = Object.create(TransparentCodexThreadService.prototype);
  service.connections = new Map();
  service.send = (_connection, message) => sent.push(structuredClone(message));
  service.subscribeThread = () => {};
  service.ctx = {
    transparentRequestRouter: transparentRequestRouter(),
    transparentThreadActivation: transparentThreadActivation(),
    appServerProjection: appServerProjection(),
    canonicalTimeline: { turns: () => thread.turns },
    threadManager: {
      isTransparentCodex: (threadId) => threadId === thread.id,
      get: () => thread,
    },
    modelGateway: { activeForConnection: () => null },
  };
  attachTransparentRequestDispatch(service.ctx);

  assert.equal(service.intercept({
    id: "resume-interrupted",
    method: "thread/resume",
    params: {
      threadId: thread.id,
      excludeTurns: true,
      initialTurnsPage: { limit: 5, itemsView: "full", sortDirection: "desc" },
    },
  }, connection), true);

  assert.equal(sent[0].result.initialTurnsPage.data[0].status, "interrupted");
  assert.deepEqual(
    sent[0].result.initialTurnsPage.data[0].items.map((item) => item.id),
    ["question", "commentary", "command"],
  );
  assert.deepEqual(sent[1].params.thread.turns, []);
});

test("opening another user's thread never launches or validates their private provider", () => {
  const sent = [];
  const subscribed = [];
  const queued = [];
  const thread = {
    id: "outer-thread",
    cwd: "/workspace/projects/mono2",
    turns: [{ id: "turn-1", items: [] }],
  };
  const connection = {
    identity: { id: "user:skipzhang" },
    socket: { send: (message) => sent.push(structuredClone(message)) },
  };
  const service = Object.create(TransparentCodexThreadService.prototype);
  service.connections = new Map();
  service.bindings = new Map([[thread.id, {
    innerThreadId: "inner-thread",
    ownerUserId: "user:mingyuxiao",
    providerId: "private-shawn",
  }]]);
  service.send = (_connection, message) => sent.push(structuredClone(message));
  service.subscribeThread = (_connection, threadId) => subscribed.push(threadId);
  service.queueForOuter = (...args) => queued.push(args);
  service.ctx = {
    transparentRequestRouter: transparentRequestRouter(),
    transparentThreadActivation: transparentThreadActivation(),
    appServerProjection: appServerProjection(),
    canonicalTimeline: { turns: () => thread.turns },
    threadManager: {
      isTransparentCodex: (threadId) => threadId === thread.id,
      get: () => thread,
    },
    modelGateway: { activeForConnection: () => null },
    transparentSubscription: { subscribe: (_connection, threadId) => subscribed.push(threadId) },
  };
  attachTransparentRequestDispatch(service.ctx);

  for (const message of [
    { id: "read", method: "thread/read", params: { threadId: thread.id, includeTurns: true } },
    { id: "turns", method: "thread/turns/list", params: { threadId: thread.id } },
    { id: "resume", method: "thread/resume", params: {
      threadId: thread.id,
      model: "ep-private-model",
      modelProvider: "private-shawn",
      permissions: ":danger-full-access",
      runtimeWorkspaceRoots: ["/workspace/projects/mono2"],
    } },
  ]) {
    assert.equal(service.intercept(message, connection), true);
  }

  assert.equal(queued.length, 0, "read-side requests must not create a Codex backend");
  assert.deepEqual(subscribed, [thread.id, thread.id, thread.id]);
  assert.equal(sent[0].result.thread.id, thread.id);
  assert.equal(sent[1].result.data[0].id, "turn-1");
  assert.equal(sent[2].result.modelProvider, "openai");
  assert.equal(sent[2].result.model, "gpt-5.6-sol");
  assert.deepEqual(sent[2].result.sandbox, { type: "dangerFullAccess" });
  assert.deepEqual(sent[2].result.runtimeWorkspaceRoots, ["/workspace/projects/mono2"]);
  assert.equal(JSON.stringify(sent).includes("private-shawn"), false);
  assert.equal(JSON.stringify(sent).includes("ep-private-model"), false);
});

test("outer catalog mutations are handled locally for transparent threads", () => {
  const { service } = createHarness([]);
  const connection = { socket: { send: () => {} } };

  assert.equal(service.intercept({
    id: "pin-thread",
    method: "thread/section/move",
    params: {
      threadId: "outer-thread",
      sectionId: "01984de2-8f74-7c91-a3b2-5c5e937cf318",
    },
  }, connection), false);

  assert.equal(service.intercept({
    id: "metadata",
    method: "thread/metadata/update",
    params: { threadId: "outer-thread", gitInfo: { branch: "main" } },
  }, connection), false, "metadata must not launch the thread's execution engine");

  for (const method of [
    "hypernode/threadWriteLease/acquire",
    "hypernode/threadWriteLease/heartbeat",
    "hypernode/threadWriteLease/read",
    "hypernode/threadWriteLease/release",
  ]) {
    assert.equal(service.intercept({
      id: method,
      method,
      params: { threadId: "outer-thread" },
    }, connection), false, `${method} must remain in the HyperNode outer control plane`);
  }
});

test("archive is an outer control-plane operation even when history is non-empty", () => {
  const sent = [];
  const broadcasts = [];
  const released = [];
  const closed = [];
  const connection = { socket: { send: (message) => sent.push(message) } };
  const thread = { id: "outer-thread", turns: [{ id: "turn-1" }] };
  const service = Object.create(TransparentCodexThreadService.prototype);
  service.connections = new Map();
  service.bindings = new Map([[thread.id, { innerThreadId: "inner-thread" }]]);
  service.broadcastCatalog = (method, threadId) => broadcasts.push({ method, threadId });
  service.ctx = {
    transparentRequestRouter: transparentRequestRouter(),
    transparentThreadActivation: transparentThreadActivation(),
    appServerProjection: appServerProjection(),
    transparentWorkspaceControl: transparentWorkspaceControl(),
    transparentRuntimeRetirement: {
      closeArchivedWorkspaceBackend: (threadId) => closed.push(threadId),
      retireThreadRuntimeIfIdle: () => false,
    },
    transparentThreadFork: { start: () => {} },
    canonicalTimeline: { turns: () => [] },
    threadManager: {
      isTransparentCodex: () => true,
      isArchived: () => false,
      get: () => thread,
      archive: () => thread,
    },
    runtimeWorkspace: {
      enabled: true,
      recordFor: () => ({ state: "active", viewId: "main" }),
      archive: (archived) => released.push(["workspace", archived.id]),
    },
    threadWriteLease: { releaseThread: (threadId) => released.push(["lease", threadId]) },
    threadExecution: { releaseThread: (threadId, reason) => released.push([reason, threadId]) },
  };
  attachTransparentRequestDispatch(service.ctx);
  attachTransparentBackendChannel(service);
  service.ctx.transparentBackendChannel.broadcastCatalog =
    (method, threadId) => broadcasts.push({ method, threadId });

  assert.equal(service.intercept({
    id: "archive", method: "thread/archive", params: { threadId: thread.id },
  }, connection), true);
  assert.deepEqual(sent, [{ id: "archive", result: {} }]);
  assert.deepEqual(broadcasts, [{ method: "thread/archived", threadId: thread.id }]);
  assert.deepEqual(closed, [thread.id]);
  assert.deepEqual(released, [
    ["workspace", thread.id],
    ["lease", thread.id],
    ["threadArchived", thread.id],
  ]);
});

test("destroyed workspace views retain readable history without launching a backend", () => {
  const sent = [];
  const aborted = [];
  const connection = { socket: { send: (message) => sent.push(message) } };
  const service = Object.create(TransparentCodexThreadService.prototype);
  service.connections = new Map();
  service.send = (_connection, message) => sent.push(message);
  service.subscribeThread = () => {};
  service.ctx = {
    transparentRequestRouter: transparentRequestRouter(),
    transparentThreadActivation: transparentThreadActivation(),
    appServerProjection: appServerProjection(),
    transparentWorkspaceControl: transparentWorkspaceControl(),
    canonicalTimeline: { turns: () => [] },
    threadManager: {
      isTransparentCodex: () => true,
      get: () => ({ id: "outer-thread", cwd: "/workspace/projects", turns: [] }),
    },
    modelGateway: { activeForConnection: () => null },
    runtimeWorkspace: {
      enabled: true,
      recordFor: () => ({ state: "destroyed", viewId: "fork-deleted" }),
      assertRuntimeAvailable: (threadId) => {
        const error = new Error("workspace view has been destroyed; fork the archived conversation to continue");
        error.code = -32071;
        error.data = { kind: "workspaceViewDestroyed", threadId, viewId: "fork-deleted" };
        throw error;
      },
    },
    threadExecution: { abortRequest: (...args) => aborted.push(args) },
  };
  attachTransparentRequestDispatch(service.ctx);
  attachTransparentBackendChannel(service);

  assert.equal(service.intercept({
    id: "read", method: "thread/read", params: { threadId: "outer-thread" },
  }, connection), true);
  assert.equal(connection.activeThreadId, "outer-thread");
  assert.equal(sent.at(-1).result.thread.id, "outer-thread");

  assert.equal(service.intercept({
    id: "resume", method: "thread/resume", params: { threadId: "outer-thread" },
  }, connection), true);
  assert.equal(sent.at(-3).result.thread.id, "outer-thread");
  assert.equal(sent.at(-2).method, "thread/started");
  assert.deepEqual(sent.at(-1), {
    method: "thread/status/changed",
    params: { threadId: "outer-thread", status: { type: "idle" } },
  });

  assert.equal(service.intercept({
    id: "turn", method: "turn/start", params: { threadId: "outer-thread", input: [] },
  }, connection), true);
  assert.deepEqual(aborted, [["outer-thread", connection, "turn"]]);
});

test("archive tombstones fan out globally and duplicate backend events are suppressed", () => {
  const notifications = [];
  const service = Object.create(TransparentCodexThreadService.prototype);
  service.catalogBroadcasts = new Map();
  service.ctx = {
    appServer: { broadcastNotification: (method, params) => notifications.push({ method, params }) },
    transparentSubscription: transparentSubscription(),
  };
  attachTransparentBackendChannel(service);

  assert.equal(service.broadcastCatalog("thread/archived", "outer-thread", null, 10_000), true);
  assert.equal(service.broadcastCatalog("thread/archived", "outer-thread", null, 10_100), false);
  assert.equal(service.broadcastCatalog("thread/archived", "outer-thread", null, 12_001), true);
  assert.deepEqual(notifications, [
    { method: "thread/archived", params: { threadId: "outer-thread" } },
    { method: "thread/archived", params: { threadId: "outer-thread" } },
  ]);
});

test("outer thread subscriptions survive a Codex backend handoff", () => {
  const executorMessages = [];
  const observerMessages = [];
  const unrelatedMessages = [];
  const executor = { socket: { send: (message) => executorMessages.push(message) } };
  const observer = { socket: { send: (message) => observerMessages.push(message) } };
  const unrelated = { socket: { send: (message) => unrelatedMessages.push(message) } };
  const service = Object.create(TransparentCodexThreadService.prototype);
  service.ctx = { transparentSubscription: transparentSubscription() };
  service.threadSubscribers = service.ctx.transparentSubscription.threadSubscribers;
  attachTransparentBackendChannel(service);
  service.subscribeThread(executor, "outer-thread");
  service.subscribeThread(observer, "outer-thread");

  // The new account runtime only owns the executor connection.  Fanout must
  // follow the stable outer thread subscription rather than runtime ownership.
  const newAccountState = { connections: new Set([executor, unrelated]) };
  service.broadcast(newAccountState, {
    method: "item/agentMessage/delta",
    params: { threadId: "outer-thread", turnId: "turn-1", delta: "hello" },
  });

  assert.equal(executorMessages.length, 1);
  assert.equal(observerMessages.length, 1);
  assert.equal(unrelatedMessages.length, 0);
});

test("thread unsubscribe removes only the requesting outer subscriber", () => {
  const first = { socket: { send: () => {} } };
  const second = { socket: { send: () => {} } };
  const service = Object.create(TransparentCodexThreadService.prototype);
  service.ctx = { transparentSubscription: transparentSubscription() };
  service.threadSubscribers = service.ctx.transparentSubscription.threadSubscribers;
  attachTransparentBackendChannel(service);
  service.subscribeThread(first, "outer-thread");
  service.subscribeThread(second, "outer-thread");

  assert.equal(service.unsubscribeThread(first, "outer-thread"), true);
  assert.deepEqual([...service.threadSubscribers.get("outer-thread")], [second]);
  assert.equal(service.unsubscribeThread(first, "outer-thread"), false);
});

test("startup restores a missing binding from the durable artifact catalog", () => {
  const previousPolicyStore = globalThis.policyStore;
  const writes = [];
  globalThis.policyStore = {
    get: () => null,
    set: (namespace, key, value) => writes.push({ namespace, key, value }),
  };
  try {
    const service = transparentThreadBinding({
      principalId: "node:root",
      policyStore: globalThis.policyStore,
      artifacts: {
        current: () => null,
        values: () => [{
          threadId: "outer-thread",
          innerThreadId: "inner-thread",
          generation: 3,
          path: "/workspace/.hypernode/threads/outer-thread/generation-3.jsonl",
          accountIdentity: "model-provider:user:alice:provider-1",
          ownerUserId: null,
          epoch: 8,
        }],
      },
      threads: {
        find: () => ({ id: "outer-thread", cwd: "/workspace/projects/demo" }),
        isTransparentCodex: () => true,
        ownerOf: () => "user:legacy",
      },
      workspaceViews: {
        recordFor: () => ({ viewId: "view-demo", kind: "fork" }),
      },
      users: {
        find: (id) => id === "user:alice" ? { id } : null,
        list: () => [{ id: "user:alice" }],
      },
      credentials: { resolveUser: () => null },
    });

    assert.deepEqual(service.bindings.get("outer-thread"), {
      innerThreadId: "inner-thread",
      durable: true,
      realm: "workspace",
      viewId: "view-demo",
      rolloutPath: "/workspace/.hypernode/threads/outer-thread/generation-3.jsonl",
    });
    assert.equal(service.runtimeHints.get("outer-thread").ownerUserId, "user:alice");
    assert.equal(
      service.runtimeHints.get("outer-thread").accountIdentity,
      "model-provider:user:alice:provider-1",
    );
    assert.equal(writes.at(-1).namespace, "transparentCodexBindings");
  } finally {
    globalThis.policyStore = previousPolicyStore;
  }
});

test("DSH execution profiles survive restart without a fabricated Codex binding", () => {
  const previousPolicyStore = globalThis.policyStore;
  const writes = [];
  const runtimeHint = {
    ownerUserId: "user:alice",
    accountIdentity: "model-provider:user:alice:public-auto",
    engineKind: "dsh",
    providerId: "public-auto",
    model: "auto",
    threadSettings: { model: "auto" },
    backendKey: null,
    epoch: null,
  };
  globalThis.policyStore = {
    get: () => JSON.stringify({
      version: 4,
      records: [],
      runtimeRecords: [{ outerThreadId: "outer-dsh", runtimeHint }],
    }),
    set: (namespace, key, value) => writes.push({ namespace, key, value }),
  };
  try {
    const service = transparentThreadBinding({
      principalId: "node:root",
      policyStore: globalThis.policyStore,
      artifacts: { current: () => null, values: () => [] },
      threads: {
        find: (id) => id === "outer-dsh" ? { id, cwd: "/localhost" } : null,
        isTransparentCodex: (id) => id === "outer-dsh",
      },
      workspaceViews: { recordFor: () => null },
      users: { find: () => null, list: () => [] },
      credentials: { resolveUser: () => null },
    });

    assert.equal(service.bindings.size, 0);
    assert.deepEqual(
      Object.fromEntries(Object.entries(service.runtimeHintFor("outer-dsh"))
        .filter(([, value]) => value !== undefined)),
      runtimeHint,
    );
    service.persist();
    const persisted = JSON.parse(writes.at(-1).value);
    assert.equal(persisted.version, 4);
    assert.deepEqual(persisted.records, []);
    assert.deepEqual(persisted.runtimeRecords, [{ outerThreadId: "outer-dsh", runtimeHint }]);
  } finally {
    globalThis.policyStore = previousPolicyStore;
  }
});

test("startup fences stale dedicated runtimes before clearing projected activity", () => {
  const terminated = [];
  const seeded = [];
  const reconciled = [];
  const service = Object.create(TransparentCodexThreadService.prototype);
  service.sequence = 0;
  service.bindings = new Map([[
    "outer-thread",
    { innerThreadId: "inner-thread", durable: true, realm: "workspace", viewId: "fork-a" },
  ]]);
  service.runtimeHints = new Map([[
    "outer-thread",
    { ownerUserId: "user:alice", epoch: 7 },
  ]]);
  service.ctx = {
    threadArtifactStore: {
      current: () => ({ epoch: 8 }),
    },
    threadExecution: {
      table: { seedEpoch: (threadId, epoch) => seeded.push({ threadId, epoch }) },
    },
    threadManager: {
      reconcileInterruptedRuntime: (threadId) => {
        reconciled.push(threadId);
        return [{ id: "turn-stale" }];
      },
      list: () => [],
      isTransparentCodex: () => true,
    },
    workspaceFilesystem: {
      enabled: true,
      supportsPersistentRuntimeFencing: true,
      terminateThreadRuntime: (...args) => terminated.push(args),
    },
    runtimeRegistry: {
      snapshot: () => [{
        runtimeId: "outer-thread", outerThreadId: "outer-thread",
        processId: "stale-process", realm: "workspace", viewId: "fork-a",
      }],
      clearView: () => {},
    },
  };

  service.startupRecoveryFailures = new Map();
  reconcileTransparentStartupRuntimes(
    { failures: service.startupRecoveryFailures },
    {
      bindingState: service,
      artifacts: service.ctx.threadArtifactStore,
      executionEpochs: service.ctx.threadExecution.table,
      runtimeRegistry: service.ctx.runtimeRegistry,
      workspaceRuntime: service.ctx.workspaceFilesystem,
      threads: service.ctx.threadManager,
    },
  );

  assert.deepEqual(seeded, [{ threadId: "outer-thread", epoch: 8 }]);
  assert.deepEqual(terminated, [["stale-process", "fork-a", "outer-thread", 5_000]]);
  assert.deepEqual(reconciled, ["outer-thread"]);
  assert.equal(service.startupRecoveryFailures.size, 0);
});

test("startup commits an interrupted canonical terminal for a durable orphan", () => {
  const broadcasts = [];
  const turns = [{
    id: "turn-orphan", items: [{ id: "message-partial", type: "agentMessage", text: "partial" }],
    status: "inProgress", error: null, startedAt: 1_000, completedAt: null,
    durationMs: null, itemsView: "full",
  }];
  const ctx = {
    threadExecution: {
      orphanedAttempts: [{
        executionId: "execution-orphan", threadId: "thread-orphan", epoch: 4,
        turnId: "turn-orphan", runtimeId: "runtime-orphan", state: "orphaned",
      }],
    },
    canonicalTimeline: { turns: (threadId) => threadId === "thread-orphan" ? turns : [] },
    appServerProjection: {
      broadcast: (method, params, source) => broadcasts.push({ method, params, source }),
    },
  };

  assert.equal(reconcileOrphanedCanonicalTurns(ctx, () => 1_005_000), 1);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].method, "turn/completed");
  assert.equal(broadcasts[0].params.threadId, "thread-orphan");
  assert.deepEqual(broadcasts[0].params.turn, {
    ...turns[0],
    status: "interrupted",
    error: null,
    completedAt: 1_005,
    durationMs: 5_000,
    itemsView: "summary",
  });
  assert.deepEqual(broadcasts[0].source, {
    engine: "recovery", kind: "policy-process-restart",
  });
});

test("startup fences one workspace view once for all of its historical threads", () => {
  const terminated = [];
  const reconciled = [];
  const service = Object.create(TransparentCodexThreadService.prototype);
  service.sequence = 0;
  service.bindings = new Map([
    ["outer-a", { realm: "workspace", viewId: "main" }],
    ["outer-b", { realm: "workspace", viewId: "main" }],
    ["outer-c", { realm: "workspace", viewId: "fork-c" }],
  ]);
  service.runtimeHints = new Map();
  service.ctx = {
    threadArtifactStore: { current: () => null },
    threadExecution: { table: { seedEpoch: () => {} } },
    threadManager: {
      reconcileInterruptedRuntime: (threadId) => { reconciled.push(threadId); return []; },
      list: () => [],
      isTransparentCodex: () => true,
    },
    workspaceFilesystem: {
      enabled: true,
      supportsPersistentRuntimeFencing: true,
      terminateThreadRuntime: (...args) => terminated.push(args),
    },
    runtimeRegistry: {
      snapshot: () => [
        { runtimeId: "outer-a", outerThreadId: "outer-a", processId: "process-a", realm: "workspace", viewId: "main" },
        { runtimeId: "outer-b", outerThreadId: "outer-b", processId: "process-b", realm: "workspace", viewId: "main" },
        { runtimeId: "outer-c", outerThreadId: "outer-c", processId: "process-c", realm: "workspace", viewId: "fork-c" },
      ],
      clearView: () => {},
    },
  };

  service.startupRecoveryFailures = new Map();
  reconcileTransparentStartupRuntimes(
    { failures: service.startupRecoveryFailures },
    {
      bindingState: service,
      artifacts: service.ctx.threadArtifactStore,
      executionEpochs: service.ctx.threadExecution.table,
      runtimeRegistry: service.ctx.runtimeRegistry,
      workspaceRuntime: service.ctx.workspaceFilesystem,
      threads: service.ctx.threadManager,
    },
  );

  assert.deepEqual(terminated, [
    ["process-a", "main", "outer-a", 5_000],
    ["process-c", "fork-c", "outer-c", 5_000],
  ]);
  assert.deepEqual(reconciled, ["outer-a", "outer-b", "outer-c"]);
});

test("startup clears retired workspace records without calling a disabled runtime", () => {
  const cleared = [];
  const reconciled = [];
  const bindingState = {
    bindings: new Map([["outer-thread", { realm: "workspace", viewId: "main" }]]),
    runtimeHints: new Map(),
  };
  const failures = new Map();

  reconcileTransparentStartupRuntimes(
    { failures },
    {
      bindingState,
      artifacts: { current: () => null },
      executionEpochs: { seedEpoch: () => {} },
      runtimeRegistry: {
        snapshot: () => [{
          runtimeId: "runtime-old",
          outerThreadId: "outer-thread",
          processId: "process-old",
          realm: "workspace",
          viewId: "main",
        }],
        unregister: () => false,
        clearView: (viewId) => { cleared.push(viewId); return true; },
      },
      workspaceRuntime: {
        enabled: false,
        supportsPersistentRuntimeFencing: false,
        terminateThreadRuntime: () => {
          throw new Error("disabled runtime must not be called");
        },
      },
      threads: {
        list: () => [],
        isTransparentCodex: () => true,
        reconcileInterruptedRuntime: (threadId) => reconciled.push(threadId),
      },
    },
  );

  assert.deepEqual(cleared, ["main"]);
  assert.deepEqual(reconciled, ["outer-thread"]);
  assert.equal(failures.size, 0);
});

test("startup never clears active projection when stale runtime fencing fails", () => {
  const service = Object.create(TransparentCodexThreadService.prototype);
  service.sequence = 0;
  service.bindings = new Map([[
    "outer-thread",
    { innerThreadId: "inner-thread", durable: true, realm: "workspace", viewId: "main" },
  ]]);
  service.runtimeHints = new Map();
  let reconciled = false;
  service.ctx = {
    threadArtifactStore: { current: () => null },
    threadExecution: { table: { seedEpoch: () => {} } },
    threadManager: {
      reconcileInterruptedRuntime: () => { reconciled = true; return []; },
      list: ({ archived }) => archived ? [] : [{ id: "outer-thread" }],
      isTransparentCodex: () => true,
    },
    workspaceFilesystem: {
      enabled: true,
      supportsPersistentRuntimeFencing: true,
      terminateThreadRuntime: () => { throw new Error("docker unavailable"); },
    },
    runtimeRegistry: {
      snapshot: () => [{
        runtimeId: "outer-thread", outerThreadId: "outer-thread",
        processId: "stale-process", realm: "workspace", viewId: "main",
      }],
      clearView: () => {},
    },
  };

  service.startupRecoveryFailures = new Map();
  reconcileTransparentStartupRuntimes(
    { failures: service.startupRecoveryFailures },
    {
      bindingState: service,
      artifacts: service.ctx.threadArtifactStore,
      executionEpochs: service.ctx.threadExecution.table,
      runtimeRegistry: service.ctx.runtimeRegistry,
      workspaceRuntime: service.ctx.workspaceFilesystem,
      threads: service.ctx.threadManager,
    },
  );

  assert.equal(reconciled, false);
  assert.match(service.startupRecoveryFailures.get("outer-thread").message, /docker unavailable/);
});

test("a failed dedicated runtime terminates its projected turn and releases execution authority", () => {
  const sent = [];
  const connection = { socket: { send: (message) => sent.push(structuredClone(message)) } };
  const turn = { id: "turn-1", items: [], status: "inProgress", startedAt: 1_000 };
  const thread = { id: "outer-thread", turns: [turn], status: { type: "active", activeFlags: [] } };
  const aborted = [];
  const service = Object.create(TransparentCodexThreadService.prototype);
  const lifecycle = Object.create(TransparentBackendLifecycleService.prototype);
  service.threadSubscribers = new Map([[thread.id, new Set([connection])]]);
  service.ctx = {
    transparentBackendLifecycle: lifecycle,
    transparentSubscription: transparentSubscription(),
    threadExecution: {
      abortRuntime: (runtimeId, reason) => {
        aborted.push({ runtimeId, reason });
        return [{ threadId: thread.id, turnId: turn.id }];
      },
      abortRequest: () => null,
    },
    threadManager: {
      find: () => thread,
      projectTurn: (_threadId, sourceTurn) => {
        Object.assign(turn, sourceTurn);
        thread.status = { type: "idle" };
      },
    },
  };
  lifecycle.ctx = service.ctx;
  attachTransparentBackendChannel(service);
  const state = {
    phase: "ready",
    backendKey: "runtime-a",
    stderr: [],
    connections: new Set([connection]),
    pendingControl: [],
    pendingInternalControl: [],
    internalControlRequests: new Map(),
    pendingBackendMessages: [],
    pendingThreadMessages: new Map(),
    commandProcesses: new Map(),
    commandProcessesByConnection: new Map(),
    hostProcesses: new Map(),
    hostProcessesByConnection: new Map(),
    abandonedRequestIds: new Set(),
    pendingByOuter: new Map(),
    forwardedRequests: new Map(),
  };

  service.fail(state, "runtime exited");

  assert.deepEqual(aborted, [{ runtimeId: "runtime-a", reason: "runtimeFailed" }]);
  assert.equal(turn.status, "failed");
  assert.equal(turn.error.message, "runtime exited");
  assert.deepEqual(sent.map((message) => message.method), [
    "turn/completed",
    "thread/status/changed",
  ]);
  assert.equal(sent[0].params.turn.id, "turn-1");
  assert.equal(sent[1].params.status.type, "idle");
});
