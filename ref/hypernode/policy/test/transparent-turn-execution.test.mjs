import assert from "node:assert/strict";
import test from "node:test";
import { TransparentTurnExecutionService } from
  "../src/services/transparent-turn-execution.ts";

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

function request(method = "turn/start", params = {}) {
  return {
    connection: connection(),
    threadId: "thread-1",
    message: { id: `${method}-1`, method, params: { threadId: "thread-1", ...params } },
  };
}

function harness(options = {}) {
  const calls = [];
  const credential = {
    userId: "user-1",
    username: "alice",
    accountIdentity: "model-provider:user-1:kimi",
    providerId: "kimi",
  };
  const route = options.route ?? {
    kind: "provider",
    engineKind: "dsh",
    provider: { providerId: "kimi", model: "kimi-k3", displayName: "Kimi K3" },
  };
  const ctx = {
    appServer: {
      broadcastNotification: (...args) => calls.push(["broadcast", ...args]),
    },
    credential: {
      resolveProvider: () => options.providerCredential === undefined
        ? credential
        : options.providerCredential,
      resolveCodexUser: () => options.codexCredential ?? credential,
      resolve: () => options.defaultCredential ?? credential,
    },
    deviceIdentity: { read: () => credential },
    dshNativeSessionStore: {
      has: () => options.inferredEngineKind === "dsh",
    },
    executionEngine: {
      supports: (profile) => options.supportsDsh ?? profile.engineKind === "dsh",
      hasThread: () => options.hasDshThread ?? false,
      startTurn: (input) => calls.push(["startDsh", input]),
      steer: (input) => calls.push(["steerDsh", input]),
      interrupt: (input) => calls.push(["interruptDsh", input]),
    },
    modelGateway: {
      selectModelForTurn: () => route,
      activeForUser: () => options.activeProvider ?? null,
    },
    runtimeWorkspace: { viewIdForThread: () => "main" },
    threadArtifactStore: {
      current: () => options.inferredEngineKind === "codex" ? { generation: 1 } : null,
    },
    threadEngineBinding: {
      claim: (...args) => {
        calls.push(["claimEngine", ...args]);
        if (options.claimEngineError) throw options.claimEngineError;
      },
    },
    threadExecution: {
      table: { get: () => options.executionRecord ?? null },
      claimRequest: (...args) => {
        calls.push(["claimExecution", ...args]);
        return options.claimExecution === false ? null : { connection: args[2], epoch: 1 };
      },
      abortRequest: (...args) => calls.push(["abort", ...args]),
      complete: (...args) => calls.push(["complete", ...args]),
    },
    threadManager: {
      get: () => ({ id: "thread-1", cwd: "/workspace/projects/demo", status: "idle" }),
      find: () => ({
        id: "thread-1",
        cwd: "/workspace/projects/demo",
        status: "idle",
        turns: options.hasProjectedInProgressTurn
          ? [{ id: "turn-1", status: "inProgress" }]
          : [],
      }),
      ownerOf: () => options.ownerUserId ?? null,
      touch: (...args) => calls.push(["touch", ...args]),
      reconcileInterruptedRuntime: (...args) => {
        calls.push(["reconcile", ...args]);
        return options.interruptedTurns ?? [];
      },
    },
    transparentBackendChannel: {
      send: (_connection, message) => calls.push(["send", message]),
      subscribe: (...args) => calls.push(["subscribe", ...args]),
    },
    transparentRuntimeAccess: {
      filesystemForCwd: () => ({ id: "workspace-filesystem" }),
      defaultFilesystem: () => ({ id: "default-filesystem" }),
      stateForOuter: () => options.runtimeState ?? null,
    },
    transparentRuntimeRetirement: {
      retireIsolatedBackend: (...args) => calls.push(["retire", ...args]),
    },
    transparentEngineSwitch: {
      begin: (...args) => calls.push(["switch", ...args]),
    },
    transparentThreadBinding: {
      bindings: new Map(options.binding ? [["thread-1", options.binding]] : []),
      runtimeHintFor: () => options.runtimeHint ?? null,
      setRuntimeHint: (...args) => calls.push(["setDshHint", ...args]),
    },
    userDirectory: {
      find: (userId) => ({ id: userId, username: userId }),
    },
  };
  const execution = Object.create(TransparentTurnExecutionService.prototype);
  execution.ctx = ctx;
  return { execution, calls, credential };
}

test("DSH start claims one immutable execution profile before dispatch", () => {
  const { execution, calls } = harness();
  const input = request("turn/start", {
    model: "client-alias",
    input: [{ type: "text", text: "hello" }],
    effort: "high",
  });

  assert.equal(execution.handle(input), "handled");
  assert.deepEqual(calls.map(([kind]) => kind), [
    "claimEngine",
    "claimExecution",
    "setDshHint",
    "startDsh",
  ]);
  assert.equal(calls[0][2], "dsh");
  const profile = calls[1][5];
  assert.equal(profile.engineKind, "dsh");
  assert.equal(profile.providerId, "kimi");
  assert.equal(profile.model, "kimi-k3");
  assert.equal(profile.actorUserId, "user-1");
  assert.equal(profile.turnConfig.effort, "high");
  assert.equal(Object.isFrozen(profile), true);
  assert.equal(calls[3][1].message.params.model, "kimi-k3");
  assert.equal(calls[3][1].suppressResponse, false);
});

test("queued DSH start suppresses only the duplicate RPC response", () => {
  const { execution, calls } = harness();
  const input = request("turn/start", {
    input: [{ type: "text", text: "queued hello" }],
    clientUserMessageId: "queued-message-1",
  });
  input.suppressResponse = true;

  assert.equal(execution.handle(input), "handled");
  const start = calls.find(([kind]) => kind === "startDsh");
  assert.equal(start[1].suppressResponse, true);
});

test("Codex start remains queued only after authority is claimed", () => {
  const { execution, calls } = harness({
    route: { kind: "codex", engineKind: "codex" },
    supportsDsh: false,
  });
  const input = request("turn/start", { input: [{ type: "text", text: "hello" }] });

  assert.equal(execution.handle(input), "queueCodex");
  assert.deepEqual(calls.map(([kind]) => kind), ["claimEngine", "claimExecution", "touch"]);
  assert.equal(calls[0][2], "codex");
});

test("missing provider credential fails deterministically without claiming an engine", () => {
  const { execution, calls } = harness({
    providerCredential: null,
    activeProvider: { providerId: "kimi", displayName: "Kimi K3" },
  });
  const input = request();

  assert.equal(execution.handle(input), "handled");
  assert.equal(calls[0][0], "send");
  assert.equal(calls[0][1].error.code, -32051);
  assert.match(calls[0][1].error.message, /Kimi K3/);
  assert.equal(calls[1][0], "abort");
  assert.equal(calls.some(([kind]) => kind === "claimEngine"), false);
});

test("engine binding conflict is returned with its protocol code and data", () => {
  const conflict = Object.assign(new Error("explicit migration required"), {
    code: -32084,
    data: { kind: "engineMigrationRequired" },
  });
  const { execution, calls } = harness({ claimEngineError: conflict });

  assert.equal(execution.handle(request()), "handled");
  assert.deepEqual(calls[1], ["send", {
    id: "turn/start-1",
    error: {
      code: -32084,
      message: "explicit migration required",
      data: { kind: "engineMigrationRequired" },
    },
  }]);
});

test("DSH steer is dispatched only for the matching active Turn", () => {
  const { execution, calls } = harness({
    executionRecord: {
      turnId: "turn-1",
      executionProfile: { engineKind: "dsh" },
    },
  });

  assert.equal(execution.handle(request("turn/steer", { turnId: "turn-1" })), "handled");
  assert.deepEqual(calls.map(([kind]) => kind), ["subscribe", "steerDsh"]);
});

test("mismatched steer never reaches either runtime", () => {
  const { execution, calls } = harness({
    executionRecord: {
      turnId: "turn-1",
      executionProfile: { engineKind: "dsh" },
    },
  });

  assert.equal(execution.handle(request("turn/steer", { turnId: "turn-2" })), "handled");
  assert.equal(calls[0][0], "send");
  assert.equal(calls[0][1].error.code, -32068);
  assert.equal(calls.some(([kind]) => kind === "steerDsh"), false);
});

test("orphan interrupt converges locally while a live Codex Turn remains queued", () => {
  const orphan = harness();
  assert.equal(orphan.execution.handle(request("turn/interrupt")), "handled");
  assert.deepEqual(orphan.calls.map(([kind]) => kind), ["reconcile", "complete", "broadcast"]);

  const live = harness({
    executionRecord: { executionProfile: { engineKind: "codex" } },
    hasProjectedInProgressTurn: true,
    runtimeState: { phase: "ready" },
  });
  assert.equal(live.execution.handle(request("turn/interrupt")), "queueCodex");
  assert.deepEqual(live.calls, []);
});
