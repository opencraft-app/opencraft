import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anthropicRequest, ANTHROPIC_THINKING_PREFIX, withPromptCacheBreakpoints, withoutThinkingHistory } from "../../packages/account-pool-host/src/anthropic-request.js";
import { responsesPayloadForOpenAI } from "../../packages/account-pool-host/src/foreign-history.js";
import { forwardConfiguredResponses } from "../../packages/account-pool-host/src/configured-forward.js";
import { gzipSync } from "node:zlib";
import { anthropicResponse, anthropicHttpError } from "../../packages/account-pool-host/src/anthropic-response.js";
import { anthropicToolSchema } from "../../packages/account-pool-host/src/anthropic-tool-schema.js";
import { AccountPoolStore, CodexAccountPoolProxy } from "../../packages/account-pool-host/src/index.js";
import { ModelConfigurationRepository, ModelCredentialRepository } from "../../apps/local-agent-host/src/model-config/repository.js";
import { createConfiguredCodexResponses } from "../../apps/codex-core/src/configured-responses.js";

const tool = { type: "function", name: "echo", description: "Echo", parameters: { type: "object", properties: { value: { type: "string" } } } };
const start = { type: "message_start", message: { id: "msg-fixture", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } };
const end = (reason = "end_turn") => [{ type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 4 } }, { type: "message_stop" }];
const text = (value: string, index = 0) => [{ type: "content_block_start", index, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index, delta: { type: "text_delta", text: value } }, { type: "content_block_stop", index }];
function upstream(events: unknown[], bytewise = false, cancel?: () => void) {
  const bytes = new TextEncoder().encode(events.map(e => `event: ${(e as any).type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join(""));
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    const next = bytewise ? offset + 1 : bytes.length;
    controller.enqueue(bytes.slice(offset, next)); offset = next;
  }, cancel }), { headers: { "content-type": "text/event-stream" } });
}
function bridge(events: unknown[], options: { bytewise?: boolean; cancel?: () => void; streaming?: boolean; tools?: any[] } = {}) {
  const request = anthropicRequest({ model: "ep", input: "hello", tools: options.tools ?? [tool] });
  const reasons: string[] = [];
  const response = anthropicResponse(upstream(events, options.bytewise, options.cancel), "configured/test/ep", request.tools,
    options.streaming !== false, reason => reasons.push(reason));
  return { response, reasons };
}
async function events(response: Response) {
  return (await response.text()).split(/\n\n/u).filter(Boolean).map(record => JSON.parse(record.split("\ndata: ")[1]));
}

test("Anthropic request maps full history, namespaces, freeform calls and explicit limits", () => {
  const request = anthropicRequest({ model: "ep", instructions: "Instruction", max_output_tokens: 9000,
    tools: [{ type: "namespace", name: "files", tools: [tool] }, { type: "custom", name: "patch" }], parallel_tool_calls: false,
    input: [{ role: "developer", content: "Developer" }, { role: "user", content: [{ type: "input_text", text: "Hello" }] },
      { type: "function_call", name: "echo", namespace: "files", call_id: "one", arguments: '{"value":"a"}' },
      { type: "custom_tool_call", name: "patch", call_id: "two", input: "raw patch" },
      { type: "function_call_output", call_id: "one", output: "a" }, { type: "custom_tool_call_output", call_id: "two", output: "done" },
      { role: "user", content: "Continue" }] }, 8000);
  assert.equal(request.body.max_tokens, 8000); assert.equal(request.body.stream, true);
  assert.deepEqual(request.body.system.map((p: any) => p.text), ["Instruction", "Developer"]);
  assert.deepEqual(request.body.messages.map((m: any) => m.role), ["user", "assistant", "user"]);
  assert.deepEqual(request.body.messages[1].content[1].input, { input: "raw patch" });
  assert.equal(request.body.messages[2].content[0].tool_use_id, "one");
  assert.equal(request.body.tools[0].name, request.body.messages[1].content[0].name);
  assert.equal(request.tools.get(request.body.tools[0].name)?.namespace, "files");
  assert.equal(request.body.tool_choice.disable_parallel_tool_use, true);
});

test("signed and redacted thinking round trip without another history store", async () => {
  const fixture = bridge([start,
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Reasoning" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "nature" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "opaque-data" } },
    { type: "content_block_stop", index: 1 }, ...text("Answer", 2), ...end()]);
  const result = (await events(fixture.response)).at(-1).response;
  assert.equal(result.output[0].encrypted_content.startsWith(ANTHROPIC_THINKING_PREFIX), true);
  const next = anthropicRequest({ model: "ep", input: [{ role: "user", content: "question" }, ...result.output, { role: "user", content: "next" }] });
  assert.deepEqual(next.body.messages[1].content.slice(0,2), [{ type: "thinking", thinking: "Reasoning", signature: "signature" }, { type: "redacted_thinking", data: "opaque-data" }]);
});

test("one-byte UTF-8 and CRLF streams retain text, usage and genuine terminal receipt", async () => {
  let cancelled = false;
  const fixture = bridge([start, ...text("你好🙂"), ...end()], { bytewise: true, cancel: () => { cancelled = true; } });
  const result = await events(fixture.response);
  assert.equal(result.filter(e => e.type === "response.completed").length, 1);
  assert.equal(result.at(-1).response.output[0].content[0].text, "你好🙂");
  assert.deepEqual(result.at(-1).response.usage, { input_tokens: 15, output_tokens: 4, total_tokens: 19, input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 } });
  assert.deepEqual(fixture.reasons, ["end_turn"]);
  assert.equal(cancelled, true);
});

test("parallel function and freeform calls reconstruct complete arguments and original identity", async () => {
  const fixture = bridge([start,
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-one", name: "echo", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"value":' } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"hello"}' } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call-two", name: "patch", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"input":"patch text"}' } },
    { type: "content_block_stop", index: 1 }, ...end("tool_use")], { tools: [tool, { type: "custom", name: "patch" }] });
  const result = (await events(fixture.response)).at(-1).response;
  assert.equal(result.output[0].arguments, '{"value":"hello"}');
  assert.equal(result.output[0].call_id, "call-one");
  assert.equal(result.output[1].type, "custom_tool_call");
  assert.equal(result.output[1].input, "patch text");
  const next = anthropicRequest({ model: "ep", tools: [tool, { type: "custom", name: "patch" }],
    input: [{ role: "user", content: "run tools" }, ...result.output,
      { type: "function_call_output", call_id: "call-one", output: "hello" }, { type: "custom_tool_call_output", call_id: "call-two", output: "patched" }] });
  assert.deepEqual(next.body.messages[2].content.map((c: any) => c.tool_use_id), ["call-one", "call-two"]);
});

test("root combinators survive a complete tool/result turn without leaking the transport envelope into native arguments", async () => {
  for (const keyword of ["oneOf", "allOf", "anyOf"]) {
    const parameters = { [keyword]: [{ type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }] };
    const tools = [{ ...tool, parameters }];
    const compiled = anthropicRequest({ model: "ep", input: "hello", tools });
    const schema = compiled.body.tools[0].input_schema;
    assert.equal(schema.type, "object");
    for (const key of ["oneOf", "allOf", "anyOf"]) assert.equal(Object.hasOwn(schema, key), false);
    assert.deepEqual(schema.properties.arguments, parameters);
    const fixture = bridge([start,
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "wrapped", name: "echo", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"arguments":{' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"value":"hello"}}' } },
      { type: "content_block_stop", index: 0 }, ...end("tool_use")], { tools });
    const frames = await events(fixture.response), call = frames.at(-1).response.output[0];
    assert.deepEqual(JSON.parse(call.arguments), { value: "hello" });
    assert.equal(frames.some(event => event.type === "response.function_call_arguments.delta"), false);
    const next = anthropicRequest({ model: "ep", tools, input: [{ role: "user", content: "hello" }, call,
      { type: "function_call_output", call_id: "wrapped", output: "result" }] });
    assert.deepEqual(next.body.messages[1].content[0].input, { arguments: { value: "hello" } });
    const malformed = bridge([start, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "bad", name: "echo", input: { value: "no-envelope" } } },
      { type: "content_block_stop", index: 0 }, ...end("tool_use")], { tools });
    const badFrames = await events(malformed.response);
    assert.equal(badFrames.at(-1).type, "response.failed");
    assert.equal(badFrames.some(event => event.type === "response.output_item.done" && event.item.type === "function_call"), false);
  }
});

test("wrapped schema rebases local references, preserves resource scope, and never rewrites reference-shaped data", () => {
  const original = { oneOf: [{ $ref: "#/$defs/input" }], $defs: { input: { type: "object", properties: { child: { $ref: "#/$defs/input" } } } },
    default: { $ref: "#/a-literal-value" }, examples: [{ $ref: "#/literal" }] };
  const nested = anthropicToolSchema(original).schema.properties.arguments;
  assert.equal(nested.oneOf[0].$ref, "#/properties/arguments/$defs/input");
  assert.equal(nested.$defs.input.properties.child.$ref, "#/properties/arguments/$defs/input");
  assert.deepEqual(nested.default, original.default); assert.deepEqual(nested.examples, original.examples);
  assert.equal(original.oneOf[0].$ref, "#/$defs/input");
  const scoped = { ...original, $id: "https://schema.test/tool" };
  assert.deepEqual(anthropicToolSchema(scoped).schema.properties.arguments, scoped);
  const ordinary = { type: "object", properties: { value: { anyOf: [{ type: "string" }, { type: "null" }] } } };
  assert.equal(anthropicToolSchema(ordinary).enveloped, false);
});

test("refusal, output truncation, malformed arguments and missing terminal never become success", async () => {
  for (const reason of ["refusal", "content_filter", "pause_turn"]) {
    const fixture = bridge([start, ...text("Partial"), ...end(reason)]), result = await events(fixture.response);
    assert.equal(result.at(-1).type, "response.failed");
    assert.equal(result.at(-1).response.error.code, "invalid_prompt");
    assert.equal(result.some(e => e.type === "response.completed"), false);
  }
  const truncated = await events(bridge([start, ...text("Partial"), ...end("max_tokens")]).response);
  assert.equal(truncated.at(-1).type, "response.incomplete");
  assert.equal(truncated.at(-1).response.incomplete_details.reason, "max_output_tokens");
  for (const incomplete of [[start, ...text("partial")], [start,
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "x", name: "echo", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{broken" } },
    { type: "content_block_stop", index: 0 }, ...end("tool_use")]]) {
    const result = await events(bridge(incomplete).response);
    assert.equal(result.at(-1).type, "response.failed");
    assert.equal(result.some(e => e.type === "response.completed"), false);
  }
});

test("unsupported input is rejected locally and declared thinking parameters are mapped explicitly", () => {
  for (const input of [[{ type: "web_search_call" }],
    [{ type: "function_call_output", call_id: "missing", output: "x" }]]) {
    assert.throws(() => anthropicRequest({ model: "ep", input }), /history|matching|Unsupported/u);
  }
  assert.throws(() => anthropicRequest({ model: "ep", input: "hello", previous_response_id: "old" }), /full conversation/u);
  assert.throws(() => anthropicRequest({ model: "ep", input: "hello", tools: [{ type: "web_search" }], tool_choice: { type: "web_search" } }), /Unsupported tool selection/u);
  assert.throws(() => anthropicRequest({ model: "ep", input: "hello", tools: [{ type: "tool_search", execution: "client" }] }), /supports function/u);
  assert.deepEqual(anthropicRequest({ model: "ep", input: "hello", reasoning: { effort: "high" } }).body.output_config, { effort: "high" });
  assert.deepEqual(anthropicRequest({ model: "ep", input: "hello", reasoning: { effort: "1024" } }).body.thinking, { type: "enabled", budget_tokens: 1024 });
  assert.equal(anthropicRequest({ model: "ep", input: "hello" }).body.thinking, undefined);
  assert.deepEqual(anthropicRequest({ model: "ep", input: "hello", reasoning: { effort: "none" } }).body.thinking, { type: "disabled" });
});

test("optional OAuth-hosted search is excluded without dropping callable host functions or claiming search support", () => {
  const request = anthropicRequest({ model: "ep", input: "hello", tools: [{ type: "web_search", external_web_access: true }, tool], tool_choice: "auto" });
  assert.deepEqual(request.body.tools.map((t: any) => t.name), ["echo"]);
  assert.deepEqual(request.body.tool_choice, { type: "auto" });
  const plain = anthropicRequest({ model: "ep", input: "hello", tools: [{ type: "web_search" }] });
  assert.equal(plain.body.tools, undefined);
  assert.equal(plain.body.tool_choice, undefined);
  assert.throws(() => anthropicRequest({ model: "ep", input: "hello", tools: [{ type: "web_search" }], tool_choice: "required" }), /available tool/u);
});

test("image blocks retain their source without fetching local files or accepting URL credentials", () => {
  const request = anthropicRequest({ model: "ep", input: [{ role: "user", content: [
    { type: "input_image", image_url: "data:image/png;base64,YWJj" }, { type: "input_image", image_url: "https://images.test/a.png" }] }] });
  assert.deepEqual(request.body.messages[0].content[0].source, { type: "base64", media_type: "image/png", data: "YWJj" });
  assert.deepEqual(request.body.messages[0].content[1].source, { type: "url", url: "https://images.test/a.png" });
  for (const image_url of ["file:///private/image.png", "https://secret@images.test/a.png", "http://["]) {
    assert.throws(() => anthropicRequest({ model: "ep", input: [{ role: "user", content: [{ type: "input_image", image_url }] }] }), /Unsupported/u);
  }
});

test("nonstream snapshot and downstream cancellation release the upstream reader", async () => {
  const plain = bridge([start, ...text("OK"), ...end()], { streaming: false });
  assert.equal((await plain.response.json()).output[0].content[0].text, "OK");
  let cancelReason: unknown;
  const source = new Response(new ReadableStream({ cancel(reason) { cancelReason = reason; } }), { headers: { "content-type": "text/event-stream" } });
  const response = anthropicResponse(source, "ep", new Map(), true, () => {});
  const reader = response.body!.getReader(), read = reader.read();
  await reader.cancel("client gone"); await read;
  assert.equal(cancelReason, "client gone");
});

test("HTTP provider diagnostics preserve actionable errors while redacting credentials and fixing content type", async () => {
  const response = await anthropicHttpError(new Response(JSON.stringify({ error: { code: "quota", message: "Insufficient credit. key=sk-private-fixture" } }),
    { status: 502, headers: { "content-type": "text/event-stream", "retry-after": "5" } }), "sk-private-fixture", "request-test");
  const body = await response.json();
  assert.equal(response.status, 502); assert.match(response.headers.get("content-type")!, /application\/json/u);
  assert.equal(response.headers.get("retry-after"), "5");
  assert.match(body.error.message, /Insufficient credit/u); assert.doesNotMatch(JSON.stringify(body), /sk-private/u);
  assert.equal(body.error.code, "quota");
  const html = await anthropicHttpError(new Response("<html>private dump</html>", { status: 500 }), undefined, "id");
  assert.doesNotMatch(await html.text(), /private dump/u);
});

test("configured Anthropic route uses only its own credential, no OAuth fallback or automatic retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-anthropic-"));
  const repository = new ModelConfigurationRepository(directory), credentials = new ModelCredentialRepository(directory);
  const pool = new AccountPoolStore({ databasePath: join(directory, "pool.sqlite"), secretsDirectory: join(directory, "secrets") });
  try {
    await credentials.set("ANTHROPIC_FIXTURE", "private-fixture");
    await repository.initialize({ schemaVersion: 1, revision: 0, defaultModel: null, providers: [{ id: "test", name: "Messages", protocol: "anthropic-messages",
      baseUrl: "https://provider.test/prefix/v1", credentialRef: "ANTHROPIC_FIXTURE", enabled: true, models: [{ id: "ep", enabled: true, maxTokens: 2048 }] }] });
    const configured = createConfiguredCodexResponses(directory);
    assert.equal((await configured.catalog())[0].slug, "configured/test/ep");
    let calls = 0;
    const proxy = new CodexAccountPoolProxy({ store: pool, upstreamBaseUrl: "https://oauth.test", configuredResponses: configured,
      fetch: (async (url, options) => {
        calls++; assert.equal(String(url), "https://provider.test/prefix/v1/messages");
        const headers = new Headers(options?.headers);
        assert.equal(headers.get("x-api-key"), "private-fixture"); assert.equal(headers.get("anthropic-version"), "2023-06-01");
        for (const header of ["authorization", "chatgpt-account-id", "x-opencraft-account-pool-token"]) assert.equal(headers.has(header), false);
        const body = JSON.parse(String(options?.body)); assert.equal(body.model, "ep"); assert.equal(body.max_tokens, 2048);
        assert.equal(options?.redirect, "error");
        return upstream([start, ...text("Hello"), ...end()]);
      }) as typeof fetch });
    const make = (input: unknown = "hello") => new Request("http://local/v1/responses", { method: "POST",
      headers: { "x-opencraft-account-pool-token": pool.issueHostToken("local-codex"), authorization: "Bearer private-oauth" },
      body: JSON.stringify({ model: "configured/test/ep", input, stream: true }) });
    const result = await events(await proxy.handle(make()));
    assert.equal(result.at(-1).type, "response.completed"); assert.equal(calls, 1); assert.equal(pool.affinityCount(), 0);
    assert.equal((await proxy.handle(make([{ type: "image_generation_call" }]))).status, 400); assert.equal(calls, 1);
    assert.equal((await repository.read()).defaultModel, null);
  } finally { pool.close(); await rm(directory, { recursive: true, force: true }); }
});

const signed = (thinking: string, signature: string) => ({ type: "reasoning", id: "item_" + signature, summary: [],
  encrypted_content: ANTHROPIC_THINKING_PREFIX + Buffer.from(JSON.stringify({ type: "thinking", thinking, signature })).toString("base64") });

test("history from another protocol keeps its visible turns and drops only unverifiable reasoning", () => {
  const request = anthropicRequest({ model: "ep", input: [{ role: "user", content: "question" },
    { type: "reasoning", id: "rs_openai", summary: [], encrypted_content: "gAAAA-openai" },
    { type: "function_call", id: "fc_openai", name: "echo", call_id: "call", arguments: "{}" },
    { type: "function_call_output", call_id: "call", output: "done" }, { role: "user", content: "next" }], tools: [tool] });
  assert.deepEqual(request.body.messages.map((m: any) => [m.role, m.content.map((b: any) => b.type)]),
    [["user", ["text"]], ["assistant", ["tool_use"]], ["user", ["tool_result", "text"]]]);
});

test("OpenAI dispatch omits Anthropic bridge reasoning and bridge item IDs, and leaves native history untouched", () => {
  const native = { model: "gpt", input: [{ role: "user", content: "q" }, { type: "reasoning", id: "rs_1", encrypted_content: "gAAAA" }] };
  assert.equal(responsesPayloadForOpenAI(native), null);
  const switched = responsesPayloadForOpenAI({ model: "gpt", input: [{ role: "user", content: "q" }, signed("Plan", "sig"),
    { type: "function_call", id: "item_call", name: "echo", call_id: "toolu_1", arguments: "{}" },
    { type: "function_call_output", call_id: "toolu_1", output: "done" },
    { type: "message", id: "item_answer", role: "assistant", content: [{ type: "output_text", text: "Answer" }] }] });
  assert.deepEqual(switched?.input, [{ role: "user", content: "q" },
    { type: "function_call", name: "echo", call_id: "toolu_1", arguments: "{}" }, { type: "function_call_output", call_id: "toolu_1", output: "done" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Answer" }] }]);
});

test("thinking-free resend removes every thinking block and keeps the conversation well formed", () => {
  const body = anthropicRequest({ model: "ep", reasoning: { effort: "medium" }, tools: [tool], input: [{ role: "user", content: "q" },
    signed("", "only"), { role: "user", content: "again" }, signed("Plan", "first"),
    { type: "function_call", name: "echo", call_id: "call", arguments: "{}" }, { type: "function_call_output", call_id: "call", output: "done" }] }).body;
  const stripped = withoutThinkingHistory(body)!;
  assert.deepEqual(stripped.messages.map((m: any) => [m.role, m.content.map((b: any) => b.type)]),
    [["user", ["text", "text"]], ["assistant", ["tool_use"]], ["user", ["tool_result"]]]);
  assert.deepEqual(stripped.thinking, body.thinking);
  assert.equal(body.messages[1].content[0].type, "thinking", "the original request is not mutated");
  assert.equal(withoutThinkingHistory(stripped), null);
});

async function configuredProxy(respond: (body: any, call: number) => Response) {
  const directory = await mkdtemp(join(tmpdir(), "codex-anthropic-"));
  const repository = new ModelConfigurationRepository(directory), credentials = new ModelCredentialRepository(directory);
  const pool = new AccountPoolStore({ databasePath: join(directory, "pool.sqlite"), secretsDirectory: join(directory, "secrets") });
  await credentials.set("ANTHROPIC_FIXTURE", "private-fixture");
  await repository.initialize({ schemaVersion: 1, revision: 0, defaultModel: null, providers: [{ id: "test", name: "Messages", protocol: "anthropic-messages",
    baseUrl: "https://provider.test/v1", credentialRef: "ANTHROPIC_FIXTURE", enabled: true, models: [{ id: "ep", enabled: true }] }] });
  const bodies: any[] = [];
  const proxy = new CodexAccountPoolProxy({ store: pool, upstreamBaseUrl: "https://oauth.test", configuredResponses: createConfiguredCodexResponses(directory),
    fetch: (async (_url, options) => { const body = JSON.parse(String(options?.body)); bodies.push(body); return respond(body, bodies.length); }) as typeof fetch });
  const send = (input: unknown) => proxy.handle(new Request("http://local/v1/responses", { method: "POST",
    headers: { "x-opencraft-account-pool-token": pool.issueHostToken("local-codex") },
    body: JSON.stringify({ model: "configured/test/ep", input, tools: [tool], stream: true }) }));
  return { send, bodies, close: async () => { pool.close(); await rm(directory, { recursive: true, force: true }); } };
}
const signatureRejection = () => Response.json({ type: "error", error: { type: "invalid_request_error",
  message: "Invalid `signature` in `thinking` block: the thinking block was modified Please resend the request without previous thinking blocks." } }, { status: 400 });
const history = [{ role: "user", content: "q" }, signed("Plan", "sig"), { type: "function_call", name: "echo", call_id: "call", arguments: "{}" },
  { type: "function_call_output", call_id: "call", output: "done" }];

test("an unverifiable thinking signature is resent once on the same connection without thinking history", async () => {
  const fixture = await configuredProxy((_body, call) => call === 1 ? signatureRejection() : upstream([start, ...text("Hello"), ...end()]));
  try {
    const result = await events(await fixture.send(history));
    assert.equal(result.at(-1).type, "response.completed"); assert.equal(fixture.bodies.length, 2);
    assert.equal(fixture.bodies[0].messages[1].content[0].type, "thinking");
    assert.deepEqual(fixture.bodies[1].messages[1].content.map((b: any) => b.type), ["tool_use"]);
  } finally { await fixture.close(); }
});

test("a repeated signature rejection or any other provider error is reported without further resends", async () => {
  const repeated = await configuredProxy(() => signatureRejection());
  try {
    const response = await repeated.send(history);
    assert.equal(response.status, 400); assert.match((await response.json()).error.message, /Invalid `signature`/u);
    assert.equal(repeated.bodies.length, 2);
  } finally { await repeated.close(); }
  const other = await configuredProxy(() => Response.json({ error: { type: "invalid_request_error", message: "bad input" } }, { status: 400 }));
  try {
    const response = await other.send(history);
    assert.equal(response.status, 400); assert.match((await response.json()).error.message, /bad input/u);
    assert.equal(other.bodies.length, 1);
  } finally { await other.close(); }
  const thinkingFree = await configuredProxy(() => signatureRejection());
  try {
    assert.equal((await thinkingFree.send("hello")).status, 400); assert.equal(thinkingFree.bodies.length, 1);
  } finally { await thinkingFree.close(); }
});

test("pooled OpenAI requests after a model switch carry no bridge reasoning, even when the client compressed them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-switch-"));
  const pool = new AccountPoolStore({ databasePath: join(directory, "pool.sqlite"), secretsDirectory: join(directory, "secrets") });
  try {
    pool.addAccount({ id: "a", provider: "codex", label: "a", upstreamAccountId: "chatgpt-a", priority: 1, enabled: true },
      { accessToken: "access-a", refreshToken: null, expiresAt: null });
    const seen: { encoding: string | null; body: any }[] = [];
    const proxy = new CodexAccountPoolProxy({ store: pool, upstreamBaseUrl: "https://oauth.test/codex",
      fetch: (async (_url, options) => { const headers = new Headers(options?.headers);
        seen.push({ encoding: headers.get("content-encoding"), body: JSON.parse(new TextDecoder().decode(options?.body as Uint8Array)) });
        return upstream([]); }) as typeof fetch });
    const payload = { model: "gpt-6.1-sol", stream: true, input: [...history,
      { type: "message", id: "item_answer", role: "assistant", content: [{ type: "output_text", text: "Answer" }] }] };
    await proxy.handle(new Request("http://local/v1/responses", { method: "POST",
      headers: { "x-opencraft-account-pool-token": pool.issueHostToken("local-codex"), "content-encoding": "gzip", "content-type": "application/json" },
      body: gzipSync(JSON.stringify(payload)) }));
    assert.equal(seen.length, 1); assert.equal(seen[0].encoding, null);
    assert.equal(seen[0].body.input.some((item: any) => item.type === "reasoning" || String(item.id ?? "").startsWith("item_")), false);
    assert.equal(seen[0].body.input.length, 4);
  } finally { pool.close(); await rm(directory, { recursive: true, force: true }); }
});

test("thinking left behind by an interrupted response is omitted instead of ending an assistant message", () => {
  const atEnd = anthropicRequest({ model: "ep", tools: [tool], input: [{ role: "user", content: "q" }, signed("Plan", "a"),
    { type: "function_call", name: "echo", call_id: "call", arguments: "{}" }, { type: "function_call_output", call_id: "call", output: "done" },
    signed("", "interrupted")] }).body;
  assert.deepEqual(atEnd.messages.map((m: any) => [m.role, m.content.map((b: any) => b.type)]),
    [["user", ["text"]], ["assistant", ["thinking", "tool_use"]], ["user", ["tool_result"]]]);
  const beforeUser = anthropicRequest({ model: "ep", input: [{ role: "user", content: "q" }, signed("", "interrupted"), { role: "user", content: "继续" }] }).body;
  assert.deepEqual(beforeUser.messages.map((m: any) => [m.role, m.content.map((b: any) => b.text ?? b.type)]), [["user", ["q", "继续"]]]);
});

test("an empty visible answer neither reaches Anthropic nor hides thinking at the end of the turn", () => {
  const body = anthropicRequest({ model: "ep", input: [{ role: "user", content: "q" }, signed("Plan", "empty"),
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "" }] }, { role: "user", content: "继续" },
    signed("Plan", "kept"), { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] }, { role: "user", content: "next" }] }).body;
  assert.deepEqual(body.messages.map((m: any) => [m.role, m.content.map((b: any) => b.type)]),
    [["user", ["text", "text"]], ["assistant", ["thinking", "text"]], ["user", ["text"]]]);
});

for (const model of ['claude-opus-5', 'deployment-alias']) test(`Responses assistant history is not a Messages prefill (${model})`, () => {
  const payload = { model, input: [{ role: 'user', content: 'Review the file' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I will check the file.' }] }] };
  const before = structuredClone(payload);
  const first = anthropicRequest(payload).body, second = anthropicRequest(payload).body;
  assert.deepEqual(payload, before, 'transport continuation must not become stored conversation history');
  assert.deepEqual(first, second, 'reconversion does not accumulate continuation cues');
  assert.deepEqual(first.messages.map((m: any) => m.role), ['user', 'assistant', 'user']);
  assert.equal(first.messages[1].content[0].text, 'I will check the file.');
  assert.match(first.messages[2].content[0].text, /^\[Protocol continuation\]/);
  assert.match(first.messages[2].content[0].text, /not a new user request or additional authorization/);
});

test('continuation handles trailing developer, empty text and interrupted thinking without losing history', () => {
  const body = anthropicRequest({ model: 'ep', input: [
    { role: 'user', content: 'Review' }, { role: 'assistant', content: 'Checked the first file.' },
    signed('unfinished', 'interrupted'), { role: 'assistant', content: '' },
    { role: 'developer', content: 'Only review; do not edit files.' },
  ] }).body;
  assert.deepEqual(body.system, [{ type: 'text', text: 'Only review; do not edit files.' }]);
  assert.deepEqual(body.messages[1].content, [{ type: 'text', text: 'Checked the first file.' }]);
  assert.equal(body.messages.at(-1).role, 'user');
  assert.equal(body.messages.length, 3);
  const thinkingOnly = anthropicRequest({ model: 'ep', input: [{ role: 'user', content: 'Review' }, signed('unfinished', 'interrupted')] }).body;
  assert.deepEqual(thinkingOnly.messages, [{ role: 'user', content: [{ type: 'text', text: 'Review' }] }]);
});

test('user input and complete tool-result tails need no continuation cue; missing results remain invalid', () => {
  const ordinary = anthropicRequest({ model: 'ep', input: 'hello' }).body;
  assert.deepEqual(ordinary.messages, [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
  const body = anthropicRequest({ model: 'ep', input: history }).body;
  assert.deepEqual(body.messages.at(-1).content.map((b: any) => b.type), ['tool_result']);
  assert.throws(() => anthropicRequest({ model: 'ep', input: history.slice(0, -1) }), /complete tool results/);
});

test('configured proxy sends a no-prefill continuation once and completes streaming output', async () => {
  const fixture = await configuredProxy(body => body.messages.at(-1).role === 'assistant'
    ? Response.json({ error: { message: 'assistant prefill is not supported; the final message must use role=user' } }, { status: 400 })
    : upstream([start, ...text('Reviewed the file.'), ...end()]));
  try {
    const result = await events(await fixture.send([{ role: 'user', content: 'Review the file' }, { role: 'assistant', content: 'I will check it.' }]));
    assert.equal(result.at(-1).type, 'response.completed');
    assert.equal(fixture.bodies.length, 1, 'no error-driven retry or duplicate execution');
    assert.equal(fixture.bodies[0].messages[1].content[0].text, 'I will check it.');
  } finally { await fixture.close(); }
});

test('thinking-signature fallback retains exactly one continuation cue', async () => {
  const fixture = await configuredProxy((_body, call) => call === 1 ? signatureRejection() : upstream([start, ...text('Done'), ...end()]));
  try {
    const result = await events(await fixture.send([{ role: 'user', content: 'Review' }, signed('Plan', 'sig'), { role: 'assistant', content: 'Checking.' }]));
    assert.equal(result.at(-1).type, 'response.completed');
    assert.equal(fixture.bodies.length, 2);
    for (const body of fixture.bodies) {
      assert.deepEqual(body.messages.map((m: any) => m.role), ['user', 'assistant', 'user']);
      assert.equal(body.messages.at(-1).content.length, 1);
    }
    assert.deepEqual(fixture.bodies[1].messages[1].content, [{ type: 'text', text: 'Checking.' }]);
  } finally { await fixture.close(); }
});

test('Responses passthrough does not acquire an Anthropic continuation cue', async () => {
  const payload = { model: 'ep', input: [{ role: 'user', content: 'Review' }, { role: 'assistant', content: 'Checking.' }] };
  const requests: any[] = [];
  await forwardConfiguredResponses({ configured: { protocol: 'openai-responses', baseUrl: 'https://example.invalid/v1', model: 'ep' },
    payload, publicModel: 'ep', accept: null, signal: AbortSignal.timeout(2000),
    fetch: (async (_url, options) => { requests.push(JSON.parse(String(options?.body))); return Response.json({ id: 'fixture' }); }) as typeof fetch });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].input, payload.input);
});

test("Anthropic default output budget is 32768 while explicit request and model limits keep precedence", () => {
  const base = { model: "alias", input: "fixture" };
  assert.equal(anthropicRequest(base).body.max_tokens, 32768);
  assert.equal(anthropicRequest({ ...base, reasoning: { effort: "high" } }).body.max_tokens, 32768);
  assert.equal(anthropicRequest({ ...base, max_output_tokens: 1024 }).body.max_tokens, 1024);
  assert.equal(anthropicRequest(base, 2048).body.max_tokens, 2048);
  assert.equal(anthropicRequest(base, 65536).body.max_tokens, 65536);
  assert.equal(anthropicRequest({ ...base, max_output_tokens: 65536 }, 16384).body.max_tokens, 16384);
  for (const max_output_tokens of [0, -1, 1.5]) assert.throws(() => anthropicRequest({ ...base, max_output_tokens }), /Invalid output token limit/u);
});

const cached = (body: any) => [...(body.tools ?? []), ...(body.system ?? []), ...body.messages.flatMap((m: any) => m.content)]
  .filter((block: any) => block.cache_control);
const withoutCacheControl = (value: any): any => JSON.parse(JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item));

test("prompt cache breakpoints mark tools, system, the newest message and the previous user turn without changing content", () => {
  const loop = [{ role: "developer", content: "Developer" }, { role: "user", content: "q" }, signed("Plan", "sig"),
    { type: "function_call", name: "echo", call_id: "one", arguments: "{}" }, { type: "function_call_output", call_id: "one", output: "first" },
    signed("Next", "sig2"), { type: "function_call", name: "echo", call_id: "two", arguments: "{}" }, { type: "function_call_output", call_id: "two", output: "second" }];
  const plain = anthropicRequest({ model: "ep", instructions: "Instruction", input: loop, tools: [tool, { ...tool, name: "other" }] }).body;
  assert.equal(cached(plain).length, 0, "the semantic conversion itself stays marker-free");
  const body = withPromptCacheBreakpoints(structuredClone(plain));
  assert.deepEqual(withoutCacheControl(body), plain);
  assert.equal(cached(body).length, 4);
  for (const block of cached(body)) assert.deepEqual(block.cache_control, { type: "ephemeral" });
  assert.equal(body.tools.at(-1).name, "other"); assert.ok(body.tools.at(-1).cache_control); assert.equal(body.tools[0].cache_control, undefined);
  assert.ok(body.system.at(-1).cache_control); assert.equal(body.system[0].cache_control, undefined);
  assert.deepEqual(body.messages.map((m: any) => m.role), ["user", "assistant", "user", "assistant", "user"]);
  assert.equal(body.messages[4].content.at(-1).tool_use_id, "two"); assert.ok(body.messages[4].content.at(-1).cache_control);
  assert.equal(body.messages[2].content.at(-1).tool_use_id, "one"); assert.ok(body.messages[2].content.at(-1).cache_control,
    "the previous request's newest breakpoint stays a cache read for this request");
  for (const message of body.messages) for (const block of message.content)
    if (block.type === "thinking" || block.type === "redacted_thinking") assert.equal(block.cache_control, undefined);
  assert.equal(cached(withPromptCacheBreakpoints(body)).length, 4, "applying twice adds nothing");
  const single = withPromptCacheBreakpoints(anthropicRequest({ model: "ep", input: "hello" }).body);
  assert.deepEqual(cached(single), [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }]);
});

test("configured Anthropic dispatch carries cache breakpoints, including the thinking-free resend", async () => {
  const fixture = await configuredProxy((_body, call) => call === 1 ? signatureRejection() : upstream([start, ...text("Hello"), ...end()]));
  try {
    const result = await events(await fixture.send(history));
    assert.equal(result.at(-1).type, "response.completed"); assert.equal(fixture.bodies.length, 2);
    assert.deepEqual(result.at(-1).response.usage.input_tokens_details, { cached_tokens: 3, cache_write_tokens: 2 });
    for (const body of fixture.bodies) {
      assert.ok(cached(body).length >= 2 && cached(body).length <= 4);
      assert.ok(body.tools.at(-1).cache_control); assert.ok(body.messages.at(-1).content.at(-1).cache_control);
    }
  } finally { await fixture.close(); }
});

test("a context-window overflow becomes context_length_exceeded; streaming callers receive response.failed", async () => {
  const tooLong = () => new Response(JSON.stringify({ error: { type: "upstream_error", code: "400001",
    message: "prompt is too long: 1000846 tokens > 1000000 maximum" } }), { status: 400 });
  const stream = await anthropicHttpError(tooLong(), undefined, "request-overflow", undefined, true);
  assert.equal(stream.status, 200); assert.match(stream.headers.get("content-type")!, /text\/event-stream/u);
  const [failed] = await events(stream);
  assert.equal(failed.type, "response.failed"); assert.equal(failed.response.status, "failed");
  assert.equal(failed.response.error.code, "context_length_exceeded"); assert.match(failed.response.error.message, /prompt is too long/u);
  const json = await anthropicHttpError(tooLong(), undefined, "request-overflow");
  assert.equal(json.status, 400); assert.equal((await json.json()).error.code, "context_length_exceeded");
  for (const message of ["Input is too long for requested model.", "input length and `max_tokens` exceed context limit: 990000 + 32768 > 1000000"]) {
    const response = await anthropicHttpError(Response.json({ error: { message } }, { status: 400 }), undefined, "id", undefined, true);
    assert.equal((await events(response))[0].response.error.code, "context_length_exceeded");
  }
  const unrelated = await anthropicHttpError(Response.json({ error: { code: "400002", message: "bad input" } }, { status: 400 }), undefined, "id", undefined, true);
  assert.equal(unrelated.status, 400); assert.equal((await unrelated.json()).error.code, "400002");
  const server = await anthropicHttpError(Response.json({ error: { message: "prompt is too long" } }, { status: 500 }), undefined, "id", undefined, true);
  assert.equal(server.status, 500, "only a rejected request is a context-budget failure");
  const fixture = await configuredProxy(() => tooLong());
  try {
    const [event] = await events(await fixture.send(history));
    assert.equal(event.type, "response.failed"); assert.equal(event.response.error.code, "context_length_exceeded");
    assert.equal(fixture.bodies.length, 1, "no automatic resend");
  } finally { await fixture.close(); }
});

test("remote compaction produces one durable summary and replays it through Anthropic and OpenAI without leaking the envelope", async () => {
  const fixture = await configuredProxy(body => {
    assert.equal(body.tools, undefined, "summary must not invoke tools");
    assert.match(body.messages.at(-1).content.at(-1).text, /Protocol compaction request/u);
    return upstream([start, ...text("Goal: fix caching. Done: deployed markers. Pending: verify compaction."), ...end()]);
  });
  try {
    const result = await events(await fixture.send([...history, { type: "compaction_trigger" }]));
    assert.equal(result.at(-1).type, "response.completed");
    const checkpoint = result.at(-1).response.output;
    assert.equal(checkpoint.length, 1); assert.equal(checkpoint[0].type, "compaction");
    assert.equal(result.filter(e => e.type === "response.output_item.done").length, 1);
    const input = [...checkpoint, { role: "user", content: "Continue" }];
    const anthropic = anthropicRequest({ model: "ep", input }).body;
    assert.match(anthropic.messages[0].content[0].text, /Done: deployed markers/u);
    assert.equal(JSON.stringify(anthropic).includes("opencraft-anthropic-summary-v1:"), false);
    const openai = responsesPayloadForOpenAI({ model: "gpt", input }) as any;
    assert.match(openai.input[0].content[0].text, /Pending: verify compaction/u);
    assert.equal(JSON.stringify(openai).includes("opencraft-anthropic-summary-v1:"), false);
    assert.deepEqual(input[0], checkpoint[0], "native checkpoint bytes are unchanged");
  } finally { await fixture.close(); }
});

test("incomplete, empty or interrupted compaction never manufactures a checkpoint", async () => {
  for (const records of [[start, ...text("partial"), ...end("max_tokens")], [start, ...end()], [start, ...text("interrupted")]]) {
    const fixture = await configuredProxy(() => upstream(records));
    try {
      const result = await events(await fixture.send([{ role: "user", content: "q" }, { type: "compaction_trigger" }]));
      assert.equal(result.at(-1).type, "response.failed");
      assert.deepEqual(result.at(-1).response.output, []);
      assert.equal(result.some(e => e.type === "response.completed"), false);
    } finally { await fixture.close(); }
  }
});

test("invalid compaction controls and unknown checkpoints fail before dispatch", async () => {
  const fixture = await configuredProxy(() => { throw Error("must not dispatch"); });
  try {
    for (const input of [
      [{ type: "compaction_trigger" }, { role: "user", content: "q" }],
      [{ role: "user", content: "q" }, { type: "compaction_trigger" }, { type: "compaction_trigger" }],
      [{ type: "compaction", encrypted_content: "foreign-provider-state" }, { role: "user", content: "q" }],
      [{ type: "compaction", encrypted_content: "opencraft-anthropic-summary-v1:broken" }, { role: "user", content: "q" }],
    ]) assert.equal((await fixture.send(input)).status, 400);
    assert.equal(fixture.bodies.length, 0);
  } finally { await fixture.close(); }
});

test("assistant text carries Codex MessagePhase from the committed Anthropic stop reason", async () => {
  const toolBlock = (index: number) => [
    { type: "content_block_start", index, content_block: { type: "tool_use", id: "call-" + index, name: "echo", input: {} } },
    { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: '{"value":"a"}' } },
    { type: "content_block_stop", index }];
  const done = async (stream: unknown[]) => {
    const all = await events(bridge(stream).response);
    const messages = all.filter(e => e.type === "response.output_item.done" && e.item.type === "message");
    const final = all.at(-1).response.output.filter((item: any) => item.type === "message");
    assert.deepEqual(final.map((item: any) => item.phase ?? null), messages.map(e => e.item.phase ?? null), "snapshot agrees with item receipts");
    return { all, phases: messages.map(e => e.item.phase ?? null) };
  };
  // Preamble before a tool call is commentary, and its receipt precedes the tool receipt.
  const tooling = await done([start, ...text("Looking", 0), ...toolBlock(1), ...end("tool_use")]);
  assert.deepEqual(tooling.phases, ["commentary"]);
  const order = tooling.all.filter(e => e.type === "response.output_item.done").map(e => e.item.type);
  assert.deepEqual(order, ["message", "function_call"]);
  // A response that ended by itself: closing text is the answer, earlier text is commentary.
  assert.deepEqual((await done([start, ...text("Plan", 0), ...text("Answer", 1), ...end()])).phases, ["commentary", "final_answer"]);
  assert.deepEqual((await done([start, ...text("Answer", 0), ...end("stop_sequence")])).phases, ["final_answer"]);
  // Truncated output stays unknown.
  assert.deepEqual((await done([start, ...text("Partial", 0), ...end("max_tokens")])).phases, [null]);
});
