import assert from "node:assert/strict";
import test from "node:test";

import { TransparentBackendOpenService } from "../src/services/transparent-backend-open.ts";

function service() {
  return Object.create(TransparentBackendOpenService.prototype);
}

function state() {
  return {
    ownerUserId: "user:alice",
    accountIdentity: "chatgpt:alice",
    providerId: null,
    executionProfile: null,
    backendKey: "runtime:one",
    realm: "workspace",
    viewId: "main",
    opening: new Set(["outer"]),
    opened: new Set(),
    openResults: new Map(),
  };
}

function host(overrides = {}) {
  const calls = [];
  return {
    calls,
    value: {
      currentArtifactPath: () => null,
      failOuter: (...args) => calls.push(["fail", ...args]),
      discardUnmatchedThreadMessages: () => calls.push(["discard"]),
      clearBinding: (...args) => calls.push(["clear", ...args]),
      openOuter: (...args) => calls.push(["open", ...args]),
      setBinding: (...args) => calls.push(["binding", ...args]),
      binding: () => null,
      setRuntimeHint: (...args) => calls.push(["runtime", ...args]),
      persistBindings: () => calls.push(["persist"]),
      projectThread: (...args) => calls.push(["thread", ...args]),
      flushThreadMessages: (...args) => calls.push(["messages", ...args]),
      flushOpenQueue: (...args) => calls.push(["queue", ...args]),
      ...overrides,
    },
  };
}

test("ordinary start installs one runtime binding before releasing buffered messages", () => {
  const backend = state();
  const effects = host();
  assert.equal(service().handle(backend, {
    id: "start",
    result: {
      thread: { id: "inner", path: "/workspace/rollout.jsonl" },
      initialTurnsPage: { data: [{ id: "turn-1" }] },
    },
  }, { outerThreadId: "outer", method: "thread/start" }, effects.value), true);
  assert.equal(backend.opening.has("outer"), false);
  assert.equal(backend.opened.has("outer"), true);
  assert.deepEqual(effects.calls.map(([kind]) => kind), [
    "binding", "thread", "messages", "queue", "discard",
  ]);
  assert.equal(effects.calls[0][6].rolloutPath, "/workspace/rollout.jsonl");
});

test("opening a runtime never imports its compatibility history page", () => {
  const backend = state();
  const effects = host();
  service().handle(backend, {
    id: "resume",
    result: {
      thread: { id: "inner", turns: [{ id: "legacy-embedded" }] },
      initialTurnsPage: { data: [{ id: "legacy-page" }] },
    },
  }, { outerThreadId: "outer", method: "thread/resume" }, effects.value);
  assert.equal(effects.calls.some(([kind]) => kind === "turn"), false);
});

test("missing rollout resume retries only when no durable artifact exists", () => {
  const retry = host();
  assert.equal(service().handle(state(), {
    id: "resume",
    error: { code: -32000, message: "no rollout found for thread" },
  }, { outerThreadId: "outer", method: "thread/resume" }, retry.value), true);
  assert.deepEqual(retry.calls, [["clear", "outer"], ["open", "outer", true]]);

  const durable = host({ currentArtifactPath: () => "/workspace/generation-2.jsonl" });
  service().handle(state(), {
    id: "resume",
    error: { code: -32000, message: "no rollout found for thread" },
  }, { outerThreadId: "outer", method: "thread/resume" }, durable.value);
  assert.deepEqual(durable.calls, [
    ["fail", "outer", "no rollout found for thread"],
    ["discard"],
  ]);
});

test("handoff responses remain owned by the dedicated migration state machine", () => {
  const backend = state();
  assert.equal(service().handle(backend, { id: "resume", result: {} }, {
    outerThreadId: "outer",
    method: "thread/resume",
    handoff: {},
  }, host().value), false);
  assert.equal(backend.opening.has("outer"), true);
});
