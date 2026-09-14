import assert from "node:assert/strict";
import test from "node:test";
import { TransparentThreadForkService } from "../src/services/transparent-thread-fork.ts";

function connection() {
  return {
    identity: { id: "user-1", username: "alice" },
    socket: { send() {} },
    clientInfo: null,
    initializeParams: null,
    initialized: true,
    pendingNotifications: [],
    deferredActions: [],
    watches: new Map(),
    unroutableWatchPaths: new Set(),
    connectionId: "connection-1",
    sessionId: "session-1",
  };
}

function harness(overrides = {}) {
  const calls = [];
  const state = {
    realm: "workspace",
    viewId: "fork-1",
    ownerUserId: "user-1",
    accountIdentity: "chatgpt:user-1",
    providerId: null,
    backendKey: "runtime-fork-1",
    phase: "ready",
    processId: "process-fork-1",
    opened: new Set(),
    openResults: new Map(),
    pendingBackendMessages: [],
  };
  const local = {
    thread: { id: "fork-1", cwd: "/workspace/projects/repo", turns: [] },
    cwd: "/workspace/projects/repo",
    model: "kimi-k3",
  };
  const runtimeHint = overrides.runtimeHint ?? {
    ownerUserId: "user-1",
    accountIdentity: "provider:user-1:kimi",
    engineKind: "dsh",
    providerId: "kimi",
    model: "kimi-k3",
    threadSettings: { model: "kimi-k3" },
    backendKey: "old-runtime",
    epoch: 7,
  };
  const bindings = new Map();
  if (overrides.binding) bindings.set("source-1", overrides.binding);
  const runtimeHints = new Map([["source-1", runtimeHint]]);
  const filesystem = {
    send: (...args) => calls.push(["sendRuntime", ...args]),
    drain() {},
    kill() {},
  };
  const ctx = {
    canonicalTimeline: {
      turns: () => overrides.sourceTurns ?? [{}],
    },
    runtimeWorkspace: {
      fork: () => (calls.push(["localFork"]), local),
      discardFork: (threadId) => calls.push(["discard", threadId]),
      viewIdForThread: () => "fork-1",
      ...overrides.runtimeWorkspace,
    },
    threadManager: {
      ownerOf: () => "user-1",
      ...overrides.threadManager,
    },
    transparentBackendChannel: {
      subscribe: (...args) => calls.push(["subscribe", ...args]),
      send: (_connection, message) => calls.push(["send", message]),
    },
    transparentBackendRpc: {
      trackForwarded: (...args) => calls.push(["track", ...args]),
    },
    transparentBackendLifecycle: {
      ensure: overrides.ensureBackend ?? (() => (calls.push(["ensureBackend"]), state)),
    },
    transparentBackendProjection: {
      projectThread: (...args) => calls.push(["projectThread", ...args]),
    },
    transparentRuntimeAccess: {
      filesystemForRealm: () => filesystem,
      threadBackendKey: () => "runtime-fork-1",
      backendKey: () => "runtime-control-fork-1",
      isWorkspaceFilesystem: () => true,
      filesystem: () => filesystem,
      toOuter: (response) => ({ ...response, projected: true }),
    },
    transparentThreadBinding: {
      bindings,
      runtimeHints,
      runtimeHintFor: (threadId) => runtimeHints.get(threadId) ?? null,
      setRuntimeHint: (...args) => {
        runtimeHints.set(args[0], args[1]);
        calls.push(["runtimeHint", ...args]);
      },
      setBinding: (...args) => calls.push(["binding", ...args]),
    },
  };
  const service = Object.create(TransparentThreadForkService.prototype);
  service.ctx = ctx;
  service.sequence = 0;
  const host = {
    flushThreadMessages: (...args) => calls.push(["flush", ...args]),
    ...overrides.host,
  };
  return { service, host, calls, state, local };
}

function request(params = {}) {
  return {
    connection: connection(),
    message: {
      id: "client-fork-1",
      method: "thread/fork",
      params: { threadId: "source-1", ...params },
    },
  };
}

test("DSH fork commits Workspace and canonical history without a hidden inner Thread", () => {
  const { service, host, calls } = harness();
  service.start(request({ lastTurnId: "turn-1" }));

  assert.deepEqual(calls.map(([kind]) => kind), [
    "localFork", "runtimeHint", "subscribe", "send", "send",
  ]);
  assert.equal(calls[1][1], "fork-1");
  assert.equal(calls[1][2].engineKind, "dsh");
  assert.equal(calls[1][2].backendKey, null);
  assert.equal(calls[1][2].epoch, null);
  assert.equal(calls[3][1].result.thread.id, "fork-1");
  assert.equal(calls[4][1].method, "thread/started");
});

test("Codex fork mirrors the committed outer fork into the private rollout", () => {
  const { service, host, calls } = harness({
    runtimeHint: { engineKind: "codex" },
    binding: {
      innerThreadId: "inner-source",
      durable: true,
      realm: "workspace",
      viewId: "source-view",
      rolloutPath: "/rollout/source.jsonl",
    },
  });
  service.start(request({ lastTurnId: "turn-1", model: "gpt" }));

  assert.deepEqual(calls.map(([kind]) => kind), [
    "localFork", "ensureBackend", "track", "sendRuntime",
  ]);
  assert.equal(calls[2][3].forkOuterThreadId, "fork-1");
  assert.equal(calls[3][2].method, "thread/fork");
  assert.equal(calls[3][2].params.threadId, "inner-source");
  assert.equal(calls[3][2].params.cwd, "/workspace/projects/repo");
});

test("an empty Codex source starts a fresh inner rollout without leaking outer selectors", () => {
  const { service, host, calls } = harness({
    runtimeHint: { engineKind: "codex" },
    binding: {
      innerThreadId: "inner-source",
      durable: false,
      realm: "workspace",
      viewId: "source-view",
      rolloutPath: null,
    },
    sourceTurns: [],
  });
  service.start(request({
    lastTurnId: "turn-1",
    model: "gpt",
    projectId: "project-hypernode-outer-only",
  }));

  const sent = calls.find(([kind]) => kind === "sendRuntime")[2];
  assert.equal(sent.method, "thread/start");
  assert.equal(sent.params.threadId, undefined);
  assert.equal(sent.params.lastTurnId, undefined);
  assert.equal(sent.params.projectId, undefined);
  assert.equal(sent.params.model, "gpt");
});

test("Codex backend construction failure rolls back the outer fork", () => {
  const { service, host, calls } = harness({
    runtimeHint: { engineKind: "codex" },
    binding: {
      innerThreadId: "inner-source",
      durable: true,
      realm: "workspace",
      viewId: "source-view",
      rolloutPath: null,
    },
    ensureBackend: () => { throw new Error("backend unavailable"); },
  });
  assert.throws(() => service.start(request()), /backend unavailable/);
  assert.deepEqual(calls, [["localFork"], ["discard", "fork-1"]]);
});

test("Codex fork completion binds the inner rollout to the stable outer Thread", () => {
  const { service, host, calls, state, local } = harness();
  const forwarded = {
    connection: connection(),
    clientId: "client-fork-1",
    outerThreadId: "source-1",
    forkOuterThreadId: "fork-1",
    method: "thread/fork",
    workspaceFork: true,
    localForkResponse: local,
  };
  assert.equal(service.complete(forwarded, state, {
    id: "backend-fork-1",
    result: { thread: { id: "inner-fork", path: "/rollout/fork.jsonl" } },
  }, host), true);

  assert.deepEqual(calls.map(([kind]) => kind), [
    "binding", "subscribe", "projectThread", "flush", "send",
  ]);
  assert.equal(calls[0][1], "fork-1");
  assert.equal(calls[0][2], "inner-fork");
  assert.equal(calls[4][1].id, "client-fork-1");
  assert.equal(calls[4][1].result.thread.id, "fork-1");
  assert.equal(state.opened.has("fork-1"), true);
  assert.equal(state.openResults.get("fork-1").thread.id, "fork-1");
});

test("Codex fork failure discards the already committed outer fork", () => {
  const { service, host, calls, state, local } = harness();
  const forwarded = {
    connection: connection(),
    clientId: "client-fork-1",
    outerThreadId: "source-1",
    forkOuterThreadId: "fork-1",
    method: "thread/fork",
    workspaceFork: true,
    localForkResponse: local,
  };
  assert.equal(service.complete(forwarded, state, {
    id: "backend-fork-1",
    error: { code: -1, message: "fork failed" },
  }, host), true);
  assert.deepEqual(calls, [
    ["discard", "fork-1"],
    ["send", { id: "client-fork-1", error: { code: -1, message: "fork failed" } }],
  ]);
});
