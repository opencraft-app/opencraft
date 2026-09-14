import assert from "node:assert/strict";
import test from "node:test";

import {
  createExecutionProfile,
  desiredRuntimeHint,
  executionProfilesCompatible,
} from "../src/services/execution-profile.ts";
import {
  executionProfileForRoute,
  runtimeNeedsExecutionHandoff,
  threadRuntimeBackendKey,
} from "../src/services/transparent-thread-routing.ts";

function profile(overrides = {}) {
  return createExecutionProfile({
    engineKind: "codex",
    providerId: "openai",
    model: "gpt-5.6-sol",
    credential: { accountIdentity: "chatgpt:alice", userId: "user:alice" },
    ...overrides,
  });
}

test("provider, credential and model boundaries create distinct engine identities", () => {
  const native = profile();
  const kimi = profile({ providerId: "public-k3", model: "kimi-k3" });
  const otherAccount = profile({
    credential: { accountIdentity: "chatgpt:bob", userId: "user:bob" },
  });
  const otherModel = profile({ model: "gpt-5.4" });

  assert.equal(executionProfilesCompatible(native, profile()), true);
  assert.equal(executionProfilesCompatible(native, kimi), false);
  assert.equal(executionProfilesCompatible(native, otherAccount), false);
  assert.equal(executionProfilesCompatible(native, otherModel), false);
});

test("the first explicit Codex model completes a provisional runtime hint without handoff", () => {
  const desired = profile();
  const provisional = {
    engineKind: "codex",
    providerId: "openai",
    model: null,
    accountIdentity: "chatgpt:alice",
    ownerUserId: "user:alice",
  };

  assert.equal(runtimeNeedsExecutionHandoff(null, provisional, desired), false);
  assert.equal(runtimeNeedsExecutionHandoff(null, {
    ...provisional,
    accountIdentity: "chatgpt:bob",
  }, desired), true);
});

test("custom and public provider routes are DSH profiles, never Codex profiles", () => {
  const credential = {
    accountIdentity: "model-provider:public:public-k3",
    providerId: "public-k3",
    userId: "user:alice",
  };
  const routed = executionProfileForRoute({
    kind: "dsh",
    provider: { providerId: "public-k3", model: "kimi-k3" },
  }, credential, "kimi-k3");
  assert.equal(routed.engineKind, "dsh");
  assert.equal(routed.providerId, "public-k3");

  const native = executionProfileForRoute(
    { kind: "codex" },
    { accountIdentity: "chatgpt:alice", userId: "user:alice" },
    "gpt-5.6-sol",
  );
  assert.equal(native.engineKind, "codex");
  assert.equal(native.providerId, "openai");
});

test("a thread runtime key includes the immutable engine fingerprint", () => {
  const nativeKey = threadRuntimeBackendKey("user:alice", "workspace", "main", "outer", profile());
  const kimiKey = threadRuntimeBackendKey("user:alice", "workspace", "main", "outer", profile({
    providerId: "public-k3",
    model: "kimi-k3",
  }));

  assert.notEqual(nativeKey, kimiKey);
  assert.match(nativeKey, /profile:engine=codex/);
});

test("pending settings select the next Turn without changing the committed Runtime", () => {
  const committed = {
    providerId: "openai",
    model: "gpt-5.6-sol",
    backendKey: "runtime-openai",
    nextProviderId: "public-k3",
    nextModel: "kimi-k3",
  };

  const desired = desiredRuntimeHint(committed);
  assert.equal(committed.providerId, "openai");
  assert.equal(committed.backendKey, "runtime-openai");
  assert.equal(desired.providerId, "public-k3");
  assert.equal(desired.model, "kimi-k3");
});
