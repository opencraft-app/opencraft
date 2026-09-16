import assert from "node:assert/strict";
import test from "node:test";

import { ConfigService } from "../src/services/config.ts";
import { HYPERNODE_ROUTER_PROVIDER_ID } from "../src/services/model-router.ts";

function serviceWith(modelGateway) {
  const service = Object.create(ConfigService.prototype);
  service.fallbackDefaults = new Map();
  service.ctx = {
    storage: { available: false },
    modelGateway,
  };
  return service;
}

test("config/batchWrite persists new-thread model defaults and selects its execution route", () => {
  const selected = [];
  const modelGateway = {
    currentUser: () => ({ id: "user:alice" }),
    setDefaultModelForConnection: (_connection, model) => selected.push(model),
    activeForConnection: () => ({ providerId: "public-k3", model: "kimi-k3" }),
    providerForModel: () => null,
  };
  const service = serviceWith(modelGateway);
  const response = service.batchWrite({ edits: [
    { keyPath: "model", value: "kimi-k3", mergeStrategy: "upsert" },
    { keyPath: "model_reasoning_effort", value: "high", mergeStrategy: "upsert" },
  ] }, { identity: { id: "user:alice" } });

  assert.deepEqual(selected, ["kimi-k3"]);
  assert.equal(response.status, "ok");
  assert.equal(response.filePath, "/workspace/.codex/config.toml");
  assert.equal(service.forConnection({ identity: { id: "user:alice" } }).model, "kimi-k3");
  assert.equal(service.forConnection({ identity: { id: "user:alice" } }).model_reasoning_effort, "high");
  const projected = service.forConnection({ identity: { id: "user:alice" } });
  assert.equal(projected.model_provider, HYPERNODE_ROUTER_PROVIDER_ID);
  assert.equal(projected.model_providers[HYPERNODE_ROUTER_PROVIDER_ID].name, "HyperNode Router");
});

test("profile-prefixed model edits are accepted and stale routed defaults do not leak into subscription mode", () => {
  const modelGateway = {
    currentUser: () => ({ id: "user:alice" }),
    setDefaultModelForConnection: () => {},
    activeForConnection: () => null,
    providerForModel: (_userId, model) => model === "kimi-k3" ? { providerId: "public-k3" } : null,
  };
  const service = serviceWith(modelGateway);
  service.batchWrite({ edits: [
    { keyPath: "profiles.work.model", value: "kimi-k3", mergeStrategy: "upsert" },
    { keyPath: "profiles.work.model_reasoning_effort", value: "medium", mergeStrategy: "upsert" },
  ] }, { identity: { id: "user:alice" } });

  const projected = service.forConnection({ identity: { id: "user:alice" } });
  assert.equal(projected.model, "gpt-5.6-sol");
  assert.equal(projected.model_reasoning_effort, "medium");
  assert.equal(projected.model_provider, HYPERNODE_ROUTER_PROVIDER_ID);
  assert.deepEqual(Object.keys(projected.model_providers), [HYPERNODE_ROUTER_PROVIDER_ID]);
});

test("config/batchWrite rejects unrelated keys instead of pretending to persist them", () => {
  const service = serviceWith({ currentUser: () => ({ id: "user:alice" }) });
  assert.throws(() => service.batchWrite({ edits: [
    { keyPath: "sandbox_mode", value: "danger-full-access", mergeStrategy: "upsert" },
  ] }, {}), /unsupported HyperNode config key/);
});
