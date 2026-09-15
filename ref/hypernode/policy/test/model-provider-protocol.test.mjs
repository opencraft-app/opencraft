import assert from "node:assert/strict";
import test from "node:test";

import {
  OPENAI_COMPLETIONS,
  OPENAI_RESPONSES,
  modelProtocol,
  needsInternalFinishTool,
  normalizedModelEndpoint,
  piAiCompatForRecord,
  sanitizeNativeResponseIds,
} from "../src/services/model-provider-protocol.ts";

test("TokenHub Kimi K3 records default to Pi AI's Chat Completions adapter", () => {
  const record = {
    endpoint: "https://tokenhub.tencentmaas.com/v1/chat/completions",
    displayName: "Kimi K3",
    model: "ep-xodwa4gc",
  };
  assert.equal(modelProtocol(record), OPENAI_COMPLETIONS);
  assert.equal(needsInternalFinishTool(record), false);
  assert.equal(normalizedModelEndpoint(record), "https://tokenhub.tencentmaas.com/v1/chat/completions");
  assert.deepEqual(piAiCompatForRecord(record), {
    supportsDeveloperRole: false,
    maxTokensField: "max_tokens",
    thinkingFormat: "deepseek",
    requiresReasoningContentOnAssistantMessages: true,
  });
});

test("an explicit provider protocol overrides capability inference", () => {
  const record = {
    endpoint: "https://tokenhub.tencentmaas.com/v1/responses",
    displayName: "Kimi K3",
    apiProtocol: OPENAI_COMPLETIONS,
  };
  assert.equal(modelProtocol(record), OPENAI_COMPLETIONS);
  assert.equal(normalizedModelEndpoint(record), "https://tokenhub.tencentmaas.com/v1/chat/completions");
});

test("an explicitly native Responses K3 provider retains native-only contracts", () => {
  const record = {
    endpoint: "https://tokenhub.tencentmaas.com/v1/chat/completions",
    displayName: "Kimi K3",
    model: "ep-xodwa4gc",
    apiProtocol: OPENAI_RESPONSES,
  };
  assert.equal(modelProtocol(record), OPENAI_RESPONSES);
  assert.equal(needsInternalFinishTool(record), true);
  assert.equal(normalizedModelEndpoint(record), "https://tokenhub.tencentmaas.com/v1/responses");
  assert.deepEqual(piAiCompatForRecord(record), {});
});

test("unknown providers retain the Chat Completions compatibility path", () => {
  const record = { endpoint: "https://models.example/v1", displayName: "Private model" };
  assert.equal(modelProtocol(record), OPENAI_COMPLETIONS);
  assert.equal(normalizedModelEndpoint(record), "https://models.example/v1/chat/completions");
});

test("complete versioned provider endpoints are not rewritten through v1", () => {
  const record = {
    endpoint: "https://tokenhub.tencentmaas.com/plan/v3/chat/completions",
    displayName: "DeepSeek V4 Flash",
    model: "deepseek-v4-flash-202605",
    apiProtocol: OPENAI_COMPLETIONS,
  };
  assert.equal(
    normalizedModelEndpoint(record),
    "https://tokenhub.tencentmaas.com/plan/v3/chat/completions",
  );
});

test("only the terminal API method changes when protocols change", () => {
  const record = {
    endpoint: "https://provider.example/custom/v3/chat/completions",
    apiProtocol: OPENAI_RESPONSES,
  };
  assert.equal(
    normalizedModelEndpoint(record),
    "https://provider.example/custom/v3/responses",
  );
});
test("unsupported explicit protocols fail closed", () => {
  assert.throws(
    () => modelProtocol({ apiProtocol: "guess-for-me" }),
    /unsupported model API protocol/,
  );
});

test("native Responses ids are repaired deterministically without touching tool arguments", () => {
  const source = {
    id: "fc_exec_command:0",
    call_id: "exec_command:0",
    arguments: '{"url":"https://example.test/a:b"}',
    nested: { item_id: "fc_exec_command:0", id: "already_safe" },
  };
  const first = sanitizeNativeResponseIds(source);
  const second = sanitizeNativeResponseIds(source);
  assert.equal(first.repairs, 3);
  assert.deepEqual(first, second);
  assert.match(first.value.id, /^[A-Za-z0-9_-]+$/);
  assert.equal(first.value.id, first.value.nested.item_id);
  assert.equal(first.value.nested.id, "already_safe");
  assert.equal(first.value.arguments, source.arguments);
});
