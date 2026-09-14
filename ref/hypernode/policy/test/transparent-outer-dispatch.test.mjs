import assert from "node:assert/strict";
import test from "node:test";
import { TransparentOuterDispatchService } from "../src/services/transparent-outer-dispatch.ts";
import { hydrateTransparentBindings } from "../src/services/transparent-thread-binding.ts";

function connection() {
  return {
    identity: { id: "actor-1", username: "alice" },
    socket: { send() {} },
    connectionId: "connection-1",
  };
}

function state(overrides = {}) {
  return {
    backendKey: "runtime-1",
    processId: "codex-1",
    realm: "workspace",
    viewId: "main",
    providerId: "private-provider",
    executionProfile: null,
    runtimeFingerprint: "fingerprint-1",
    user: null,
    opened: new Set(),
    opening: new Set(),
    pendingByOuter: new Map(),
    openResults: new Map(),
    forwardedRequests: new Map(),
    ...overrides,
  };
}

function harness(overrides = {}) {
  const calls = [];
  const bindingFor = overrides.bindingFor ?? (() => ({
      innerThreadId: "inner-1",
      durable: true,
      rolloutPath: "/rollout/fallback.jsonl",
      realm: "workspace",
      viewId: "main",
    }));
  const thread = overrides.thread ?? (() => ({
      id: "outer-1",
      cwd: "/workspace/projects/repo",
      ephemeral: false,
      threadSource: "appServer",
    }));
  const runtimeHintFor = overrides.runtimeHintFor ?? (() => ({
      providerId: "private-provider",
      model: "private-model",
      engineKind: "codex",
      ownerUserId: "owner-1",
      accountIdentity: "credential-1",
    }));
  const bindRuntime = overrides.bindRuntime ?? ((...args) => (
    calls.push(["bind", ...args]), true
  ));
  const artifactFor = overrides.artifactFor ?? (() => ({
    innerThreadId: "inner-1",
    path: "/rollout/current.jsonl",
  }));
  const service = Object.assign(Object.create(TransparentOuterDispatchService.prototype), {
    sequence: 0,
  });
  service.ctx = {
    transparentThreadBinding: {
      bindings: new Map([["outer-1", bindingFor("outer-1")]]),
      runtimeHintFor,
    },
    threadManager: { get: thread },
    threadArtifactStore: {
      current: artifactFor,
      ensureModelProvider: (...args) => {
      calls.push(["repair", ...args]);
      return { providerChanged: true, sessionMetaCount: 1, responseItemIdsStripped: 2 };
      },
      runtimePath: (path) => `/runtime${path}`,
    },
    transparentRuntimeAccess: {
      filesystem: () => ({
        ensureWorkingDirectory: (...args) => calls.push(["cwd", ...args]),
        send: (...args) => calls.push(["backend", ...args]),
      }),
      toInner: (message) => ({ ...message, projected: "inner" }),
      toOuter: (message) => ({ ...message, projected: "outer" }),
    },
    transparentBackendRpc: {
      trackInternal: (...args) => calls.push(["internal", ...args]),
      trackForwarded: (...args) => calls.push(["forwarded", ...args]),
    },
    transparentBackendChannel: {
      send: (...args) => calls.push(["send", ...args]),
    },
    threadExecution: {
      table: { get: () => ({ epoch: 7 }) },
      bindRuntime,
      abortRequest: (...args) => calls.push(["abort", ...args]),
    },
  };
  return { calls, service };
}

test("a durable outer Thread resumes from one internally consistent committed artifact", () => {
  const target = state();
  const { calls, service } = harness();

  service.open(target, "outer-1");

  assert.equal(target.opening.has("outer-1"), true);
  assert.deepEqual(calls.find(([kind]) => kind === "repair").slice(1), [
    "/rollout/current.jsonl",
    "private-provider",
  ]);
  const outbound = calls.find(([kind]) => kind === "backend")[2];
  assert.equal(outbound.method, "thread/resume");
  assert.equal(outbound.params.threadId, "inner-1");
  assert.equal(outbound.params.path, "/runtime/rollout/current.jsonl");
  assert.equal(outbound.params.modelProvider, "private-provider");
  assert.equal(outbound.projected, "inner");
});

test("restart resumes the handoff artifact after it diverges from the base rollout", () => {
  const artifact = {
    threadId: "outer-1",
    innerThreadId: "handoff-inner-8",
    generation: 8,
    path: "/rollout/handoff-generation-8.jsonl",
    accountIdentity: "chatgpt:target",
    ownerUserId: "user:alice",
    epoch: 7,
  };
  const bindingState = {
    bindings: new Map(),
    runtimeHints: new Map(),
    reverseBindings: new Map(),
  };
  hydrateTransparentBindings(bindingState, {
    principalId: "user:alice",
    policyStore: {
      get: () => JSON.stringify({
        version: 4,
        records: [{
          outerThreadId: "outer-1",
          innerThreadId: "base-inner",
          realm: "workspace",
          viewId: "main",
          rolloutPath: "/rollout/base.jsonl",
          lastRuntimeHint: {
            ownerUserId: "user:alice",
            accountIdentity: "chatgpt:source",
            engineKind: "codex",
          },
        }],
        runtimeRecords: [],
      }),
      set: () => {},
    },
    artifacts: {
      current: () => artifact,
      values: () => [artifact],
    },
    threads: {
      find: () => ({ id: "outer-1", cwd: "/workspace/projects/repo" }),
      isTransparentCodex: () => true,
    },
    workspaceViews: { recordFor: () => ({ viewId: "main" }) },
    users: {
      find: (id) => id === "user:alice" ? { id } : null,
      list: () => [{ id: "user:alice" }],
    },
    credentials: { resolveUser: () => null },
  });

  assert.equal(bindingState.bindings.get("outer-1").rolloutPath, artifact.path);
  assert.equal(bindingState.bindings.get("outer-1").innerThreadId, artifact.innerThreadId);
  assert.equal(bindingState.runtimeHints.get("outer-1").accountIdentity, "chatgpt:target");

  const target = state();
  const { calls, service } = harness({
    bindingFor: () => bindingState.bindings.get("outer-1"),
    artifactFor: () => artifact,
  });
  service.open(target, "outer-1");

  const outbound = calls.find(([kind]) => kind === "backend")[2];
  assert.equal(outbound.params.threadId, "handoff-inner-8");
  assert.equal(outbound.params.path, "/runtime/rollout/handoff-generation-8.jsonl");
  assert.notEqual(outbound.params.path, "/runtime/rollout/base.jsonl");
});

test("open queue replies are projected back into the outer namespace", () => {
  const targetConnection = connection();
  const target = state({
    pendingByOuter: new Map([["outer-1", [{
      connection: targetConnection,
      message: { id: "read-1", method: "thread/read", params: {} },
      respondFromOpen: true,
    }]]]),
    openResults: new Map([["outer-1", { thread: { id: "inner-1" } }]]),
  });
  const { calls, service } = harness();

  service.flush(target, "outer-1");

  assert.equal(target.pendingByOuter.has("outer-1"), false);
  const sent = calls.find(([kind]) => kind === "send")[2];
  assert.equal(sent.id, "read-1");
  assert.equal(sent.projected, "outer");
});

test("turn/start fences authority before forwarding to the selected Runtime", () => {
  const targetConnection = connection();
  const target = state();
  const { calls, service } = harness();

  service.forward(target, targetConnection, "outer-1", {
    id: "turn-1",
    method: "turn/start",
    params: { threadId: "outer-1" },
  });

  const bind = calls.find(([kind]) => kind === "bind");
  assert.deepEqual(bind.slice(1), [
    "outer-1",
    targetConnection,
    "runtime-1",
    "inner-1",
    7,
    "fingerprint-1",
  ]);
  const tracked = calls.find(([kind]) => kind === "forwarded")[3];
  assert.equal(tracked.authorityEpoch, 7);
  const outbound = calls.find(([kind]) => kind === "backend")[2];
  assert.equal(outbound.params.modelProvider, "private-provider");
});

test("turn/steer correlation captures identifiers without logging message input", () => {
  const targetConnection = { ...connection(), sessionId: "session-1" };
  const target = state();
  const { calls, service } = harness();
  const logs = [];
  const originalInfo = console.info;
  console.info = (...args) => logs.push(args.map(String).join(" "));
  try {
    service.forward(target, targetConnection, "outer-1", {
      id: "steer-request-1",
      method: "turn/steer",
      params: {
        threadId: "outer-1",
        expectedTurnId: "turn-1",
        clientUserMessageId: "message-1",
        input: [{ type: "text", text: "must-not-be-logged" }],
      },
    });
  } finally {
    console.info = originalInfo;
  }

  const tracked = calls.find(([kind]) => kind === "forwarded")[3];
  assert.equal(tracked.backendId, "hypernode:transparent:request:1");
  assert.equal(tracked.clientUserMessageId, "message-1");
  assert.equal(tracked.expectedTurnId, "turn-1");
  assert.equal(typeof tracked.forwardedAtMs, "number");
  assert.match(logs.join("\n"), /"stage":"forwarded"/);
  assert.doesNotMatch(logs.join("\n"), /must-not-be-logged/);
});

test("a lost authority fence fails the request without dispatching it", () => {
  const targetConnection = connection();
  const target = state();
  const { calls, service } = harness({ bindRuntime: () => false });

  service.forward(target, targetConnection, "outer-1", {
    id: "turn-1",
    method: "turn/start",
    params: { threadId: "outer-1" },
  });

  assert.equal(calls.some(([kind]) => kind === "abort"), true);
  assert.equal(calls.some(([kind]) => kind === "backend"), false);
  const error = calls.find(([kind]) => kind === "send")[2].error;
  assert.equal(error.code, -32068);
});
