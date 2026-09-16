import assert from "node:assert/strict";
import test from "node:test";
import { TransparentControlRoutingService } from "../src/services/transparent-control-routing.ts";

function createService(overrides = {}) {
  const sent = [];
  const backendMessages = [];
  const connection = {
    identity: { id: "alice" },
    socket: { send: (message) => sent.push(structuredClone(message)) },
  };
  const filesystem = {
    owns: () => true,
    normalize: (path) => path,
    ensureWorkingDirectory: (path) => path,
    send: (_processId, message) => backendMessages.push(structuredClone(message)),
  };
  const state = {
    processId: "runtime",
    phase: "ready",
    backendKey: "alice\0workspace\0main\0control",
    internalControlRequests: new Map(),
    pendingInternalControl: [],
    pendingControl: [],
    forwardedRequests: new Map(),
    commandProcesses: new Map(),
    commandProcessesByConnection: new Map(),
    hostProcesses: new Map(),
    hostProcessesByConnection: new Map(),
  };
  const service = Object.assign(
    Object.create(TransparentControlRoutingService.prototype),
    { sequence: 0 },
  );
  service.ctx = {
    credential: { resolveCodexUser: () => ({ accountIdentity: "account-alice" }) },
    runtimeWorkspace: {
      projectsRoot: () => "/workspace/projects",
      filesystemForCwd: () => filesystem,
      isWorkspaceFilesystem: () => true,
      viewIdForThread: () => "main",
    },
    transparentBackendRegistry: {
      connections: new Map(),
      attach: () => undefined,
    },
    transparentBackendLifecycle: { ensure: () => state },
    transparentBackendRpc: {
      trackForwarded: (candidate, id, request) => candidate.forwardedRequests.set(id, request),
    },
    transparentProcessBridge: {
      prepareCommandRequest: (_candidate, _connection, message) => ({
        message,
        commandProcess: null,
      }),
      prepareHostProcessRequest: (_candidate, _connection, message) => ({
        message,
        hostProcess: null,
      }),
    },
    transparentRuntimeLocator: { stateForOuter: () => null },
    transparentRuntimeAccess: {
      localFilesystem: filesystem,
      defaultFilesystem: () => filesystem,
      filesystem: () => filesystem,
      filesystemForCwd: () => filesystem,
      backendKey: () => "alice\0workspace\0main",
      isWorkspaceFilesystem: () => true,
      toInner: (message) => message,
    },
    ...overrides,
  };
  return { service, connection, state, sent, backendMessages };
}

test("user backend requests fail before runtime creation without an SSH identity", () => {
  const { service, connection } = createService();
  connection.identity = null;
  const outcomes = [];

  service.requestUserBackend(
    connection,
    "account/read",
    {},
    (error, result) => outcomes.push({ error, result }),
  );

  assert.deepEqual(outcomes, [{
    error: {
      code: -32052,
      message: "Codex account binding requires an SSH user identity",
    },
    result: undefined,
  }]);
});

test("internal control requests retain correlation and payload", () => {
  const { service, connection, state, backendMessages } = createService();
  const callback = () => undefined;

  service.requestUserBackend(connection, "account/read", { refresh: true }, callback);

  assert.equal(state.internalControlRequests.size, 1);
  assert.equal(state.internalControlRequests.values().next().value.callback, callback);
  assert.deepEqual(backendMessages, [{
    id: "hypernode:transparent:internal-control:1",
    method: "account/read",
    params: { refresh: true },
  }]);
});

test("control messages queue until their selected runtime is ready", () => {
  const { service, connection, state, backendMessages } = createService();
  state.phase = "initializing";
  const message = {
    id: "model-list",
    method: "model/list",
    params: {},
  };

  service.queueControl(connection, message);

  assert.deepEqual(state.pendingControl, [{ connection, message }]);
  assert.deepEqual(backendMessages, []);
});

test("global Codex controls are pinned to the host-local filesystem", () => {
  const localFilesystem = { mount: "/localhost", enabled: true };
  const workspaceFilesystem = { mount: "/workspace", enabled: true };
  const calls = [];
  const service = Object.create(TransparentControlRoutingService.prototype);
  service.ctx = {
    credential: {
      resolveCodexUser: () => ({ accountIdentity: "account-1" }),
    },
    runtimeWorkspace: {
      projectsRoot: () => "/workspace/@main/projects",
    },
    transparentRuntimeAccess: {
      localFilesystem,
      defaultFilesystem: () => workspaceFilesystem,
      backendKey: (owner, filesystem, view) => `${owner}:${filesystem.mount}:${view}`,
    },
  };
  service.ensureBackend = (...args) => {
    calls.push(args);
    return { phase: "ready" };
  };

  service.ensureCodexControlBackend({ identity: { id: "alice" } }, "alice");

  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], localFilesystem);
  assert.equal(calls[0][3], "main");
  assert.equal(calls[0][4], "/localhost");
  assert.deepEqual(calls[0][5], {
    backendKey: "alice:/localhost:main\0control:codex",
    accountIdentity: "account-1",
    providerId: null,
  });
});

test("a consumer cannot remotely logout a materialized shared Codex credential", () => {
  const previousHostIdentity = globalThis.hostIdentity;
  const { service, connection, sent, backendMessages } = createService({
    credential: {
      resolveCodexUser: () => ({ accountIdentity: "account-shared", username: "alice" }),
    },
  });
  globalThis.hostIdentity = {
    readActiveCodexShare: (username) => username === "alice" ? "shared-one" : "",
  };
  try {
    service.queueControl(connection, { id: "logout-1", method: "account/logout" });
    assert.deepEqual(sent, [{
      id: "logout-1",
      error: {
        code: -32086,
        message: "共享 Codex 槽位不能从使用者会话退出；请切换到自己的账户",
      },
    }]);
    assert.deepEqual(backendMessages, []);
  } finally {
    globalThis.hostIdentity = previousHostIdentity;
  }
});
