import assert from "node:assert/strict";
import test from "node:test";

import { TransparentHandoffService } from "../src/services/transparent-handoff.ts";

function service() {
  return Object.create(TransparentHandoffService.prototype);
}

function backend() {
  return {
    backendKey: "runtime:target",
    realm: "workspace",
    viewId: "view-2",
    opening: new Set(["outer"]),
    opened: new Set(),
    openResults: new Map(),
  };
}

function handoff(overrides = {}) {
  return {
    connection: { socket: { send: assert.fail } },
    outerThreadId: "outer",
    message: { id: "turn", method: "turn/start", params: { threadId: "outer" } },
    actorCredential: {
      userId: "user:bob",
      accountIdentity: "chatgpt:bob",
      providerId: "provider:kimi",
    },
    executionProfile: {
      engineKind: "codex",
      providerId: "provider:kimi",
      model: "kimi-k3",
      credentialIdentity: "chatgpt:bob",
      actorUserId: "user:bob",
      turnConfig: {},
      fingerprint: "profile:kimi",
    },
    authority: { epoch: 9 },
    binding: { innerThreadId: "inner", realm: "workspace", viewId: "view-1" },
    runtimeHint: {},
    oldState: null,
    reject: assert.fail,
    phase: "resuming",
    reidentify: false,
    resumeRoute: { model: "kimi-k3", modelProvider: "provider:kimi" },
    artifact: {
      threadId: "outer",
      innerThreadId: "inner",
      generation: 10,
      path: "/workspace/generation-10.jsonl",
      resumeMode: "path",
      persistent: true,
    },
    ...overrides,
  };
}

function host(overrides = {}) {
  const calls = [];
  return {
    calls,
    value: {
      discardArtifact: (...args) => calls.push(["discard", ...args]),
      retireIsolatedBackend: (...args) => {
        calls.push(["retire", ...args]);
        return true;
      },
      retry: (...args) => calls.push(["retry", ...args]),
      setBinding: (...args) => calls.push(["binding", ...args]),
      commitArtifact: (...args) => calls.push(["commit", ...args]),
      unsubscribe: (...args) => calls.push(["unsubscribe", ...args]),
      projectThread: (...args) => calls.push(["thread", ...args]),
      flushThreadMessages: (...args) => calls.push(["messages", ...args]),
      discardUnmatchedThreadMessages: () => calls.push(["unmatched"]),
      forwardTurn: (...args) => calls.push(["forward", ...args]),
      ...overrides,
    },
  };
}

test("successful engine handoff commits the prepared generation before forwarding the turn", () => {
  const state = backend();
  const migration = handoff();
  const effects = host();
  assert.equal(service().handle(state, {
    id: "resume",
    result: {
      thread: { id: "inner", path: "/runtime/rollout.jsonl" },
      initialTurnsPage: { data: [{ id: "turn-old" }] },
    },
  }, migration, effects.value), true);

  assert.equal(state.opening.has("outer"), false);
  assert.equal(state.opened.has("outer"), true);
  assert.deepEqual(effects.calls.map(([kind]) => kind), [
    "binding", "commit", "thread", "messages", "unmatched", "forward",
  ]);
  const runtime = effects.calls[0][5];
  assert.equal(runtime.model, "kimi-k3");
  assert.equal(runtime.providerId, "provider:kimi");
  assert.equal(runtime.epoch, 9);
});

test("an unmanaged writer retries once with a reidentified rollout", () => {
  const state = backend();
  const migration = handoff();
  const effects = host();
  assert.equal(service().handle(state, {
    id: "resume",
    error: { code: -32000, message: "thread inner already has an active writer" },
  }, migration, effects.value), true);
  assert.equal(migration.phase, "quiescing");
  assert.equal(migration.reidentify, true);
  assert.deepEqual(effects.calls.map(([kind]) => kind), ["discard", "retire", "retry"]);
});

test("a path resume rejects an unexpected target thread identity", () => {
  const state = backend();
  let rejected = null;
  const migration = handoff({ reject: (reason, code) => { rejected = { reason, code }; } });
  const effects = host();
  service().handle(state, {
    id: "resume",
    result: { thread: { id: "foreign" } },
  }, migration, effects.value);
  assert.match(rejected.reason, /unexpected thread foreign/);
  assert.equal(rejected.code, -32072);
  assert.deepEqual(effects.calls.map(([kind]) => kind), ["discard", "retire"]);
});
