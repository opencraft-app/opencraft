import assert from "node:assert/strict";
import test from "node:test";
import {
  TransparentInternalResponseCoordinatorService,
} from "../src/services/transparent-internal-response-coordinator.ts";

function fixture(run) {
  const calls = [];
  const binding = {
    bindings: new Map([["outer-1", { rolloutPath: "/old.jsonl" }]]),
    setBinding: (...args) => calls.push(["setBinding", ...args]),
    clearBinding: (...args) => calls.push(["clearBinding", ...args]),
    setRuntimeHint: (...args) => calls.push(["setRuntimeHint", ...args]),
    persist: () => calls.push(["persist"]),
  };
  const instance = Object.create(TransparentInternalResponseCoordinatorService.prototype);
  instance.ctx = {
    transparentInternalResponse: { handle: run },
    transparentBackendChannel: {
      discardUnmatchedThreadMessages: (...args) => (
        calls.push(["discardUnmatched", ...args]), true
      ),
      flushThreadMessages: (state, innerThreadId, channelHost) => {
        calls.push(["flushThreadMessages", state, innerThreadId]);
        channelHost.replay(state, { method: "thread/started" });
      },
    },
    transparentBackendProjection: {
      projectThread: (...args) => calls.push(["projectThread", ...args.slice(0, 3)]),
    },
    transparentEngineSwitch: {
      continue: (...args) => calls.push(["continue", ...args]),
    },
    transparentThreadBinding: binding,
    threadArtifactStore: {
      current: (threadId) => threadId === "outer-1" ? { path: "/current.jsonl" } : null,
      discard: (...args) => calls.push(["discard", ...args]),
      commit: (...args) => {
        calls.push(["commit", ...args]);
        return { path: "/committed.jsonl" };
      },
    },
    transparentProtocolMapper: {
      toVirtual: (path) => path,
    },
  };
  const host = {
    retireIsolatedBackend: (...args) => {
      calls.push(["retire", ...args]);
      return true;
    },
    unsubscribe: (...args) => calls.push(["unsubscribe", ...args]),
    replayBackendMessage: (...args) => calls.push(["replay", ...args]),
    retireThreadRuntimeIfIdle: (...args) => calls.push(["retireIdle", ...args]),
    forwardTurn: (...args) => calls.push(["forwardTurn", ...args]),
    failOuter: (...args) => calls.push(["failOuter", ...args]),
    openOuter: (...args) => calls.push(["openOuter", ...args]),
    flushOpenQueue: (...args) => calls.push(["flushOpenQueue", ...args]),
  };
  return { calls, host, instance };
}

const state = { backendKey: "runtime-1", filesystem: {} };
const message = { id: "internal-1", result: {} };
const request = { outerThreadId: "outer-1", method: "thread/resume" };

test("coordinator owns durable handoff effects while preserving live host effects", () => {
  let captured;
  const { calls, host, instance } = fixture((_state, _message, _request, effects) => {
    captured = effects;
    effects.handoff.setBinding("outer-1", "inner-1", "workspace", "view-1", {
      ownerUserId: "user:alice",
      accountIdentity: "chatgpt:alice",
      providerId: null,
      engineKind: "codex",
      model: "gpt-5.6-sol",
      rolloutPath: "/generation-2.jsonl",
      backendKey: "runtime-1",
      epoch: 2,
    });
    effects.handoff.retry({ outerThreadId: "outer-1" });
    effects.handoff.projectThread("outer-1", { id: "inner-1" });
    return true;
  });

  assert.equal(instance.handle(state, message, request, host), true);
  assert.ok(captured.handoff);
  assert.deepEqual(calls[0].slice(0, 7), [
    "setBinding", "outer-1", "inner-1", true, true, "workspace", "view-1",
  ]);
  assert.deepEqual(calls[1], [
    "continue",
    { outerThreadId: "outer-1" },
  ]);
  assert.deepEqual(calls[2], [
    "projectThread",
    "outer-1",
    { id: "inner-1" },
    state,
  ]);
});

test("coordinator owns ordinary-open binding convergence", () => {
  const { calls, host, instance } = fixture((_state, _message, _request, effects) => {
    assert.equal(effects.open.currentArtifactPath("outer-1"), "/current.jsonl");
    assert.equal(effects.open.binding("outer-1").rolloutPath, "/old.jsonl");
    effects.open.clearBinding("outer-1");
    effects.open.setRuntimeHint("outer-1", {
      ownerUserId: "user:alice",
      accountIdentity: null,
      providerId: null,
      engineKind: "codex",
      model: null,
      backendKey: "runtime-1",
    });
    effects.open.persistBindings();
    effects.open.flushOpenQueue("outer-1");
    return true;
  });

  assert.equal(instance.handle(state, message, request, host), true);
  assert.deepEqual(calls, [
    ["clearBinding", "outer-1"],
    ["setRuntimeHint", "outer-1", {
      ownerUserId: "user:alice",
      accountIdentity: null,
      providerId: null,
      engineKind: "codex",
      model: null,
      backendKey: "runtime-1",
    }, false],
    ["persist"],
    ["flushOpenQueue", "outer-1"],
  ]);
});
