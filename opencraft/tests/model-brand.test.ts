import assert from "node:assert/strict";
import test from "node:test";
import { resolveBrand } from "../plugins/builtin-agents/src/model-services/brand-resolution";

const assets = new Set(["deepseek", "claude", "openai", "azure", "qwen", "meta", "openrouter"]);
test("provider brands use exact IDs and explicit aliases, not arbitrary names", () => {
  assert.equal(resolveBrand("provider", "deepseek-official", assets), "deepseek");
  assert.equal(resolveBrand("provider", " Azure-OpenAI-Responses ", assets), "azure");
  assert.equal(resolveBrand("provider", "company-openai-gateway", assets), null);
  assert.equal(resolveBrand("provider", "custom-123", assets), null);
});
test("model brands follow model families independently of their hosting provider", () => {
  for (const [id, brand] of [
    ["deepseek-v4-flash", "deepseek"], ["deepseek-v4-pro", "deepseek"],
    ["deepseek-v4-flash-vision-exp", "deepseek"],
    ["openrouter/anthropic/claude-sonnet-4", "claude"],
    ["Qwen/Qwen3-32B", "qwen"], ["meta-llama/llama-3.3", "meta"],
    ["gpt-4.1", "openai"],
  ]) assert.equal(resolveBrand("model", id!, assets), brand);
  assert.equal(resolveBrand("model", "my-deepseek-copy", assets), null);
  assert.equal(resolveBrand("model", "local-test-model", assets), null);
});
test("missing assets and empty identifiers safely use the neutral fallback", () => {
  assert.equal(resolveBrand("provider", "deepseek-official", new Set()), null);
  assert.equal(resolveBrand("model", "claude-sonnet-4", new Set()), null);
  assert.equal(resolveBrand("model", "", assets), null);
});
