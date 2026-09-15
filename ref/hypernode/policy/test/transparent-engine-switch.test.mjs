import assert from "node:assert/strict";
import test from "node:test";

import { TransparentEngineSwitchService } from "../src/services/transparent-engine-switch.ts";

function service(ctx) {
  return Object.assign(Object.create(TransparentEngineSwitchService.prototype), {
    ctx,
    sequence: 0,
  });
}

function start(overrides = {}) {
  return {
    connection: { socket: { send: assert.fail } },
    outerThreadId: "outer",
    message: { id: "turn", method: "turn/start", params: { threadId: "outer" } },
    actorCredential: {
      userId: "user:bob",
      accountIdentity: "chatgpt:bob",
      providerId: "provider:kimi",
    },
    backendUserId: "user:alice",
    executionProfile: null,
    reject: assert.fail,
    ...overrides,
  };
}

function environment() {
  const sent = [];
  const binding = {
    innerThreadId: "inner",
    realm: "workspace",
    viewId: "main",
    rolloutPath: "/workspace/rollout.jsonl",
  };
  const state = {
    backendKey: "runtime:target",
    isolatedOuterThreadId: "outer",
    executionProfile: null,
    realm: "workspace",
    viewId: "main",
    phase: "ready",
    processId: "runtime-process",
    pendingBackendMessages: [],
    opening: new Set(),
    opened: new Set(),
  };
  const filesystem = {
    send: (_processId, message) => sent.push(message),
  };
  const ctx = {
    runtimeWorkspace: {
      enabled: true,
      isWorkspaceFilesystem: () => true,
    },
    threadArtifactStore: {
      findLegacySource: () => null,
      prepare: (outerThreadId, _rolloutPath, _epoch, innerThreadId) => ({
        threadId: outerThreadId,
        innerThreadId,
        generation: 8,
        path: "/workspace/generation-8.jsonl",
      }),
      resumeHistory: () => null,
      runtimePath: (path) => `/runtime${path}`,
    },
    threadExecution: { table: { get: () => ({ epoch: 7 }) } },
    threadManager: { get: () => ({ cwd: "/workspace/projects/repo" }) },
    transparentBackendRpc: {
      trackInternal: (_state, id, handoff) => sent.push({ tracked: id, handoff }),
    },
    transparentBackendLifecycle: {
      ensure: () => state,
    },
    transparentRuntimeAccess: {
      stateForOuter: () => null,
      filesystemForRealm: () => filesystem,
      threadBackendKey: () => "runtime:target",
      backendKey: () => "runtime:shared",
      isWorkspaceFilesystem: () => true,
      toPhysical: (path) => path,
      filesystem: () => filesystem,
    },
    transparentRuntimeRetirement: {
      retireIsolatedBackend: assert.fail,
    },
    transparentThreadBinding: {
      bindings: new Map([["outer", binding]]),
      runtimeHintFor: () => null,
      persist: () => {},
    },
    userDirectory: { find: () => ({ homePath: "/home/alice" }) },
  };
  return {
    sent,
    state,
    binding,
    ctx,
  };
}

test("engine switch rejects a missing stable thread binding before snapshotting", () => {
  let rejected = null;
  const target = environment();
  target.ctx.transparentThreadBinding.bindings.clear();
  service(target.ctx).begin(start({
    reject: (reason, code) => { rejected = { reason, code }; },
  }));
  assert.match(rejected.reason, /no execution binding/);
  assert.equal(target.sent.length, 0);
});

test("engine switch snapshots a rollout and opens one isolated target runtime", () => {
  const target = environment();
  service(target.ctx).begin(start());
  assert.equal(target.sent.length, 2);
  assert.equal(target.sent[0].tracked, "hypernode:transparent:handoff-resume:1");
  assert.equal(target.sent[0].handoff.handoff.phase, "resuming");
  assert.equal(target.sent[1].method, "thread/resume");
  assert.equal(target.sent[1].params.threadId, "inner");
  assert.equal(target.sent[1].params.path, "/runtime/workspace/generation-8.jsonl");
  assert.equal(target.state.opening.has("outer"), true);
});

test("engine switch repairs a legacy rollout path before preparing the generation", () => {
  const target = environment();
  target.binding.rolloutPath = "/run/hypernode-users/alice/.codex/rollout.jsonl";
  let persisted = null;
  target.ctx.threadArtifactStore.findLegacySource = () => "/workspace/imported/rollout.jsonl";
  target.ctx.transparentThreadBinding.persist = () => {
    persisted = target.binding.rolloutPath;
  };
  service(target.ctx).begin(start());
  assert.equal(persisted, "/workspace/imported/rollout.jsonl");
  assert.equal(target.binding.rolloutPath, persisted);
});

test("engine switch maps another user's runtime rollout path back to the host", () => {
  const target = environment();
  target.binding.rolloutPath =
    "/run/hypernode-users/alice-stable/.codex/sessions/2026/08/31/" +
    "rollout-2026-08-31T09-28-56-inner.jsonl";
  target.ctx.userDirectory.find = () => ({
    homePath: "/data/hypernode/.runtime/users/alice-stable",
  });
  target.ctx.threadArtifactStore.findLegacySource = () => null;
  let preparedSource = null;
  const prepare = target.ctx.threadArtifactStore.prepare;
  target.ctx.threadArtifactStore.prepare = (...args) => {
    preparedSource = args[1];
    return prepare(...args);
  };

  service(target.ctx).begin(start());

  assert.equal(
    preparedSource,
    "/data/hypernode/.runtime/users/alice-stable/.codex/sessions/2026/08/31/" +
      "rollout-2026-08-31T09-28-56-inner.jsonl",
  );
  assert.equal(target.binding.rolloutPath, preparedSource);
});

test("engine switch maps the public Codex-home rollout alias back to the host", () => {
  const target = environment();
  target.binding.rolloutPath =
    "/workspace/.codex/sessions/2026/09/01/" +
    "rollout-2026-09-01T06-05-57-inner.jsonl";
  target.ctx.userDirectory.find = () => ({
    homePath: "/data/hypernode/.runtime/users/alice-stable",
  });
  target.ctx.threadArtifactStore.findLegacySource = () => null;
  let preparedSource = null;
  const prepare = target.ctx.threadArtifactStore.prepare;
  target.ctx.threadArtifactStore.prepare = (...args) => {
    preparedSource = args[1];
    return prepare(...args);
  };

  service(target.ctx).begin(start());

  assert.equal(
    preparedSource,
    "/data/hypernode/.runtime/users/alice-stable/.codex/sessions/2026/09/01/" +
      "rollout-2026-09-01T06-05-57-inner.jsonl",
  );
  assert.equal(target.binding.rolloutPath, preparedSource);
});
