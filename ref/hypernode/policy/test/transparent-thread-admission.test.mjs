import assert from "node:assert/strict";
import test from "node:test";
import { TransparentThreadAdmissionService } from
  "../src/services/transparent-thread-admission.ts";

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

function request(params = {}) {
  return {
    connection: connection(),
    message: { id: "start-1", method: "thread/start", params },
  };
}

function harness(overrides = {}) {
  const calls = [];
  const filesystem = { enabled: true, mount: "/workspace", name: "workspace-v2" };
  const credential = {
    userId: "user-1",
    accountIdentity: "model-provider:user-1:kimi",
    providerId: "kimi",
  };
  const thread = {
    id: "thread-1",
    cwd: "/workspace/projects/repo",
    status: { type: "idle" },
  };
  const route = {
    kind: "provider",
    engineKind: "dsh",
    provider: { providerId: "kimi", model: "kimi-k3" },
  };
  const ctx = {
    appServer: { defer: (_connection, _delayMs, action) => action() },
    credential: {
      resolve: () => credential,
      resolveCodexUser: () => credential,
      resolveProvider: () => credential,
      ...overrides.credential,
    },
    deviceIdentity: {
      read: () => ({
        installationId: "installation-user-1",
        synthetic: true,
        persistedAt: "/home/alice/.codex/installation_id",
        userId: "user-1",
        username: "alice",
        bindingState: "unbound",
        loginMethods: ["chatgptDeviceCode"],
      }),
    },
    executionEngine: {
      supports: (profile) => profile.engineKind === "dsh",
      prepareThread: (input) => calls.push(["prewarm", input]),
      ...overrides.executionEngine,
    },
    modelGateway: {
      selectModelForConnection: () => route,
      ...overrides.modelGateway,
    },
    principal: { current: () => ({ id: "root" }) },
    runtimeWorkspace: {
      enabled: true,
      prepareStartParams: (params) => ({
        ...params,
        cwd: params.cwd ?? "/workspace/projects/repo",
        sandbox: { type: "dangerFullAccess" },
      }),
      bindMain: (...args) => calls.push(["bindMain", ...args]),
      viewIdForThread: () => "view-thread-1",
      ...overrides.runtimeWorkspace,
    },
    threadManager: {
      create: (params, _threadOverrides, metadata) => (
        calls.push(["create", params, metadata]),
        { ...thread, cwd: params.cwd }
      ),
    },
    threadProjectBinding: {
      capture: (...args) => calls.push(["captureProject", ...args]),
    },
    transparentBackendChannel: {
      subscribe: (...args) => calls.push(["subscribe", ...args]),
      send: (_connection, message) => calls.push(["send", message]),
    },
    transparentBackendLifecycle: {
      ensure: (input) => {
        calls.push(["startCodex", input]);
        return {
          realm: "workspace",
          viewId: input.viewId,
          phase: "ready",
          ephemeralOuterIds: new Map(),
        };
      },
    },
    transparentOuterQueue: {
      enqueue: (input) => calls.push(["outerQueue", input]),
    },
    transparentRuntimeAccess: {
      filesystemForCwd: () => filesystem,
      defaultFilesystem: () => filesystem,
      isWorkspaceFilesystem: (candidate) => candidate === filesystem,
      backendKey: () => "user-1\0workspace\0view-thread-1",
      threadBackendKey: () => "thread-runtime",
      ...overrides.transparentRuntimeAccess,
    },
    transparentThreadBinding: {
      setRuntimeHint: (...args) => calls.push(["runtimeHint", ...args]),
    },
  };
  const admission = Object.create(TransparentThreadAdmissionService.prototype);
  admission.ctx = ctx;
  return { admission, calls, filesystem, credential };
}

test("DSH admission commits the outer Thread before prewarming its runtime", () => {
  const { admission, calls } = harness();
  const input = request({
    model: "kimi-k3",
    runtimeWorkspaceRoots: ["/workspace/projects/repo"],
  });

  assert.equal(admission.handle(input), "handled");
  assert.equal(input.connection.activeThreadId, "thread-1");
  assert.deepEqual(calls.map(([kind]) => kind), [
    "create",
    "bindMain",
    "captureProject",
    "runtimeHint",
    "subscribe",
    "send",
    "send",
    "prewarm",
  ]);
  assert.equal(calls[0][1].cwd, "/workspace/projects/repo");
  assert.deepEqual(calls[0][1].runtimeWorkspaceRoots, ["/workspace/projects/repo"]);
  assert.equal(calls[0][2].ownerPrincipalId, "user-1");
  assert.equal(calls[3][2].engineKind, "dsh");
  assert.equal(calls[5][1].result.thread.id, "thread-1");
  assert.equal(calls[6][1].method, "thread/started");
  assert.equal(calls[7][1].threadId, "thread-1");
});

test("Codex admission uses the same stable Thread and delegates runtime creation", () => {
  const { admission, calls } = harness({
    modelGateway: {
      selectModelForConnection: () => ({ kind: "codex", engineKind: "codex" }),
    },
    executionEngine: { supports: () => false },
  });

  assert.equal(admission.handle(request({ cwd: "/workspace/projects/repo" })), "handled");
  assert.deepEqual(calls.map(([kind]) => kind), [
    "create",
    "bindMain",
    "captureProject",
    "runtimeHint",
    "subscribe",
    "startCodex",
    "outerQueue",
  ]);
  assert.equal(calls[3][2].accountIdentity, "model-provider:user-1:kimi");
  assert.equal(calls[3][2].engineKind, "codex");
  assert.equal(calls[5][1].options.isolatedOuterThreadId, "thread-1");
  assert.equal(calls[5][1].options.executionProfile.engineKind, "codex");
  assert.equal(calls[6][1].outerThreadId, "thread-1");
});

test("an unroutable cwd remains available to another owner without Workspace v2", () => {
  const { admission, calls } = harness({
    runtimeWorkspace: { enabled: false },
    transparentRuntimeAccess: { filesystemForCwd: () => null },
  });
  assert.equal(admission.handle(request({ cwd: "/outside" })), "pass");
  assert.deepEqual(calls, []);
});

test("Workspace v2 captures a Desktop host cwd instead of creating an unbound task", () => {
  const { admission, calls, filesystem } = harness({
    runtimeWorkspace: {
      projectsRoot: () => "/workspace/projects",
      prepareStartParams: (params) => ({ ...params, sandbox: { type: "dangerFullAccess" } }),
    },
    transparentRuntimeAccess: {
      filesystemForCwd: () => null,
      defaultFilesystem: () => filesystem,
    },
  });
  assert.equal(admission.handle(request({ cwd: "/vela" })), "handled");
  assert.equal(calls[0][0], "create");
  assert.equal(calls[0][1].cwd, "/workspace/projects");
  assert.equal(calls[0][2].kind, "transparentCodex");
});

test("model routing failure is returned before a Thread is created", () => {
  const { admission, calls } = harness({
    modelGateway: {
      selectModelForConnection: () => { throw new Error("unknown model"); },
    },
  });
  assert.equal(admission.handle(request()), "handled");
  assert.deepEqual(calls, [["send", {
    id: "start-1",
    error: { code: -32052, message: "unknown model" },
  }]]);
});

test("Codex admission rejects a missing credential before creating a Thread", () => {
  const { admission, calls } = harness({
    credential: { resolveCodexUser: () => null },
    modelGateway: {
      selectModelForConnection: () => ({ kind: "codex", engineKind: "codex" }),
      activeForUser: () => null,
    },
  });
  assert.equal(admission.handle(request()), "handled");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "send");
  assert.equal(calls[0][1].id, "start-1");
  assert.equal(calls[0][1].error.code, -32051);
  assert.equal(calls.some(([kind]) => kind === "create"), false);
});
