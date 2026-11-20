import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ModelCatalog } from "../src/adapters/models/model-catalog.mjs";
import { compatibleProvider } from "../src/adapters/models/openai-compatible.mjs";
import { modelRequest } from "../src/adapters/models/model-request.mjs";
import { normalizeUsage } from "../src/domain/usage.mjs";

test("native Pi provider uses explicit compatible endpoint/model/key, parses SSE and records unknown pricing", async (t) => {
  let received;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = {
      url: req.url,
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks)),
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (value) =>
      res.write("data: " + JSON.stringify(value) + "\n\n");
    send({
      id: "test",
      object: "chat.completion.chunk",
      model: "explicit-test-model",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: '{"ok":true}' },
          finish_reason: null,
        },
      ],
    });
    send({
      id: "test",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
    send({
      id: "test",
      object: "chat.completion.chunk",
      choices: [],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    });
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const previous = process.env.OPENCRAFT_EVAL_API_KEY;
  process.env.OPENCRAFT_EVAL_API_KEY = "synthetic-key";
  t.after(() => {
    if (previous === undefined) delete process.env.OPENCRAFT_EVAL_API_KEY;
    else process.env.OPENCRAFT_EVAL_API_KEY = previous;
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const catalog = await ModelCatalog.open({
    config: {
      mode: "model",
      model: {
        provider: "openai-compatible",
        modelId: "explicit-test-model",
        baseUrl,
        thinking: "disabled",
      },
    },
  });
  let usage;
  const result = await modelRequest(
    catalog,
    "test",
    "Return JSON.",
    { query: "hello" },
    AbortSignal.timeout(10000),
    {
      maxTokens: 64,
      recordUsage: (value) => {
        usage = value.usage;
      },
    },
  );
  assert.equal(received.url, "/v1/chat/completions");
  assert.equal(received.authorization, "Bearer synthetic-key");
  assert.equal(received.body.model, "explicit-test-model");
  assert.equal(received.body.stream, true);
  assert.equal(received.body.max_tokens, 64);
  assert.equal(received.body.store, undefined);
  assert.deepEqual(received.body.thinking, { type: "disabled" });
  assert.equal(received.body.messages[0].role, "system");
  assert.equal(
    result.content
      .filter((x) => x.type === "text")
      .map((x) => x.text)
      .join(""),
    '{"ok":true}',
  );
  assert.equal(usage.totalTokens, 18);
  assert.equal(usage.output, 7);
  assert.equal(normalizeUsage(usage).estimatedCostUsd, null);
});

test("compatible provider refuses embedded credentials, query parameters, remote plain HTTP and invalid thinking settings", () => {
  for (const baseUrl of [
    "https://user:password@example.test/v1",
    "https://example.test/v1?api_key=bad",
    "http://example.test/v1",
  ])
    assert.throws(() => compatibleProvider({ baseUrl, modelId: "model" }));
  assert.throws(() =>
    compatibleProvider({
      baseUrl: "https://example.test/v1",
      modelId: "model",
      thinking: "unknown",
    }),
  );
});
