import assert from "node:assert/strict";
import test from "node:test";

import { CodexRuntimeAdapterTable } from "../src/services/codex-runtime-adapter.ts";
import { ThreadExecutionTable } from "../src/services/thread-execution.js";
import { TransparentProcessBridgeService } from "../src/services/transparent-process-bridge.ts";
import { AppServerProjectionService } from "../src/services/appserver-projection.ts";
import { TransparentRuntimeLocatorService } from "../src/services/transparent-runtime-locator.ts";
import { TransparentBackendIngressService } from "../src/services/transparent-backend-ingress.ts";
import { TransparentBackendBootstrapService } from "../src/services/transparent-backend-bootstrap.ts";
import { TransparentHandoffService } from "../src/services/transparent-handoff.ts";
import { TransparentEngineSwitchService } from "../src/services/transparent-engine-switch.ts";
import { TransparentAccountEventService } from "../src/services/transparent-account-event.ts";
import { TransparentBackendRpcService } from "../src/services/transparent-backend-rpc.ts";
import { TransparentOuterDispatchService } from "../src/services/transparent-outer-dispatch.ts";
import { TransparentBackendMessageService } from "../src/services/transparent-backend-message.ts";
import { TransparentForwardedResponseService } from "../src/services/transparent-forwarded-response.ts";
import { TransparentInternalResponseService } from "../src/services/transparent-internal-response.ts";
import {
  TransparentCodexThreadService,
} from "../src/services/transparent-codex-thread.ts";
import {
  resumeRouteOverride,
  threadRuntimeBackendKey,
} from "../src/services/transparent-thread-routing.ts";
import {
  attachTransparentBackendChannel,
  attachTransparentBackendProjection,
  attachTransparentProtocolMapper,
  attachTransparentRuntimeAccess,
} from "./support/transparent-protocol-mapper.mjs";

function transparentProcessBridge() {
  const service = Object.create(TransparentProcessBridgeService.prototype);
  service.sequence = 0;
  return service;
}

function transparentBackendRpc() {
  return Object.create(TransparentBackendRpcService.prototype);
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

function transparentHandoff() {
  return Object.create(TransparentHandoffService.prototype);
}

function transparentEngineSwitch() {
  return Object.assign(Object.create(TransparentEngineSwitchService.prototype), {
    sequence: 0,
  });
}

function transparentOuterDispatch() {
  return Object.create(TransparentOuterDispatchService.prototype);
}

function transparentBackendMessage() {
  return Object.create(TransparentBackendMessageService.prototype);
}

function transparentForwardedResponse() {
  return Object.create(TransparentForwardedResponseService.prototype);
}

function transparentInternalResponse() {
  return Object.assign(Object.create(TransparentInternalResponseService.prototype), {
    ctx: {
      transparentHandoff: transparentHandoff(),
      transparentBackendOpen: { handle: () => false },
    },
  });
}

test("handoff resume explicitly overrides persisted model provider ownership", () => {
  assert.deepEqual(resumeRouteOverride({
    model: null,
    collaborationMode: { mode: "default", settings: { model: "ep-xodwa4gc" } },
  }, { model: "gpt-5.6-sol", providerId: null }, "hypernode-public-kimi-k3"), {
    model: "ep-xodwa4gc",
    modelProvider: "hypernode-public-kimi-k3",
  });
  assert.deepEqual(resumeRouteOverride({ model: "gpt-5.6-sol" }, {
    model: "ep-xodwa4gc",
    providerId: "hypernode-public-kimi-k3",
  }, null), {
    model: "gpt-5.6-sol",
    modelProvider: "openai",
  });
  assert.deepEqual(resumeRouteOverride({}, {
    model: null,
    providerId: "hypernode-public-kimi-k3",
  }, "hypernode-public-kimi-k3"), {
    modelProvider: "hypernode-public-kimi-k3",
  });
});

test("a new turn retires its old dedicated runtime before resuming the same inner identity", () => {
  const service = Object.create(TransparentCodexThreadService.prototype);
  const outerThreadId = "thread-outer";
  const innerThreadId = "thread-inner";
  const oldConnection = { identity: { id: "user:alice" }, socket: { send: assert.fail } };
  const newConnection = { identity: { id: "user:bob" }, socket: { send: assert.fail } };
  const oldState = {
    backendKey: "user:alice\0localhost\0local",
    isolatedOuterThreadId: outerThreadId,
    opened: new Set([outerThreadId]),
    openResults: new Map([[outerThreadId, {}]]),
    internalControlRequests: new Map(),
  };
  const targetState = {
    backendKey: "user:bob\0localhost\0local",
    ownerUserId: "user:bob",
    realm: "localhost",
    viewId: "main",
    initId: "initialize",
    phase: "ready",
    internalRequests: new Map(),
    internalControlRequests: new Map(),
    forwardedRequests: new Map(),
    abandonedRequestIds: new Set(),
    pendingThreadMessages: new Map(),
    commandProcesses: new Map(),
    hostProcesses: new Map(),
    opening: new Set(),
    opened: new Set(),
    openResults: new Map(),
    threadOwners: new Map(),
    connections: new Set([newConnection]),
  };
  const binding = {
    innerThreadId,
    durable: true,
    realm: "localhost",
    viewId: "main",
    ownerUserId: "user:alice",
    accountIdentity: "chatgpt:a",
    rolloutPath: "/data/users/alice/.codex/sessions/rollout.jsonl",
    backendKey: oldState.backendKey,
  };
  const authority = {
    threadId: outerThreadId,
    epoch: 7,
    requestId: 42,
    connection: newConnection,
  };
  const runtimeAdapter = new CodexRuntimeAdapterTable();
  const sent = [];
  targetState.filesystem = {
    owns: () => false,
    toPhysical: (value) => value,
    toVirtual: (value) => value,
    send: (_processId, message) => sent.push(message),
  };
  targetState.processId = "target-process";
  let committed;
  service.sequence = 0;
  service.bindings = new Map([[outerThreadId, {
    innerThreadId, durable: true, realm: "localhost", viewId: "main",
    rolloutPath: binding.rolloutPath,
  }]]);
  service.runtimeHints = new Map([[outerThreadId, {
    ownerUserId: binding.ownerUserId,
    accountIdentity: binding.accountIdentity,
    backendKey: binding.backendKey,
  }]]);
  service.reverseBindings = new Map([[innerThreadId, outerThreadId]]);
  service.stateForOuter = () => oldState;
  service.filesystemForRealm = () => ({
    owns: () => false,
    toPhysical: (value) => value,
    toVirtual: (value) => value,
    send: (_processId, message) => sent.push(message),
  });
  let ensuredBackend;
  service.sendWhenReady = (_state, message) => sent.push(message);
  service.forwardInternalControlNow = (_state, request) => {
    oldState.unsubscribe = request;
  };
  const lifecycle = [];
  service.retireIsolatedBackend = (state, threadId) => {
    lifecycle.push(["retire", state.backendKey, threadId]);
    return true;
  };
  service.persistBindings = () => {};
  service.projectThread = () => {};
  service.ctx = {
    transparentBackendMessage: transparentBackendMessage(),
    transparentForwardedResponse: transparentForwardedResponse(),
    transparentInternalResponse: transparentInternalResponse(),
    transparentAccountEvent: transparentAccountEvent(),
    transparentEngineSwitch: transparentEngineSwitch(),
    transparentBackendLifecycle: {
      ensure: (input) => {
        ensuredBackend = input;
        return targetState;
      },
    },
    transparentHandoff: transparentHandoff(),
    transparentOuterDispatch: transparentOuterDispatch(),
    transparentBackendBootstrap: transparentBackendBootstrap(),
    transparentBackendIngress: transparentBackendIngress(),
    transparentBackendRpc: transparentBackendRpc(),
    transparentProcessBridge: transparentProcessBridge(),
    codexRuntimeAdapter: runtimeAdapter,
    runtimeWorkspace: {
      enabled: true,
      isWorkspaceFilesystem: (filesystem) => filesystem?.mount === "/workspace",
    },
    threadExecution: {
      table: { get: () => authority },
      abortRequest: assert.fail,
      bindTurn: () => authority,
      bindRuntime: (_threadId, _connection, runtimeId) => ({ ...authority, runtimeId }),
    },
    threadArtifactStore: {
      prepare: (_threadId, _path, _epoch, sourceInnerThreadId, options) => {
        assert.equal(sourceInnerThreadId, innerThreadId);
        assert.deepEqual(options, { reidentify: false, modelProvider: "openai" });
        lifecycle.push(["prepare", sourceInnerThreadId]);
        return {
          threadId: outerThreadId,
          innerThreadId,
          reidentified: false,
          generation: 8,
          path: "/workspace/.hypernode/threads/thread-outer/generation-8.jsonl",
        };
      },
      runtimePath: (path) => `/data/workspace${path.slice("/workspace".length)}`,
      resumeHistory: () => null,
      current: () => null,
      commit: (artifact, accountIdentity, epoch, ownerUserId) => {
        committed = { artifact, accountIdentity, epoch, ownerUserId };
      },
      discard: assert.fail,
    },
    threadManager: {
      find: () => ({ id: outerThreadId, cwd: "/localhost/project" }),
      get: () => ({ id: outerThreadId, cwd: "/localhost/project" }),
      ownerOf: () => "user:alice",
    },
    transparentThreadBinding: {
      bindings: service.bindings,
      runtimeHintFor: (threadId) => service.runtimeHints.get(threadId) ?? null,
      persist: () => {},
    },
    userDirectory: { find: (id) => ({ id, username: id.split(":")[1] }) },
    transparentRuntimeRetirement: {
      retireIsolatedBackend: (state, threadId) => {
        lifecycle.push(["retire", state.backendKey, threadId]);
        return true;
      },
    },
  };
  attachTransparentProtocolMapper(service);
  service.ctx.transparentOuterDispatch.ctx = service.ctx;
  service.ctx.transparentOuterDispatch.sequence = 0;
  service.ctx.transparentRuntimeAccess.stateForOuter = () => oldState;
  service.ctx.transparentRuntimeAccess.filesystemForRealm = () => ({
    owns: () => false,
    toPhysical: (value) => value,
    toVirtual: (value) => value,
    send: (_processId, message) => sent.push(message),
  });
  service.ctx.transparentEngineSwitch.ctx = service.ctx;
  const actorCredential = {
    userId: "user:bob",
    username: "bob",
    accountIdentity: "chatgpt:b",
  };
  const turn = { id: 42, method: "turn/start", params: { threadId: outerThreadId, input: [] } };
  service.ctx.transparentEngineSwitch.begin({
    connection: newConnection,
    outerThreadId,
    message: turn,
    actorCredential,
    backendUserId: "user:alice",
    executionProfile: null,
    reject: assert.fail,
  });
  assert.equal(ensuredBackend.options.isolatedOuterThreadId, outerThreadId);
  assert.equal(
    ensuredBackend.options.backendKey,
    "user:bob\0localhost\0local\0outer:thread-outer",
  );
  assert.deepEqual(lifecycle.slice(0, 2), [
    ["retire", oldState.backendKey, outerThreadId],
    ["prepare", innerThreadId],
  ]);
  assert.equal(sent[0].method, "thread/resume");
  assert.equal(sent[0].params.threadId, innerThreadId);
  assert.equal(sent[0].params.modelProvider, "openai");
  assert.match(sent[0].params.path, /generation-8\.jsonl$/);

  service.onBackendMessage(targetState, {
    id: sent[0].id,
    result: { thread: { id: innerThreadId, path: sent[0].params.path, cwd: "/localhost/project" } },
  });
  assert.equal(service.runtimeHints.get(outerThreadId).ownerUserId, "user:bob");
  assert.equal(service.bindings.get(outerThreadId).innerThreadId, innerThreadId);
  assert.equal(
    service.bindings.get(outerThreadId).rolloutPath,
    "/workspace/.hypernode/threads/thread-outer/generation-8.jsonl",
  );
  assert.equal(committed.accountIdentity, "chatgpt:b");
  assert.equal(committed.ownerUserId, "user:bob");
  assert.equal(lifecycle.filter(([type]) => type === "retire").length, 1);
  assert.equal(sent[1].method, "turn/start");
  assert.equal(targetState.forwardedRequests.values().next().value.authorityEpoch, 7);
});

test("an unmanaged active writer retries handoff with rollout reidentification", () => {
  const service = Object.create(TransparentCodexThreadService.prototype);
  const outerThreadId = "outer";
  const state = {
    initId: "initialize",
    backendKey: "target-runtime",
    isolatedOuterThreadId: outerThreadId,
    internalRequests: new Map(),
    internalControlRequests: new Map(),
    abandonedRequestIds: new Set(),
    pendingThreadMessages: new Map(),
    commandProcesses: new Map(),
    hostProcesses: new Map(),
    opening: new Set([outerThreadId]),
  };
  let discarded = null;
  let retired = null;
  let continued = null;
  let rejected = null;
  const handoff = {
    outerThreadId,
    artifact: {
      innerThreadId: "inner",
      reidentified: false,
      path: "/rollout.jsonl",
      persistent: true,
    },
    binding: { innerThreadId: "inner" },
    reidentify: false,
    reject: (message) => { rejected = message; },
  };
  state.internalRequests.set("resume", { outerThreadId, handoff });
  service.ctx = {
    transparentBackendMessage: transparentBackendMessage(),
    transparentForwardedResponse: transparentForwardedResponse(),
    transparentInternalResponse: transparentInternalResponse(),
    transparentAccountEvent: transparentAccountEvent(),
    transparentEngineSwitch: {
      continue: (candidate) => { continued = candidate; },
    },
    transparentHandoff: transparentHandoff(),
    transparentBackendBootstrap: transparentBackendBootstrap(),
    transparentBackendIngress: transparentBackendIngress(),
    transparentBackendRpc: transparentBackendRpc(),
    transparentProcessBridge: transparentProcessBridge(),
    codexRuntimeAdapter: null,
    threadArtifactStore: { discard: (artifact) => { discarded = artifact; } },
  };
  attachTransparentBackendChannel(service);
  service.retireIsolatedBackend = (candidate, threadId) => {
    retired = [candidate, threadId];
    return true;
  };
  service.ctx.transparentRuntimeRetirement = {
    retireIsolatedBackend: (candidate, threadId) =>
      service.retireIsolatedBackend(candidate, threadId),
  };
  service.onBackendMessage(state, {
    id: "resume",
    error: { code: -32000, message: `thread inner already has an active writer` },
  });

  assert.equal(discarded, handoff.artifact);
  assert.deepEqual(retired, [state, outerThreadId]);
  assert.equal(continued, handoff);
  assert.equal(handoff.reidentify, true);
  assert.equal(handoff.phase, "quiescing");
  assert.equal(rejected, null);
});

test("a paginated rollout handoff imports history and accepts the target account identity", () => {
  const service = Object.create(TransparentCodexThreadService.prototype);
  const outerThreadId = "outer-paginated";
  const sourceInnerThreadId = "inner-source";
  const targetInnerThreadId = "inner-target";
  const history = [{
    type: "message", role: "user", content: [{ type: "input_text", text: "hello" }],
  }];
  const connection = { identity: { id: "user:bob" }, socket: { send: assert.fail } };
  const sent = [];
  const state = {
    backendKey: "target-runtime",
    ownerUserId: "user:bob",
    realm: "localhost",
    viewId: "main",
    initId: "initialize",
    phase: "ready",
    internalRequests: new Map(),
    internalControlRequests: new Map(),
    forwardedRequests: new Map(),
    abandonedRequestIds: new Set(),
    pendingThreadMessages: new Map(),
    commandProcesses: new Map(),
    hostProcesses: new Map(),
    opening: new Set(),
    opened: new Set(),
    openResults: new Map(),
    connections: new Set([connection]),
  };
  const artifact = {
    threadId: outerThreadId,
    innerThreadId: sourceInnerThreadId,
    generation: 3,
    path: "/workspace/.hypernode/threads/outer-paginated/generation-3.jsonl",
  };
  let committed;
  let discarded;
  let forwarded;
  service.sequence = 0;
  service.reverseBindings = new Map([[sourceInnerThreadId, outerThreadId]]);
  service.bindings = new Map([[outerThreadId, {
    innerThreadId: sourceInnerThreadId, realm: "localhost", viewId: "main",
  }]]);
  service.runtimeHints = new Map();
  service.filesystemForRealm = () => ({});
  service.toPhysical = (value) => value;
  service.sendWhenReady = (_state, message) => sent.push(message);
  service.projectThread = () => {};
  service.persistBindings = () => {};
  service.forwardNow = (_state, _connection, _outer, message) => { forwarded = message; };
  service.retireIsolatedBackend = assert.fail;
  service.ctx = {
    transparentBackendMessage: transparentBackendMessage(),
    transparentForwardedResponse: transparentForwardedResponse(),
    transparentInternalResponse: transparentInternalResponse(),
    transparentAccountEvent: transparentAccountEvent(),
    transparentEngineSwitch: transparentEngineSwitch(),
    transparentBackendLifecycle: { ensure: () => state },
    transparentHandoff: transparentHandoff(),
    transparentBackendBootstrap: transparentBackendBootstrap(),
    transparentBackendIngress: transparentBackendIngress(),
    transparentBackendRpc: transparentBackendRpc(),
    transparentProcessBridge: transparentProcessBridge(),
    codexRuntimeAdapter: null,
    runtimeWorkspace: {
      enabled: true,
      isWorkspaceFilesystem: (filesystem) => filesystem?.mount === "/workspace",
    },
    threadArtifactStore: {
      prepare: () => ({ ...artifact }),
      resumeHistory: () => history,
      runtimePath: assert.fail,
      commit: (...args) => { committed = args; },
      discard: (value) => { discarded = value; },
    },
    threadManager: {
      find: () => ({ id: outerThreadId, cwd: "/localhost/project" }),
      get: () => ({ id: outerThreadId, cwd: "/localhost/project" }),
    },
    transparentRuntimeAccess: {
      filesystemForRealm: () => ({}),
      threadBackendKey: () => "target-runtime",
      backendKey: () => "target-runtime-shared",
      isWorkspaceFilesystem: () => false,
      toPhysical: (value) => value,
      filesystem: () => ({ send: (_processId, message) => sent.push(message) }),
    },
    transparentRuntimeRetirement: { retireIsolatedBackend: assert.fail },
    transparentThreadBinding: {
      bindings: service.bindings,
      runtimeHintFor: () => null,
      persist: () => {},
    },
    threadExecution: { table: { get: () => null } },
    userDirectory: { find: () => null },
  };
  service.ctx.transparentEngineSwitch.ctx = service.ctx;
  service.ctx.transparentOuterDispatch = {
    forward: (...args) => service.forwardNow(...args),
  };
  attachTransparentBackendChannel(service);
  const handoff = {
    phase: "quiescing",
    outerThreadId,
    connection,
    message: { id: 9, method: "turn/start", params: { threadId: outerThreadId, input: [] } },
    actorCredential: { userId: "user:bob", accountIdentity: "chatgpt:b" },
    authority: { epoch: 4 },
    binding: {
      innerThreadId: sourceInnerThreadId,
      realm: "localhost",
      viewId: "main",
      rolloutPath: "/workspace/source-rollout.jsonl",
    },
    oldState: null,
    reject: assert.fail,
  };

  service.ctx.transparentEngineSwitch.continue(handoff);
  assert.equal(sent[0].method, "thread/resume");
  assert.deepEqual(sent[0].params.history, history);
  assert.equal("path" in sent[0].params, false);

  const targetPath = "/run/hypernode-users/bob/.codex/sessions/rollout-target.jsonl";
  service.onBackendMessage(state, {
    id: sent[0].id,
    result: { thread: { id: targetInnerThreadId, path: targetPath, cwd: "/localhost/project" } },
  });
  assert.equal(service.bindings.get(outerThreadId).innerThreadId, targetInnerThreadId);
  assert.equal(service.bindings.get(outerThreadId).rolloutPath, targetPath);
  assert.equal(committed[0].innerThreadId, targetInnerThreadId);
  assert.equal(committed[0].path, targetPath);
  assert.equal(committed[1], "chatgpt:b");
  assert.equal(discarded.path, artifact.path);
  assert.equal(forwarded.method, "turn/start");
});

test("thread notifications are buffered while history resume establishes a new binding", () => {
  const service = Object.create(TransparentCodexThreadService.prototype);
  service.ctx = { transparentBackendIngress: transparentBackendIngress() };
  service.reverseBindings = new Map();
  const channel = attachTransparentBackendChannel(service);
  const state = {
    internalRequests: new Map([["resume", { method: "thread/resume" }]]),
    pendingThreadMessages: new Map(),
  };
  const message = { method: "thread/status/changed", params: { threadId: "inner-new" } };
  assert.equal(channel.deferUntilThreadBinding(state, message, {
    hasBinding: (innerThreadId) => service.reverseBindings.has(innerThreadId),
    outerThreadId: (innerThreadId) => service.reverseBindings.get(innerThreadId) ?? null,
    replay: assert.fail,
  }), true);
  assert.deepEqual(state.pendingThreadMessages.get("inner-new"), [message]);
});

test("thread runtime keys isolate outer threads while control runtimes remain pooled", () => {
  assert.equal(
    threadRuntimeBackendKey("user:alice", "workspace", "main", "outer-a"),
    "user:alice\0workspace\0main\0outer:outer-a",
  );
  assert.notEqual(
    threadRuntimeBackendKey("user:alice", "workspace", "main", "outer-a"),
    threadRuntimeBackendKey("user:alice", "workspace", "main", "outer-b"),
  );
});

test("turn-scoped notifications from an older authority epoch are fenced", () => {
  const service = Object.create(TransparentCodexThreadService.prototype);
  service.bindings = new Map([["outer", { innerThreadId: "inner" }]]);
  service.runtimeHints = new Map([["outer", { backendKey: "runtime" }]]);
  service.reverseBindings = new Map([["inner", "outer"]]);
  const table = new ThreadExecutionTable({ createId: () => "execution" });
  const connection = {};
  const credential = { userId: "user:alice", username: "alice", accountIdentity: "chatgpt:a" };
  const old = table.claim("outer", credential, connection, 1).execution;
  table.bindRuntime("outer", connection, "runtime", "inner", old.epoch);
  table.bindTurn("outer", connection, "turn-old", old.epoch);
  table.finish("outer", { epoch: old.epoch, turnId: "turn-old" });
  const current = table.claim("outer", credential, connection, 2).execution;
  table.bindRuntime("outer", connection, "runtime", "inner", current.epoch);
  table.bindTurn("outer", connection, "turn-new", current.epoch);
  service.ctx = {
    transparentBackendIngress: transparentBackendIngress(),
    threadExecution: { table },
  };
  const channel = attachTransparentBackendChannel(service);
  const state = { backendKey: "runtime", turnEpochs: new Map([["turn-old", 1], ["turn-new", 2]]) };
  const host = {
    hasBinding: (innerThreadId) => service.reverseBindings.has(innerThreadId),
    outerThreadId: (innerThreadId) => service.reverseBindings.get(innerThreadId) ?? null,
    replay: assert.fail,
  };
  assert.equal(channel.isStaleAuthorityMessage(state, {
    method: "item/agentMessage/delta",
    params: { threadId: "inner", turnId: "turn-old" },
  }, host), true);
  assert.equal(channel.isStaleAuthorityMessage(state, {
    method: "item/agentMessage/delta",
    params: { threadId: "inner", turnId: "turn-new" },
  }, host), false);
});

test("Codex turn/started promotes only the matching execution epoch to running", () => {
  const service = Object.create(TransparentCodexThreadService.prototype);
  service.bindings = new Map([["outer", { innerThreadId: "inner" }]]);
  service.reverseBindings = new Map([["inner", "outer"]]);
  service.runtimeHints = new Map([["outer", { backendKey: "runtime" }]]);
  const connection = {};
  const calls = [];
  service.ctx = {
    threadExecution: {
      table: {
        get: () => ({ connection, epoch: 7, runtimeId: "runtime" }),
      },
      markNativeStarted: (...args) => calls.push(args),
    },
    threadManager: {
      projectTurn: () => {},
    },
  };
  service.ctx.transparentRuntimeLocator = Object.assign(
    Object.create(TransparentRuntimeLocatorService.prototype),
    { ctx: service.ctx },
  );
  service.ctx.appServerProjection = Object.assign(
    Object.create(AppServerProjectionService.prototype),
    { ctx: service.ctx },
  );
  attachTransparentRuntimeAccess(service);
  const projection = attachTransparentBackendProjection(service);
  const state = { backendKey: "runtime", turnEpochs: new Map() };

  projection.projectBackend({
    method: "turn/started",
    params: { threadId: "outer", turn: { id: "native-turn", status: "inProgress", items: [] } },
  }, state);

  assert.deepEqual(calls, [["outer", connection, "native-turn", 7]]);
  assert.equal(state.turnEpochs.get("native-turn"), 7);
});
