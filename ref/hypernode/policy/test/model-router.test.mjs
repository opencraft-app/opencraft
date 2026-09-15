import assert from "node:assert/strict";
import test from "node:test";

import {
  HYPERNODE_ROUTER_PROVIDER_ID,
  internalModelProvider,
} from "../src/services/model-router.ts";

test("the Desktop router identity never reaches an inner Codex runtime", () => {
  assert.equal(internalModelProvider(HYPERNODE_ROUTER_PROVIDER_ID), "openai");
  assert.equal(internalModelProvider(null), "openai");
  assert.equal(internalModelProvider("hypernode-public-kimi-k3"), "hypernode-public-kimi-k3");
});
