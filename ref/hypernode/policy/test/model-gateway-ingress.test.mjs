import assert from "node:assert/strict";
import test from "node:test";

import { ModelGatewayIngressService } from "../src/services/model-gateway-ingress.js";
import { OPAQUE_CODEX_HISTORY_MESSAGE } from "../src/services/model-gateway-translate.js";
import { INTERNAL_FINISH_TOOL_NAME } from "../src/services/model-native-finish.js";

globalThis.hostEvents ??= { notify() {} };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function request(body, path = "/providers/kimi/v1/responses", headers = []) {
  const payload = JSON.stringify(body);
  return encoder.encode([
    `POST ${path} HTTP/1.1`,
    "Authorization: Bearer secret",
    "Content-Type: application/json",
    ...headers,
    `Content-Length: ${encoder.encode(payload).length}`,
    "",
    payload,
  ].join("\r\n"));
}

test("Pi AI Chat Completions requests and SSE are forwarded byte-for-byte", () => {
  const first = 'data: {"id":"chat_1","choices":[{"delta":{"reasoning_content":"思考","content":"你"},"finish_reason":null}]}\n\n';
  const terminal = 'data: {"id":"chat_1","choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const drains = [
    { status: 200, dataBytes: encoder.encode(first), closed: false },
    { status: 200, dataBytes: encoder.encode(terminal), closed: false },
  ];
  const { service, upstreamCalls, upstreamCloses } = createHarness(drains, {
    endpoint: "https://tokenhub.tencentmaas.com/plan/v3/chat/completions",
    apiProtocol: "openai-completions",
  });
  const metadata = { connectionId: "transparent-chat-stream" };
  const body = {
    model: "ep-xodwa4gc",
    stream: true,
    messages: [{
      role: "assistant", content: "继续", reasoning_content: "原始思考",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } }],
    }, { role: "tool", tool_call_id: "call_1", content: "ok" }],
    vendor_extension: { untouched: true },
  };
  const serialized = JSON.stringify(body);
  service.open(metadata);
  service.data({
    ...metadata,
    dataBytes: request(body, "/providers/kimi/v1/chat/completions", [
      "X-Provider-Feature: preserved",
      "Connection: keep-alive",
    ]),
  });

  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0][1].url, "https://tokenhub.tencentmaas.com/plan/v3/chat/completions");
  assert.equal(upstreamCalls[0][1].body, serialized);
  assert.equal(upstreamCalls[0][1].headers["x-provider-feature"], "preserved");
  assert.equal(upstreamCalls[0][1].headers.connection, undefined);
  const partial = decoder.decode(Uint8Array.from(service.poll(metadata).stdoutBytes));
  assert.equal(partial.split("\r\n\r\n", 2)[1], first);
  const completed = service.poll(metadata);
  assert.equal(decoder.decode(Uint8Array.from(completed.stdoutBytes)), terminal);
  assert.equal(completed.closeAfterWrite, true);
  assert.deepEqual(upstreamCloses, ["model-gateway:transparent-chat-stream:1"]);
});

function expectContinueRequest(body) {
  const payload = JSON.stringify(body);
  return {
    head: encoder.encode([
      "POST /providers/kimi/v1/responses HTTP/1.1",
      "Authorization: Bearer secret",
      "Content-Type: application/json",
      "Expect: 100-continue",
      `Content-Length: ${encoder.encode(payload).length}`,
      "",
      "",
    ].join("\r\n")),
    body: encoder.encode(payload),
  };
}

function createHarness(drains = [], route = { endpoint: "https://example.test/chat/completions" }) {
  const upstreamCalls = [];
  const upstreamCloses = [];
  const service = Object.create(ModelGatewayIngressService.prototype);
  service.connections = new Map();
  service.ctx = {
    modelGateway: { resolveGatewayRoute() { return route; } },
    httpClient: {
      open(...args) { upstreamCalls.push(args); },
      close(requestId) { upstreamCloses.push(requestId); },
      drain() {
        if (drains.length === 0) throw new Error("unexpected drain");
        return drains.shift();
      },
    },
  };
  return { service, upstreamCalls, upstreamCloses };
}

test("invalid model gateway routes report the rejected method and target", () => {
  const { service, upstreamCalls } = createHarness();
  const metadata = { connectionId: "invalid-route" };
  service.open(metadata);

  const result = service.data({
    ...metadata,
    dataBytes: request({ model: "k3" }, "/providers/kimi/v1/not-a-real-operation"),
  });
  const wire = decoder.decode(Uint8Array.from(result.stdoutBytes));

  assert.match(wire, /^HTTP\/1\.1 404 Not Found\r\n/);
  assert.match(wire, /model gateway route not found: POST \/providers\/kimi\/v1\/not-a-real-operation/);
  assert.deepEqual(upstreamCalls, []);
});

test("upstream errors preserve the provider response and log their sanitized endpoint", () => {
  const upstreamBody = '{"error":{"message":"not found"}}';
  const { service } = createHarness([
    { status: 404, dataBytes: encoder.encode(upstreamBody), closed: true },
  ], {
    endpoint: "https://secret@example.test/v1/chat/completions?api_key=hidden",
    apiProtocol: "openai-completions",
  });
  const metadata = { connectionId: "upstream-not-found" };
  const warnings = [];
  const previousWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    service.open(metadata);
    service.data({
      ...metadata,
      dataBytes: request({ model: "k3" }, "/providers/kimi/v1/chat/completions"),
    });
    const wire = decoder.decode(Uint8Array.from(service.poll(metadata).stdoutBytes));
    assert.match(wire, /^HTTP\/1\.1 404 Not Found\r\n/);
    assert.equal(wire.split("\r\n\r\n", 2)[1], upstreamBody);
  } finally {
    console.warn = previousWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /provider=kimi status=404/);
  assert.match(warnings[0], /endpoint=https:\/\/<redacted>@example\.test\/v1\/chat\/completions/);
  assert.doesNotMatch(warnings[0], /secret|api_key|hidden/);
});

test("native Responses streaming is forwarded byte-for-byte and closes on its terminal event", () => {
  const first = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你"}\n\n';
  const terminal = 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n';
  const drains = [
    { status: 200, dataBytes: encoder.encode(first), closed: false },
    { status: 200, dataBytes: encoder.encode(terminal), closed: false },
  ];
  const { service, upstreamCalls, upstreamCloses } = createHarness(drains, {
    endpoint: "https://tokenhub.tencentmaas.com/v1/responses",
    apiProtocol: "openai-responses",
  });
  const metadata = { connectionId: "native-responses-stream" };
  const originalBody = {
    model: "ep-xodwa4gc",
    stream: true,
    input: [{ type: "message", role: "user", content: "你好" }],
  };
  service.open(metadata);
  service.data({ ...metadata, dataBytes: request(originalBody) });

  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0][1].url, "https://tokenhub.tencentmaas.com/v1/responses");
  assert.deepEqual(JSON.parse(upstreamCalls[0][1].body), originalBody);
  const partial = decoder.decode(Uint8Array.from(service.poll(metadata).stdoutBytes));
  assert.equal(partial.split("\r\n\r\n", 2)[1], first);
  assert.equal(service.connections.get(metadata.connectionId).done, false);

  const terminalDecision = service.poll(metadata);
  const completed = decoder.decode(Uint8Array.from(terminalDecision.stdoutBytes));
  assert.equal(completed, terminal);
  assert.equal(terminalDecision.closeAfterWrite, true);
  assert.equal(service.connections.get(metadata.connectionId).done, true);
  assert.deepEqual(upstreamCloses, ["model-gateway:native-responses-stream:1"]);
});

test("TokenHub K3 zero-tool completion is resampled until its hidden finish tool is called", () => {
  const progressResponse = {
    id: "resp_progress", object: "response", status: "completed", model: "ep-xodwa4gc",
    output: [{
      id: "msg_progress", type: "message", status: "completed", role: "assistant",
      content: [{ type: "output_text", text: "I will inspect next.", annotations: [] }],
    }],
  };
  const finishResponse = {
    id: "resp_finish", object: "response", status: "completed", model: "ep-xodwa4gc",
    output: [{
      id: "fc_finish", type: "function_call", status: "completed",
      name: INTERNAL_FINISH_TOOL_NAME, call_id: "finish_1",
      arguments: JSON.stringify({ answer: "Inspection complete." }),
    }],
  };
  const sse = (response) =>
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`;
  const drains = [
    { status: 200, dataBytes: encoder.encode(sse(progressResponse)), closed: false },
    { status: 200, dataBytes: encoder.encode(sse(finishResponse)), closed: false },
  ];
  const { service, upstreamCalls, upstreamCloses } = createHarness(drains, {
    endpoint: "https://tokenhub.tencentmaas.com/v1/responses",
    apiProtocol: "openai-responses",
    sanitizeResponseIds: true,
    internalFinishTool: true,
  });
  const metadata = { connectionId: "native-hidden-finish" };
  service.open(metadata);
  service.data({
    ...metadata,
    dataBytes: request({ model: "ep-xodwa4gc", stream: true, input: "inspect" }),
  });

  const firstBody = JSON.parse(upstreamCalls[0][1].body);
  assert.ok(firstBody.tools.some((tool) => tool.name === INTERNAL_FINISH_TOOL_NAME));
  assert.match(firstBody.instructions, new RegExp(INTERNAL_FINISH_TOOL_NAME));
  const progress = decoder.decode(Uint8Array.from(service.poll(metadata).stdoutBytes));
  assert.equal(progress, "");
  assert.equal(upstreamCalls.length, 2);
  const retryBody = JSON.parse(upstreamCalls[1][1].body);
  assert.equal(retryBody.input.at(-2).role, "assistant");
  assert.equal(retryBody.input.at(-1).role, "developer");
  assert.equal(service.connections.get(metadata.connectionId).done, false);

  const terminalDecision = service.poll(metadata);
  const terminal = decoder.decode(Uint8Array.from(terminalDecision.stdoutBytes));
  assert.match(terminal, /^HTTP\/1\.1 200 OK\r\n/);
  assert.match(terminal, /Inspection complete\./);
  assert.match(terminal, /event: response\.completed/);
  assert.doesNotMatch(terminal, new RegExp(INTERNAL_FINISH_TOOL_NAME));
  assert.equal(terminalDecision.closeAfterWrite, true);
  assert.equal(service.connections.get(metadata.connectionId).done, true);
  assert.deepEqual(upstreamCloses, [
    "model-gateway:native-hidden-finish:1",
    "model-gateway:native-hidden-finish:2",
  ]);
});

test("TokenHub K3 real work calls pass through while the finish tool stays request-private", () => {
  const terminal = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_tools","status":"completed","output":[{"type":"function_call","id":"fc_exec","call_id":"exec_1","name":"exec_command","arguments":"{}"}]}}\n\n';
  const drains = [{ status: 200, dataBytes: encoder.encode(terminal), closed: false }];
  const { service, upstreamCalls } = createHarness(drains, {
    endpoint: "https://tokenhub.tencentmaas.com/v1/responses",
    apiProtocol: "openai-responses",
    sanitizeResponseIds: true,
    internalFinishTool: true,
  });
  const metadata = { connectionId: "native-real-tool" };
  service.open(metadata);
  service.data({
    ...metadata,
    dataBytes: request({
      model: "ep-xodwa4gc", stream: true, input: "inspect",
      tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
    }),
  });

  assert.ok(JSON.parse(upstreamCalls[0][1].body).tools
    .some((tool) => tool.name === INTERNAL_FINISH_TOOL_NAME));
  const wire = decoder.decode(Uint8Array.from(service.poll(metadata).stdoutBytes));
  assert.match(wire, /"name":"exec_command"/);
  assert.doesNotMatch(wire, new RegExp(INTERNAL_FINISH_TOOL_NAME));
  assert.equal(service.connections.get(metadata.connectionId).done, true);
});

test("TokenHub K3 non-streaming completions use the same hidden finish contract", () => {
  const progress = JSON.stringify({
    id: "resp_progress", status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Soon." }] }],
  });
  const finish = JSON.stringify({
    id: "resp_finish", status: "completed",
    output: [{
      type: "function_call", name: INTERNAL_FINISH_TOOL_NAME,
      call_id: "finish_1", arguments: JSON.stringify({ answer: "Done." }),
    }],
  });
  const drains = [
    { status: 200, dataBytes: encoder.encode(progress), closed: true },
    { status: 200, dataBytes: encoder.encode(finish), closed: true },
  ];
  const { service, upstreamCalls } = createHarness(drains, {
    endpoint: "https://tokenhub.tencentmaas.com/v1/responses",
    apiProtocol: "openai-responses",
    sanitizeResponseIds: true,
    internalFinishTool: true,
  });
  const metadata = { connectionId: "native-hidden-finish-json" };
  service.open(metadata);
  service.data({ ...metadata, dataBytes: request({ model: "ep-xodwa4gc", input: "inspect" }) });

  assert.equal(decoder.decode(Uint8Array.from(service.poll(metadata).stdoutBytes)), "");
  assert.equal(upstreamCalls.length, 2);
  const wire = decoder.decode(Uint8Array.from(service.poll(metadata).stdoutBytes));
  const body = JSON.parse(wire.split("\r\n\r\n", 2)[1]);
  assert.equal(body.output[0].content[0].text, "Done.");
  assert.doesNotMatch(JSON.stringify(body), new RegExp(INTERNAL_FINISH_TOOL_NAME));
});

test("native non-streaming Responses JSON is returned without translation", () => {
  const upstreamBody = '{"id":"resp_native","status":"completed","output":[{"type":"message"}]}';
  const drains = [{ status: 200, dataBytes: encoder.encode(upstreamBody), closed: true }];
  const { service, upstreamCalls } = createHarness(drains, {
    endpoint: "https://tokenhub.tencentmaas.com/v1/responses",
    apiProtocol: "openai-responses",
  });
  const metadata = { connectionId: "native-responses-json" };
  service.open(metadata);
  service.data({ ...metadata, dataBytes: request({ model: "ep-xodwa4gc", input: "hello" }) });

  const wire = decoder.decode(Uint8Array.from(service.poll(metadata).stdoutBytes));
  assert.equal(wire.split("\r\n\r\n", 2)[1], upstreamBody);
  assert.equal(upstreamCalls.length, 1);
  assert.equal(service.connections.get(metadata.connectionId).done, true);
});

test("known native compatibility repairs split streaming ids and matching request history", () => {
  const terminal =
    'event: response.output_item.done\r\ndata: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_exec_command:0","call_id":"exec_command:0","arguments":"{}"}}\r\n\r\n' +
    'event: response.completed\r\ndata: {"type":"response.completed","response":{"status":"completed","output":[{"type":"function_call","id":"fc_exec_command:0","call_id":"exec_command:0","arguments":"{}"}]}}\r\n\r\n';
  const bytes = encoder.encode(terminal);
  const split = Math.floor(bytes.length / 2);
  const drains = [
    { status: 200, dataBytes: bytes.slice(0, split), closed: false },
    { status: 200, dataBytes: bytes.slice(split), closed: false },
  ];
  const { service, upstreamCalls } = createHarness(drains, {
    endpoint: "https://tokenhub.tencentmaas.com/v1/responses",
    apiProtocol: "openai-responses",
    sanitizeResponseIds: true,
  });
  const metadata = { connectionId: "native-id-compatibility" };
  service.open(metadata);
  service.data({
    ...metadata,
    dataBytes: request({
      model: "ep-xodwa4gc",
      stream: true,
      input: [
        { type: "function_call", id: "fc_old:0", call_id: "old:0", name: "exec_command", arguments: "{}" },
        { type: "function_call_output", call_id: "old:0", output: "ok" },
      ],
    }),
  });

  assert.doesNotMatch(upstreamCalls[0][1].body, /fc_old:0|old:0/);
  const first = decoder.decode(Uint8Array.from(service.poll(metadata).stdoutBytes));
  const second = decoder.decode(Uint8Array.from(service.poll(metadata).stdoutBytes));
  const wire = `${first}${second}`;
  assert.match(wire, /event: response\.completed/);
  assert.doesNotMatch(wire, /fc_exec_command:0|exec_command:0/);
  assert.match(wire, /"call_id":"hn_exec_command_0_/);
  assert.equal(service.connections.get(metadata.connectionId).nativeIdRepairs, 7);
  assert.equal(service.connections.get(metadata.connectionId).done, true);
});

test("SSE DONE completes a tool response without waiting for HTTP transport close", () => {
  const body =
    'data: {"id":"chatcmpl_keepalive","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_keepalive","function":{"name":"exec_command","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n' +
    "data: [DONE]\n\n";
  const drains = [{ status: 200, dataBytes: encoder.encode(body), closed: false }];
  const { service, upstreamCloses } = createHarness(drains);
  const metadata = { connectionId: "semantic-done-keepalive" };
  service.open(metadata);
  service.data({
    ...metadata,
    dataBytes: request({
      stream: true,
      tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
      input: [{ type: "message", role: "user", content: "inspect" }],
    }),
  });

  const terminal = decoder.decode(Uint8Array.from(service.poll(metadata).stdoutBytes));
  assert.match(terminal, /event: response\.completed/);
  assert.match(terminal, /"end_turn":false/);
  assert.equal(service.connections.get(metadata.connectionId).done, true);
  assert.deepEqual(upstreamCloses, ["model-gateway:semantic-done-keepalive:1"]);
});

test("an explicit stop after announcing more work is continued inside the gateway", () => {
  const first =
    'data: {"id":"chatcmpl_1","choices":[{"delta":{"content":"让我检查生产构建产物。"},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n";
  const second =
    'data: {"id":"chatcmpl_2","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"exec_command","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n' +
    "data: [DONE]\n\n";
  const drains = [
    { status: 200, dataBytes: encoder.encode(first), closed: false },
    { status: 200, dataBytes: encoder.encode(second), closed: false },
  ];
  const { service, upstreamCalls } = createHarness(drains);
  const metadata = { connectionId: "continuation-intent" };
  service.open(metadata);
  service.data({
    ...metadata,
    dataBytes: request({
      stream: true,
      tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
      input: [{ type: "message", role: "user", content: "inspect" }],
    }),
  });

  const partial = decoder.decode(Uint8Array.from(service.poll(metadata).stdoutBytes));
  assert.match(partial, /让我检查生产构建产物/);
  assert.doesNotMatch(partial, /response\.completed/);
  assert.equal(upstreamCalls.length, 2);
  const retry = JSON.parse(upstreamCalls[1][1].body);
  assert.match(retry.messages.at(-1).content, /announced more work/);

  const terminal = decoder.decode(Uint8Array.from(service.poll(metadata).stdoutBytes));
  assert.match(terminal, /"type":"function_call"/);
  assert.match(terminal, /"end_turn":false/);
  assert.equal(service.connections.get(metadata.connectionId).done, true);
});

test("missing Chat finish reason is retried upstream inside one Responses stream", () => {
  const first =
    'data: {"id":"chatcmpl_1","choices":[{"delta":{"content":"I need to inspect next."}}]}\n\n' +
    "data: [DONE]\n\n";
  const second =
    'data: {"id":"chatcmpl_2","choices":[{"delta":{"content":"Finished."},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n";
  const drains = [
    { status: 200, dataBytes: encoder.encode(first), closed: true },
    { status: 200, dataBytes: encoder.encode(second), closed: true },
  ];
  const { service, upstreamCalls } = createHarness(drains);
  const metadata = { connectionId: "missing-finish-retry" };
  service.open(metadata);
  service.data({
    ...metadata,
    dataBytes: request({ stream: true, input: [{ type: "message", role: "user", content: "inspect" }] }),
  });

  const partial = decoder.decode(Uint8Array.from(service.poll(metadata).stdoutBytes));
  assert.match(partial, /^HTTP\/1\.1 200 OK\r\n/);
  assert.match(partial, /I need to inspect next/);
  assert.doesNotMatch(partial, /response\.completed/);
  assert.equal(upstreamCalls.length, 2);
  const retryBody = JSON.parse(upstreamCalls[1][1].body);
  assert.equal(retryBody.messages.at(-2).role, "assistant");
  assert.equal(retryBody.messages.at(-2).content, "I need to inspect next.");

  const terminal = decoder.decode(Uint8Array.from(service.poll(metadata).stdoutBytes));
  assert.match(terminal, /Finished/);
  assert.match(terminal, /"end_turn":true/);
  assert.equal(service.connections.get(metadata.connectionId).done, true);
});

test("opaque Codex history terminates a streaming Responses turn without contacting upstream", () => {
  const { service, upstreamCalls } = createHarness();
  const metadata = { connectionId: "opaque-stream" };
  service.open(metadata);

  const result = service.data({
    ...metadata,
    dataBytes: request({
      stream: true,
      input: [{ type: "compaction", encrypted_content: "opaque" }],
    }),
  });
  const wire = decoder.decode(Uint8Array.from(result.stdoutBytes));

  assert.match(wire, /^HTTP\/1\.1 200 OK\r\n/);
  assert.match(wire, /Content-Type: text\/event-stream/);
  assert.match(wire, /event: response\.failed/);
  const event = JSON.parse(wire.match(/data: (\{.*\})\n\n/s)?.[1]);
  assert.equal(event.type, "response.failed");
  assert.equal(event.response.status, "failed");
  assert.equal(event.response.error.code, "invalid_prompt");
  assert.equal(event.response.error.message, OPAQUE_CODEX_HISTORY_MESSAGE);
  assert.equal(service.connections.get(metadata.connectionId).done, true);
  assert.deepEqual(upstreamCalls, []);
});

test("large Codex requests receive 100 Continue before the gateway waits for their body", () => {
  const { service, upstreamCalls } = createHarness();
  const metadata = { connectionId: "opaque-expect-continue" };
  const split = expectContinueRequest({
    stream: true,
    input: [{ type: "compaction", encrypted_content: "opaque" }],
  });
  service.open(metadata);

  const interim = service.data({ ...metadata, dataBytes: split.head });
  assert.equal(decoder.decode(Uint8Array.from(interim.stdoutBytes)), "HTTP/1.1 100 Continue\r\n\r\n");
  assert.equal(service.connections.get(metadata.connectionId).done, false);
  assert.deepEqual(upstreamCalls, []);

  const terminal = service.data({ ...metadata, dataBytes: split.body });
  const wire = decoder.decode(Uint8Array.from(terminal.stdoutBytes));
  assert.match(wire, /^HTTP\/1\.1 200 OK\r\n/);
  assert.match(wire, /event: response\.failed/);
  assert.match(wire, /"code":"invalid_prompt"/);
  assert.equal(service.connections.get(metadata.connectionId).done, true);
  assert.deepEqual(upstreamCalls, []);
});

test("100 Continue is emitted at most once while a request body remains incomplete", () => {
  const { service } = createHarness();
  const metadata = { connectionId: "expect-continue-once" };
  const split = expectContinueRequest({
    stream: true,
    input: [{ type: "message", role: "user", content: "hello" }],
  });
  service.open(metadata);

  const first = service.data({ ...metadata, dataBytes: split.head });
  const second = service.data({ ...metadata, dataBytes: [] });
  assert.equal(decoder.decode(Uint8Array.from(first.stdoutBytes)), "HTTP/1.1 100 Continue\r\n\r\n");
  assert.equal(Uint8Array.from(second.stdoutBytes).length, 0);
});

test("opaque Codex history returns a failed Responses object for non-streaming clients", () => {
  const { service, upstreamCalls } = createHarness();
  const metadata = { connectionId: "opaque-json" };
  service.open(metadata);

  const result = service.data({
    ...metadata,
    dataBytes: request({ input: [{ type: "compaction", encrypted_content: "opaque" }] }),
  });
  const wire = decoder.decode(Uint8Array.from(result.stdoutBytes));
  const body = JSON.parse(wire.split("\r\n\r\n", 2)[1]);

  assert.match(wire, /^HTTP\/1\.1 200 OK\r\n/);
  assert.equal(body.status, "failed");
  assert.equal(body.error.code, "invalid_prompt");
  assert.equal(body.error.message, OPAQUE_CODEX_HISTORY_MESSAGE);
  assert.deepEqual(upstreamCalls, []);
});

test("ordinary malformed Responses input remains an HTTP 400", () => {
  const { service, upstreamCalls } = createHarness();
  const metadata = { connectionId: "ordinary-bad-input" };
  service.open(metadata);

  const result = service.data({
    ...metadata,
    dataBytes: request({ stream: true, input: [{ type: "unknown_hypernode_test_item" }] }),
  });
  const wire = decoder.decode(Uint8Array.from(result.stdoutBytes));

  assert.match(wire, /^HTTP\/1\.1 400 Bad Request\r\n/);
  assert.doesNotMatch(wire, /response\.failed/);
  assert.deepEqual(upstreamCalls, []);
});

test("model gateway tracing propagates W3C context and closes at the semantic terminal", () => {
  const calls = [];
  const previous = globalThis.hostTelemetry;
  globalThis.hostTelemetry = {
    enabled: true,
    startSpan(name, attributes, parent) {
      calls.push(["start", name, attributes, parent]);
      return { enabled: true, handle: "span-1", traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01" };
    },
    addEvent(handle, name, attributes) { calls.push(["event", handle, name, attributes]); },
    endSpan(handle, status) { calls.push(["end", handle, status]); },
  };
  try {
    const terminal = 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n';
    const { service, upstreamCalls } = createHarness([
      { status: 200, dataBytes: encoder.encode(terminal), closed: false },
    ], {
      endpoint: "https://tokenhub.tencentmaas.com/v1/responses",
      apiProtocol: "openai-responses",
    });
    const metadata = { connectionId: "traced-native" };
    service.open(metadata);
    service.data({ ...metadata, dataBytes: request({ model: "k3", stream: true, input: "test" }) });
    service.poll(metadata);

    assert.equal(upstreamCalls[0][1].telemetry.traceparent,
      "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01");
    assert.ok(calls.some((entry) => entry[0] === "event" && entry[2] === "gateway.drain.first"));
    assert.ok(calls.some((entry) => entry[0] === "event" && entry[2] === "gateway.terminal"));
    assert.deepEqual(calls.at(-1), ["end", "span-1", "ok"]);
  } finally {
    if (previous === undefined) delete globalThis.hostTelemetry;
    else globalThis.hostTelemetry = previous;
  }
});
