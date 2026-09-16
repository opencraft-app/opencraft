import assert from "node:assert/strict";
import test from "node:test";
import { TransparentOuterQueueService } from "../src/services/transparent-outer-queue.ts";

const service = Object.create(TransparentOuterQueueService.prototype);

function connection() {
  return {
    identity: { id: "actor-1", username: "alice" },
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

function backend(overrides = {}) {
  return {
    backendKey: "runtime-next",
    realm: "workspace",
    viewId: "main",
    phase: "ready",
    opened: new Set(),
    openResults: new Map(),
    pendingByOuter: new Map(),
    ...overrides,
  };
}

function harness(overrides = {}) {
  const calls = [];
  const filesystem = { name: "workspace" };
  const state = backend();
  const host = {
    principalId: "principal-1",
    metadataOwner: () => "owner-1",
    bindingFor: () => ({
      innerThreadId: "inner-1",
      durable: true,
      realm: "workspace",
      viewId: "main",
      rolloutPath: "/rollout.jsonl",
    }),
    runtimeHintFor: () => ({
      ownerUserId: "owner-1",
      accountIdentity: "provider:owner-1:kimi",
      engineKind: "codex",
      providerId: "kimi",
      model: "kimi-k3",
      threadSettings: null,
      backendKey: null,
      epoch: 1,
    }),
    threadCwd: () => "/workspace/projects/repo",
    filesystemForRealm: () => filesystem,
    filesystemForCwd: () => filesystem,
    defaultFilesystem: () => filesystem,
    viewIdForThread: () => "main",
    activeExecution: () => null,
    backendFor: () => state,
    attach: (...args) => calls.push(["attach", ...args]),
    backendKey: (...args) => (calls.push(["backendKey", ...args]), "runtime-next"),
    ensureBackend: (input) => (calls.push(["ensure", input]), state),
    forward: (...args) => calls.push(["forward", ...args]),
    sendOpenResult: (...args) => calls.push(["openResult", ...args]),
    open: (...args) => calls.push(["open", ...args]),
    ...overrides,
  };
  service.ctx = {
    principal: { current: () => ({ id: host.principalId }) },
    runtimeWorkspace: { viewIdForThread: host.viewIdForThread },
    threadExecution: { table: { get: host.activeExecution } },
    threadManager: {
      metadataFor: (threadId) => ({ ownerPrincipalId: host.metadataOwner(threadId) }),
      find: (threadId) => {
        const cwd = host.threadCwd(threadId);
        return cwd === null ? null : { cwd };
      },
    },
    transparentBackendChannel: {
      send: (targetConnection, message) =>
        calls.push(["openResult", null, targetConnection, null, message.result]),
    },
    transparentBackendLifecycle: { ensure: host.ensureBackend },
    transparentBackendRegistry: {
      backends: { get: host.backendFor },
      attach: host.attach,
    },
    transparentOuterDispatch: {
      forward: host.forward,
      open: host.open,
    },
    transparentRuntimeAccess: {
      filesystemForRealm: host.filesystemForRealm,
      filesystemForCwd: host.filesystemForCwd,
      defaultFilesystem: host.defaultFilesystem,
      threadBackendKey: host.backendKey,
      backendKey: () => "runtime-default",
      isWorkspaceFilesystem: () => true,
      toOuter: (message) => message,
    },
    transparentThreadBinding: {
      bindings: { get: host.bindingFor },
      runtimeHintFor: host.runtimeHintFor,
    },
  };
  return { calls, filesystem, host, state };
}

function request(method, options = {}) {
  const targetConnection = connection();
  return {
    connection: targetConnection,
    outerThreadId: "outer-1",
    action: {
      connection: targetConnection,
      message: { id: "request-1", method, params: {} },
      ...options,
    },
  };
}

test("turn/steer remains pinned to the Runtime executing the active Turn", () => {
  const active = backend({ backendKey: "runtime-active", opened: new Set(["outer-1"]) });
  const profile = {
    engineKind: "codex",
    providerId: "kimi",
    model: "kimi-k3",
    credentialIdentity: "provider:owner-1:kimi",
    actorUserId: "actor-1",
    turnConfig: {},
    fingerprint: "profile-1",
  };
  const { host, calls } = harness({
    activeExecution: () => ({ runtimeId: "runtime-active", executionProfile: profile }),
    backendFor: (key) => (calls.push(["lookup", key]), active),
  });

  service.enqueue(request("turn/steer"));

  assert.equal(calls.find(([kind]) => kind === "lookup")[1], "runtime-active");
  assert.equal(calls.some(([kind]) => kind === "backendKey"), false);
  assert.equal(calls.some(([kind]) => kind === "ensure"), false);
  assert.equal(calls.at(-1)[0], "forward");
});

test("a missing Runtime is created from the immutable execution profile", () => {
  const profile = {
    engineKind: "codex",
    providerId: "private-provider",
    model: "private-model",
    credentialIdentity: "credential-1",
    actorUserId: "actor-1",
    turnConfig: {},
    fingerprint: "profile-1",
  };
  const { host, calls } = harness({
    activeExecution: () => ({ runtimeId: "runtime-old", executionProfile: profile }),
    backendFor: () => null,
  });

  service.enqueue(request("thread/read"));

  const ensured = calls.find(([kind]) => kind === "ensure")[1];
  assert.equal(ensured.ownerUserId, "owner-1");
  assert.equal(ensured.options.accountIdentity, "credential-1");
  assert.equal(ensured.options.providerId, "private-provider");
  assert.equal(ensured.options.executionProfile, profile);
  assert.equal(calls.some(([kind]) => kind === "open"), true);
});

test("a prewarmed new Thread reconstructs its authenticated profile from the Runtime hint", () => {
  const hinted = {
    ownerUserId: "owner-1",
    accountIdentity: "chatgpt:shared-account",
    engineKind: "codex",
    providerId: null,
    model: "gpt-5.6-sol",
  };
  const prewarmed = backend({ backendKey: "runtime-prewarmed", phase: "initializing" });
  const { calls } = harness({
    bindingFor: () => null,
    runtimeHintFor: () => hinted,
    backendKey: (...args) => {
      calls.push(["backendKey", ...args]);
      assert.equal(args[4].credentialIdentity, "chatgpt:shared-account");
      return "runtime-prewarmed";
    },
    backendFor: (key) => key === "runtime-prewarmed" ? prewarmed : null,
  });

  service.enqueue(request("thread/start", { respondFromOpen: true }));

  assert.equal(calls.some(([kind]) => kind === "ensure"), false);
  assert.equal(calls.some(([kind]) => kind === "attach"), true);
  assert.equal(prewarmed.pendingByOuter.get("outer-1")?.length, 1);
});

test("a durable resume is always forwarded instead of replaying the cached open response", () => {
  const state = backend({
    opened: new Set(["outer-1"]),
    openResults: new Map([["outer-1", { thread: { id: "outer-1" } }]]),
  });
  const { host, calls } = harness({ backendFor: () => state });

  service.enqueue(request("thread/resume", { respondFromOpen: true }));

  assert.equal(calls.some(([kind]) => kind === "openResult"), false);
  assert.equal(calls.at(-1)[0], "forward");
});

test("an opened non-durable Thread may answer from its cached open projection", () => {
  const cached = { thread: { id: "outer-1" } };
  const state = backend({
    opened: new Set(["outer-1"]),
    openResults: new Map([["outer-1", cached]]),
  });
  const { host, calls } = harness({
    bindingFor: () => ({
      innerThreadId: "inner-1",
      durable: false,
      realm: "workspace",
      viewId: "main",
      rolloutPath: null,
    }),
    backendFor: () => state,
  });

  service.enqueue(request("thread/read", { respondFromOpen: true }));

  const openResult = calls.find(([kind]) => kind === "openResult");
  assert.equal(openResult[4], cached);
  assert.equal(calls.some(([kind]) => kind === "forward"), false);
});

test("an unopened Thread queues once and starts its handshake when the Runtime is ready", () => {
  const { host, calls, state } = harness();
  const queued = request("thread/resume");

  service.enqueue(queued);

  assert.deepEqual(state.pendingByOuter.get("outer-1"), [queued.action]);
  assert.equal(calls.at(-1)[0], "open");
  assert.equal(queued.connection.activeThreadId, "outer-1");
});

test("a failed Runtime is replaced under the same deterministic backend key", () => {
  const failed = backend({ phase: "failed" });
  const replacement = backend({ phase: "initializing" });
  const { host, calls } = harness({
    backendFor: () => failed,
    ensureBackend: (input) => (calls.push(["ensure", input]), replacement),
  });

  service.enqueue(request("thread/read"));

  assert.equal(calls.some(([kind]) => kind === "attach"), false);
  assert.equal(calls.find(([kind]) => kind === "ensure")[1].options.backendKey, "runtime-next");
  assert.equal(replacement.pendingByOuter.get("outer-1")?.length, 1);
  assert.equal(calls.some(([kind]) => kind === "open"), false);
});
