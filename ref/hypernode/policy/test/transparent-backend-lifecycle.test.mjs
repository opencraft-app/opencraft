import assert from "node:assert/strict";
import test from "node:test";

import { TransparentBackendLifecycleService } from "../src/services/transparent-backend-lifecycle.ts";
import { TransparentBackendRegistryService } from "../src/services/transparent-backend-registry.ts";

function createHarness({
  failSpawn = false,
  failTerminate = false,
  supportsPersistentRuntimeFencing = true,
} = {}) {
  const registry = Object.create(TransparentBackendRegistryService.prototype);
  registry.backends = new Map();
  registry.connections = new Map();
  const lifecycle = Object.create(TransparentBackendLifecycleService.prototype);
  lifecycle.sequence = 0;
  const sent = [];
  const spawned = [];
  const killed = [];
  const retired = [];
  const filesystem = {
    supportsPersistentRuntimeFencing,
    spawnAppServer: (...args) => spawned.push(["shared", ...args]),
    spawnThreadRuntime: (...args) => {
      if (failSpawn) throw new Error("spawn failed");
      spawned.push(["thread", ...args]);
    },
    send: (processId, message) => sent.push({ processId, message: structuredClone(message) }),
    kill: (processId) => killed.push(processId),
    terminateThreadRuntime: (...args) => {
      retired.push(args);
      if (failTerminate) throw new Error("terminate failed");
    },
  };
  const registered = new Map();
  const cleared = [];
  const abortedRuntimes = [];
  const projectedFailures = [];
  const abortedForwarded = [];
  const broadcasts = [];
  lifecycle.ctx = {
    credential: {
      resolveUser: () => ({ accountIdentity: "resident", providerId: "openai" }),
    },
    modelGateway: { ensureRuntimeProvider: () => {} },
    runtimeRegistry: {
      register: (runtime) => registered.set(runtime.runtimeId, structuredClone(runtime)),
      unregister: (runtimeId) => registered.delete(runtimeId),
    },
    runtimeWorkspace: { projectsRoot: (viewId) => `/workspace/${viewId}/projects` },
    threadExecution: {
      abortRuntime: (runtimeId) => {
        abortedRuntimes.push(runtimeId);
        return [{ threadId: "thread-1", turnId: "turn-1" }];
      },
      abortRequest: (...args) => abortedForwarded.push(args),
    },
    threadManager: {
      find: () => ({ turns: [{ id: "turn-1", items: [] }] }),
      projectTurn: (threadId, turn, phase) => projectedFailures.push({ threadId, turn, phase }),
    },
    transparentBackendChannel: {
      broadcast: (_state, message) => broadcasts.push(structuredClone(message)),
    },
    transparentBackendRegistry: registry,
    transparentRuntimeAccess: { filesystem: (state) => state.filesystem },
    transparentRuntimeRecovery: { clearFailure: (threadId) => cleared.push(threadId) },
    userDirectory: { find: (ownerUserId) => ({ id: ownerUserId }) },
  };
  const connection = {
    clientInfo: { name: "Desktop" },
    initializeParams: { capabilities: { experimentalApi: false } },
  };
  return {
    lifecycle,
    registry,
    filesystem,
    connection,
    sent,
    spawned,
    killed,
    retired,
    registered,
    cleared,
    abortedRuntimes,
    projectedFailures,
    abortedForwarded,
    broadcasts,
  };
}

function ensureInput(harness) {
  return {
    connection: harness.connection,
    ownerUserId: "alice",
    filesystem: harness.filesystem,
    viewId: "thread-1",
    initialCwd: null,
    defaultBackendKey: "alice-thread-1",
    workspaceRealm: true,
    options: {
      isolatedOuterThreadId: "thread-1",
      accountIdentity: "selected-account",
      providerId: "provider-a",
      executionProfile: null,
    },
  };
}

test("backend bootstrap registers one isolated runtime and reuses it idempotently", () => {
  const harness = createHarness();
  const state = harness.lifecycle.ensure(ensureInput(harness));

  assert.equal(state.accountIdentity, "selected-account");
  assert.equal(state.providerId, "provider-a");
  assert.equal(state.phase, "initializing");
  assert.equal(harness.spawned.length, 1);
  assert.equal(harness.registered.get("thread-1").processId, state.processId);
  assert.deepEqual(harness.cleared, ["thread-1"]);
  assert.equal(harness.sent[0].message.method, "initialize");
  assert.equal(harness.sent[0].message.params.capabilities.experimentalApi, true);

  const reused = harness.lifecycle.ensure(ensureInput(harness));
  assert.equal(reused, state);
  assert.equal(harness.spawned.length, 1, "an existing Runtime must not be spawned twice");
});

test("initialize completion drains runtime work exactly once", () => {
  const harness = createHarness();
  const state = harness.lifecycle.ensure(ensureInput(harness));
  state.pendingBackendMessages.push({ method: "account/read", params: {} });
  state.pendingControl.push({ connection: harness.connection, message: { id: 1, method: "model/list" } });
  state.pendingInternalControl.push({ callback: () => {} });
  state.pendingByOuter.set("thread-1", [{}]);

  const work = harness.lifecycle.completeInitialization(state);
  assert.equal(state.phase, "ready");
  assert.equal(harness.sent.at(-1).message.method, "initialized");
  assert.equal(work.backendMessages.length, 1);
  assert.equal(work.controls.length, 1);
  assert.equal(work.internalControls.length, 1);
  assert.deepEqual(work.outerThreadIds, ["thread-1"]);
  assert.equal(state.pendingBackendMessages.length, 0);
  assert.equal(state.pendingControl.length, 0);
  assert.equal(state.pendingInternalControl.length, 0);
  assert.equal(harness.lifecycle.completeInitialization(state), null);
});

test("failed isolated bootstrap leaves neither a process nor a runtime registry entry", () => {
  const harness = createHarness({ failSpawn: true });
  assert.throws(
    () => harness.lifecycle.ensure(ensureInput(harness)),
    /spawn failed/,
  );
  assert.equal(harness.registry.backends.size, 0);
  assert.equal(harness.registered.size, 0);
  assert.equal(harness.killed.length, 1);
});

test("runtime failure converges every outstanding request and execution exactly once", () => {
  const harness = createHarness();
  const state = harness.lifecycle.ensure(ensureInput(harness));
  const socketMessages = [];
  harness.connection.socket = { send: (message) => socketMessages.push(message) };
  state.stderr.push("first", "last");
  state.pendingControl.push({
    connection: harness.connection,
    message: { id: "pending-control", method: "model/list" },
  });
  const internalErrors = [];
  state.pendingInternalControl.push({ callback: (error) => internalErrors.push(error) });
  state.internalControlRequests.set("internal", {
    callback: (error) => internalErrors.push(error),
  });
  state.pendingBackendMessages.push({ method: "account/read" });
  state.pendingThreadMessages.set("thread-1", [{ method: "thread/name/updated" }]);
  state.pendingByOuter.set("thread-1", [{
    connection: harness.connection,
    message: { id: "pending-turn", method: "turn/start" },
  }]);
  const forwarded = {
    connection: harness.connection,
    clientId: "forwarded-turn",
    outerThreadId: "thread-1",
    method: "turn/start",
  };
  state.forwardedRequests.set("backend-request", forwarded);
  state.commandProcesses.set("command", {});
  state.commandProcessesByConnection.set(harness.connection, new Map([["command", {}]]));
  state.hostProcesses.set("host", {});
  state.hostProcessesByConnection.set(harness.connection, new Map([["host", {}]]));
  state.abandonedRequestIds.add("request");

  assert.equal(harness.lifecycle.fail(state, "backend closed"), true);
  assert.equal(state.phase, "failed");
  assert.deepEqual(harness.killed, [state.processId]);
  assert.deepEqual(harness.abortedRuntimes, [state.backendKey]);
  assert.equal(harness.projectedFailures.length, 1);
  assert.match(harness.projectedFailures[0].turn.error.message, /backend closed: first \| last/);
  assert.deepEqual(harness.abortedForwarded, [
    ["thread-1", harness.connection, "pending-turn"],
    ["thread-1", harness.connection, "forwarded-turn"],
  ]);
  assert.deepEqual(harness.broadcasts.map((message) => message.method), [
    "turn/completed",
    "thread/status/changed",
  ]);
  assert.equal(internalErrors.length, 2);
  assert.ok(internalErrors.every((error) => error.code === -32050));
  assert.deepEqual(socketMessages.map((message) => message.id), [
    "pending-control",
    "pending-turn",
    "forwarded-turn",
  ]);
  assert.equal(state.pendingControl.length, 0);
  assert.equal(state.pendingInternalControl.length, 0);
  assert.equal(state.internalControlRequests.size, 0);
  assert.equal(state.pendingBackendMessages.length, 0);
  assert.equal(state.pendingThreadMessages.size, 0);
  assert.equal(state.pendingByOuter.size, 0);
  assert.equal(state.forwardedRequests.size, 0);
  assert.equal(state.commandProcesses.size, 0);
  assert.equal(state.commandProcessesByConnection.size, 0);
  assert.equal(state.hostProcesses.size, 0);
  assert.equal(state.hostProcessesByConnection.size, 0);
  assert.equal(state.abandonedRequestIds.size, 0);

  assert.equal(harness.lifecycle.fail(state, "duplicate"), false);
  assert.equal(socketMessages.length, 3);
  assert.equal(harness.projectedFailures.length, 1);
});

test("isolated retirement terminates the runtime and unregisters it once", () => {
  const harness = createHarness();
  const state = harness.lifecycle.ensure(ensureInput(harness));

  assert.equal(
    harness.lifecycle.retireIsolated(state, "thread-1"),
    true,
  );
  assert.equal(state.phase, "closed");
  assert.deepEqual(harness.retired, [[state.processId, "thread-1", "thread-1", 5_000]]);
  assert.equal(harness.registered.has("thread-1"), false);
  assert.equal(harness.registry.backends.size, 0);
  assert.equal(
    harness.lifecycle.retireIsolated(state, "thread-1"),
    false,
  );
});

test("strict isolated retirement preserves and reports a termination failure", () => {
  const harness = createHarness({ failTerminate: true });
  const state = harness.lifecycle.ensure(ensureInput(harness));

  assert.throws(
    () => harness.lifecycle.retireIsolated(state, "thread-1", true),
    /terminate failed/,
  );
  assert.equal(state.phase, "closed");
  assert.deepEqual(harness.killed, [state.processId]);
  assert.equal(harness.registered.has("thread-1"), true);
  assert.equal(harness.registry.backends.size, 0);
});

test("non-persistent isolated retirement kills the host process without legacy fencing", () => {
  const harness = createHarness({ supportsPersistentRuntimeFencing: false });
  const state = harness.lifecycle.ensure(ensureInput(harness));

  assert.equal(harness.lifecycle.retireIsolated(state, "thread-1", true), true);
  assert.deepEqual(harness.retired, []);
  assert.deepEqual(harness.killed, [state.processId]);
  assert.equal(harness.registered.has("thread-1"), false);
  assert.equal(harness.registry.backends.size, 0);
});

test("process close is idempotent and unregisters only a confirmed termination", () => {
  const harness = createHarness();
  const state = harness.lifecycle.ensure(ensureInput(harness));

  assert.equal(harness.lifecycle.closeProcess(state, "thread-1"), true);
  assert.equal(state.phase, "closed");
  assert.deepEqual(harness.killed, [state.processId]);
  assert.equal(harness.registered.has("thread-1"), false);
  assert.equal(harness.registry.backends.size, 0);
  assert.equal(harness.lifecycle.closeProcess(state, "thread-1"), false);
  assert.deepEqual(harness.killed, [state.processId]);
});
