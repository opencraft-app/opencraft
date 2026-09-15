import assert from "node:assert/strict";
import test from "node:test";

import {
  ChatStreamTranslator,
  OpaqueCodexHistoryError,
  OPAQUE_CODEX_HISTORY_MESSAGE,
  TEXT_ONLY_IMAGE_PLACEHOLDER,
  chatResponseRetryCandidate,
  continuationIntent,
  retryChatRequest,
  responsesToChat,
  translateChatResponse,
} from "../src/services/model-gateway-translate.js";

test("text-only wire projections omit historical images without mutating the Responses input", () => {
  const input = {
    model: "text-model",
    input: [{
      type: "message", role: "user", content: [
        { type: "input_text", text: "remember this" },
        { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
      ],
    }],
  };
  const translated = responsesToChat(input, { supportsImages: false });
  const content = JSON.parse(translated.body).messages[0].content;
  assert.deepEqual(content, [
    { type: "text", text: "remember this" },
    { type: "text", text: TEXT_ONLY_IMAGE_PLACEHOLDER },
  ]);
  assert.equal(input.input[0].content[1].type, "input_image");
});

test("vision-capable wire projections preserve historical images", () => {
  const translated = responsesToChat({
    input: [{
      type: "message", role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }],
    }],
  }, { supportsImages: true });
  assert.deepEqual(JSON.parse(translated.body).messages[0].content, [{
    type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" },
  }]);
});

test("Cordis gateway translates Responses requests and ordinary Chat responses", () => {
  const translated = responsesToChat({
    model: "vendor-model",
    instructions: "be concise",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
  });
  const chat = JSON.parse(translated.body);
  assert.deepEqual(chat.messages.map((message) => message.role), ["system", "user"]);
  assert.equal(chat.messages[1].content[0].text, "hello");
  const response = translateChatResponse({
    id: "chatcmpl_1", model: "vendor-model",
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "world" } }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  }, translated.codec);
  assert.equal(response.status, "completed");
  assert.equal(response.output[0].content[0].text, "world");
  assert.equal(response.usage.input_tokens, 2);
  assert.equal(response.end_turn, true);
});

test("ordinary tools continue while an explicit stop ends the Codex turn", () => {
  const translated = responsesToChat({
    stream: true,
    tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "inspect" }] }],
  });
  const toolStream = new ChatStreamTranslator(translated.codec);
  const toolOutput = toolStream.push(
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"exec_command","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n' +
    "data: [DONE]\n\n",
  );
  assert.match(toolOutput, /"end_turn":false/);
  assert.match(toolOutput, /"type":"function_call"/);

  const textStream = new ChatStreamTranslator(translated.codec);
  const textOutput = textStream.push(
    'data: {"choices":[{"delta":{"content":"Finished."},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n",
  );
  assert.match(textOutput, /"end_turn":true/);
});

test("thinking tool calls preserve reasoning_content across the Responses round trip", () => {
  const translated = responsesToChat({
    stream: true,
    tools: [{ type: "function", name: "bash", parameters: { type: "object" } }],
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "inspect" }] }],
  });
  const stream = new ChatStreamTranslator(translated.codec);
  const output = stream.push(
    'data: {"choices":[{"delta":{"reasoning_content":"I should inspect the environment. "}}]}\n\n' +
    'data: {"choices":[{"delta":{"reasoning_content":"Run env now.","tool_calls":[{"index":0,"id":"call_reasoning","function":{"name":"bash","arguments":"{\\"command\\":\\"env\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n' +
    "data: [DONE]\n\n",
  );
  const completedItems = output.split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)))
    .filter((event) => event.type === "response.output_item.done")
    .map((event) => event.item);
  assert.equal(completedItems[0].type, "reasoning");
  assert.equal(completedItems[0].content[0].text, "I should inspect the environment. Run env now.");
  assert.equal(completedItems[1].type, "function_call");

  const replay = responsesToChat({
    input: [
      ...completedItems,
      { type: "function_call_output", call_id: "call_reasoning", output: "MODEL=deepseek" },
    ],
  });
  const chat = JSON.parse(replay.body);
  assert.equal(chat.messages[0].role, "assistant");
  assert.equal(chat.messages[0].reasoning_content, "I should inspect the environment. Run env now.");
  assert.equal(chat.messages[0].tool_calls[0].id, "call_reasoning");
  assert.equal(chat.messages[1].role, "tool");
});

test("non-streaming thinking tool calls preserve reasoning_content", () => {
  const translated = responsesToChat({ input: "inspect" });
  const response = translateChatResponse({
    id: "chatcmpl_reasoning",
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        reasoning_content: "Need a command.",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } }],
      },
    }],
  }, translated.codec);
  assert.equal(response.output[0].type, "reasoning");
  assert.equal(response.output[0].content[0].text, "Need a command.");
  assert.equal(response.output[1].type, "function_call");
});

test("a stop that only announces future work remains retryable", () => {
  const translated = responsesToChat({ stream: true, input: "inspect" });
  const stream = new ChatStreamTranslator(translated.codec);
  const output = stream.push(
    'data: {"choices":[{"delta":{"content":"让我继续检查构建产物。"},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n",
  );
  assert.doesNotMatch(output, /response\.completed/);
  assert.equal(stream.gatewayRetryReason(), "continuation_intent");
});

test("Hermes trailing continue intent and Chinese full-width colon are retryable", () => {
  for (const text of [
    "Let me now inspect the logs:",
    "I will now verify the build.",
    "Next, I will read the configuration…",
    "接下来我检查日志：",
    "然后读取对应配置：",
    "现在我需要验证构建结果：",
    "MR 3435 不在 opened 列表了，可能已合入/关闭。查全状态：",
    "CTL sgprod manifest 已有 SANDBOX_API_KEY。现在看 Sandbox sgprod manifest 和 sgprod SOPS secrets 是否有该键：",
    "graphify 技能当前不可用，我直接基于仓库文档和代码做深入分析。先读关键分析文档：",
    "当前环境没有 kubectl、没有 tccli，也没有 CLS/Argo 凭据。我确认下有没有仓库封装好的日志查询入口：",
    "有两个 `ctl-runtime` topic！可能查错了一个。两个都查，并验证检索权限：",
    "这三处分别检查，然后比对结果：",
    "剩余配置一并读取：",
    "所有分支逐个测试：",
    "所有 topic 都查不到数据但能列出，很可能是时间戳单位问题。改用微秒重试：",
    "现有策略无效。切换备用端点再跑：",
    "common 组件可能仍然使用占位符。核对 gitops 分支：",
    "这批记录有冲突。复核生产配置：",
    "这跟之前的问题类似。我解密 SOPS 对比两边的实际值：",
    "配置行为不一致。我解析 config.toml 核对 provider：",
    "让我审阅 README 再给结论：",
    "直接读 SSM 对比新加坡 CTL 和 trade 的 token 哈希（不打印明文）：",
    "立即检查生产日志：",
    "重新运行回归门禁：",
    "我需要对比两边的值。找 age 密钥或 trade secret 来源：",
  ]) {
    assert.equal(continuationIntent(text), true, text);
  }
});

test("a trailing colon is a deterministic incomplete-production marker", () => {
  for (const text of [
    "原因如下：",
    "结论有三点:",
    "我总结如下：",
    "直接执行完成：",
    "找到 age 密钥：",
    `${"长响应。".repeat(150)}继续执行：`,
  ]) {
    assert.equal(continuationIntent(text), true, text);
  }
});

test("continue intent stays conservative for deliverables and long replies", () => {
  for (const text of [
    "原因如下：配置正确。",
    "结论有三点：第一项已经完成。",
    "MR 3435 的全状态如下：closed。",
    "以下两项都已验证：测试与构建均通过。",
    "这三处分别已检查完毕：结果一致。",
    "剩余配置全部正常：无需修改。",
    "已经改用微秒重试：查询成功。",
    "备用端点切换完成：请求已恢复。",
    "gitops 分支已核对：配置一致。",
    "生产配置复核完成：可以发布。",
    "我有 3 点建议：先补协议测试。",
    "我认为 API 兼容：现有调用无需迁移。",
    "我总结如下：问题已经解决。",
    "我已经解密 SOPS：两边数值一致。",
    "我刚才解析 config.toml：provider 配置有效。",
    "我的结论是：可以发布。",
    "直接执行完成：命令退出码为 0。",
    "重新运行成功：35 项测试通过。",
    "找到 age 密钥：路径已记录。",
    "查到最终结果：配置一致。",
    "下一步建议补一条回归测试。",
    "I will wait for your confirmation.",
    `${"a".repeat(401)} Let me now inspect the logs.`,
  ]) {
    assert.equal(continuationIntent(text), false, text);
  }
});

test("a stop after changing to another investigation path remains retryable", () => {
  const translated = responsesToChat({ stream: true, input: "inspect" });
  const stream = new ChatStreamTranslator(translated.codec);
  const progress = "iid/全局 id 的详情接口都 Not Found，可能工蜂 MR 详情走别的路径。我改查 MR 的 commits 拿到 sha，再查该 sha 的 CI statuses：";
  const output = stream.push(
    `data: ${JSON.stringify({ choices: [{ delta: { content: progress }, finish_reason: "stop" }] })}\n\n` +
    "data: [DONE]\n\n",
  );
  assert.doesNotMatch(output, /response\.completed/);
  assert.equal(stream.gatewayRetryReason(), "continuation_intent");
});

test("a final recommendation or wait-for-user answer is not mistaken for unfinished work", () => {
  for (const text of ["结论已经明确。下一步建议补一条回归测试。", "I will wait for your confirmation."]) {
    const translated = responsesToChat({ stream: true, input: "inspect" });
    const stream = new ChatStreamTranslator(translated.codec);
    const output = stream.push(
      `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\n` +
      "data: [DONE]\n\n",
    );
    assert.match(output, /response\.completed/);
    assert.equal(stream.gatewayRetryReason(), null);
  }
});

test("missing finish reason without a tool is retried inside the gateway", () => {
  const translated = responsesToChat({ stream: true, input: "inspect" });
  const stream = new ChatStreamTranslator(translated.codec);
  const output = stream.push(
    'data: {"choices":[{"delta":{"content":"I need to inspect next."}}]}\n\n' +
    "data: [DONE]\n\n",
  );
  assert.doesNotMatch(output, /event: response\.completed/);
  assert.equal(stream.needsGatewayRetry(), true);
  const partial = stream.beginGatewayRetry();
  assert.deepEqual(partial, { text: "I need to inspect next.", reasoning: "" });
  const retry = JSON.parse(retryChatRequest(translated.body, partial));
  assert.equal(retry.messages.at(-2).role, "assistant");
  assert.equal(retry.messages.at(-2).content, partial.text);
  assert.equal(retry.messages.at(-1).role, "system");

  const retryOutput = stream.push(
    'data: {"choices":[{"delta":{"content":"Finished."},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n",
  );
  assert.match(retryOutput, /"end_turn":true/);
  assert.deepEqual(stream.terminalSummary(), {
    finishReason: "stop", endTurn: true, status: "completed", toolCalls: 0,
  });
});

test("a second missing finish reason fails closed instead of looping forever", () => {
  const translated = responsesToChat({ stream: true, input: "inspect" });
  const stream = new ChatStreamTranslator(translated.codec);
  stream.push('data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: [DONE]\n\n');
  stream.beginGatewayRetry();
  stream.push('data: {"choices":[{"delta":{"content":"still partial"}}]}\n\ndata: [DONE]\n\n');
  const output = stream.finishMissingReason();
  assert.match(output, /event: response\.incomplete/);
  assert.match(output, /missing_after_gateway_retry/);
});

test("non-streaming Chat responses expose the same bounded retry decision", () => {
  const translated = responsesToChat({ input: "inspect" });
  const first = {
    id: "chatcmpl_1", choices: [{ message: { role: "assistant", content: "I need to inspect." } }],
  };
  assert.deepEqual(chatResponseRetryCandidate(first), {
    retry: true, text: "I need to inspect.", reasoning: "",
  });
  const exhausted = translateChatResponse(first, translated.codec, { missingFinishExhausted: true });
  assert.equal(exhausted.status, "incomplete");
  assert.match(exhausted.incomplete_details.reason, /missing_after_gateway_retry/);
});

test("legacy gateway retries replay provider reasoning content", () => {
  const translated = responsesToChat({ stream: true, input: "inspect" });
  const stream = new ChatStreamTranslator(translated.codec);
  stream.push(
    'data: {"choices":[{"delta":{"reasoning_content":"Need inspect. ","content":"Continuing."}}]}\n\n' +
    "data: [DONE]\n\n",
  );
  const state = stream.beginGatewayRetry();
  assert.deepEqual(state, { text: "Continuing.", reasoning: "Need inspect. " });
  const retry = JSON.parse(retryChatRequest(translated.body, state));
  assert.equal(retry.messages.at(-2).content, "Continuing.");
  assert.equal(retry.messages.at(-2).reasoning_content, "Need inspect. ");
});

test("truncated Chat generations become incomplete Responses", () => {
  const translated = responsesToChat({ stream: true, input: "hello" });
  const stream = new ChatStreamTranslator(translated.codec);
  const output = stream.push(
    'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n' +
    "data: [DONE]\n\n",
  );
  assert.match(output, /event: response\.incomplete/);
  assert.match(output, /"reason":"max_output_tokens"/);
  assert.doesNotMatch(output, /event: response\.completed/);
  assert.equal(stream.gatewayRetryReason(), null);
});

test("Cordis gateway preserves custom tool namespaces across Chat Completions", () => {
  const translated = responsesToChat({
    stream: true,
    input: [
      { type: "additional_tools", tools: [{
        type: "namespace", name: "editor", tools: [
          { type: "custom", name: "apply_patch", description: "patch", format: { type: "grammar" } },
        ],
      }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "change it" }] },
    ],
  });
  const chat = JSON.parse(translated.body);
  assert.equal(chat.tools[0].function.name, "editor__apply_patch");
  const stream = new ChatStreamTranslator(translated.codec);
  const output = stream.push(
    'data: {"id":"chatcmpl_1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"editor__apply_patch","arguments":"{\\"input\\":\\"x\\"}"}}]}}]}\n\n' +
    "data: [DONE]\n\n",
  );
  assert.match(output, /"type":"custom_tool_call"/);
  assert.match(output, /"namespace":"editor"/);
  assert.match(output, /"input":"x"/);
  assert.doesNotMatch(output, /response\.function_call_arguments/);
});

test("opaque OpenAI compaction fails closed with an actionable user message", () => {
  assert.throws(() => responsesToChat({
    input: [{ type: "compaction", encrypted_content: "opaque" }],
  }), (error) => error instanceof OpaqueCodexHistoryError
    && error.message === OPAQUE_CODEX_HISTORY_MESSAGE);
});

test("parallel and interrupted Responses tool calls form a valid Chat transcript", () => {
  const translated = responsesToChat({
    input: [
      { type: "function_call", call_id: "exec:1", name: "exec_command", arguments: "{}" },
      { type: "function_call", call_id: "exec:2", name: "exec_command", arguments: "{}" },
      { type: "function_call_output", call_id: "exec:1", output: "first completed" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ],
  });
  const chat = JSON.parse(translated.body);
  assert.equal(translated.toolTranscriptRepairs, 1);
  assert.deepEqual(chat.messages.map((message) => message.role), [
    "assistant", "tool", "tool", "user",
  ]);
  const callIds = chat.messages[0].tool_calls.map((call) => call.id);
  assert.equal(callIds.length, 2);
  assert.notEqual(callIds[0], callIds[1]);
  assert.ok(callIds.every((callId) => /^[A-Za-z0-9_-]+$/.test(callId)));
  assert.equal(chat.messages[1].tool_call_id, callIds[0]);
  assert.equal(chat.messages[2].tool_call_id, callIds[1]);
  assert.match(chat.messages[2].content, /interrupted/);
});

test("historical Responses tool ids are encoded for strict Chat gateways", () => {
  const translated = responsesToChat({
    model: "ep-model",
    input: [
      {
        type: "function_call",
        id: "exec_command:0",
        call_id: "exec_command:0",
        name: "exec_command",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "exec_command:0",
        output: "done",
      },
    ],
  });
  const body = JSON.parse(translated.body);
  const callId = body.messages[0].tool_calls[0].id;
  assert.match(callId, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(callId, "exec_command:0");
  assert.equal(body.messages[1].tool_call_id, callId);
});

test("Responses tool output content parts become Chat-compatible strings", () => {
  const translated = responsesToChat({
    input: [
      { type: "function_call", call_id: "exec:1", name: "exec_command", arguments: "{}" },
      {
        type: "function_call_output",
        call_id: "exec:1",
        output: [
          { type: "input_text", text: "line one" },
          { type: "output_text", text: "line two" },
        ],
      },
    ],
  });
  const chat = JSON.parse(translated.body);
  assert.equal(chat.messages[1].role, "tool");
  assert.equal(chat.messages[1].tool_call_id, chat.messages[0].tool_calls[0].id);
  assert.match(chat.messages[1].tool_call_id, /^[A-Za-z0-9_-]+$/);
  assert.equal(chat.messages[1].content, "line one\nline two");
});
