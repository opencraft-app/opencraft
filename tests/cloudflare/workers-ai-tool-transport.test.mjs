import assert from "node:assert/strict";
import { test } from "node:test";
import provider from "../../scripts/cloudflare/rehearsal-codex-workers-ai.mjs";

const model = "gpt-oss-20b";
const functionTool = {
  type: "function",
  name: "shared",
  description: "Inspect a receipt",
  parameters: { type: "object" },
};
const tools = [
  { type: "namespace", name: "first", tools: [functionTool] },
  { type: "namespace", name: "second", tools: [functionTool] },
  {
    type: "custom",
    name: "edit",
    description: "Apply an edit",
    format: { type: "grammar", syntax: "lark", definition: 'start: "patch"' },
  },
];
const message = { type: "message", role: "user", content: [{ type: "input_text", text: "Read and edit" }] };
const chunk = (delta, finish_reason = null) => ({ choices: [{ delta, finish_reason }] });

async function run(body, ai) {
  const pending = [];
  const response = await provider.fetch(
    new Request("https://model.test/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer proof" },
      body: JSON.stringify({ model, stream: true, tools, ...body }),
    }),
    {
      REHEARSAL_PROVIDER_PROOF: "proof",
      AI: {
        run(id, input) {
          assert.equal(id, "@cf/openai/gpt-oss-20b");
          const encoder = new TextEncoder();
          return new ReadableStream({
            start(controller) {
              for (const value of ai(input))
                controller.enqueue(encoder.encode("data: " + JSON.stringify(value) + "\n\n"));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          });
        },
      },
    },
    {
      waitUntil(task) {
        pending.push(task);
      },
    },
  );
  assert.equal(response.status, 200);
  const events = (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
  await Promise.all(pending);
  return events;
}

test("namespace collisions and native custom input survive the function stream translation", async () => {
  const events = await run({ input: [message] }, (input) => {
    const [first, second, edit] = input.tools.map((tool) => tool.function.name);
    assert.notEqual(first, second);
    assert.equal(edit, "edit");
    assert.match(input.tools[2].function.parameters.properties.input.description, /start: "patch"/u);
    return [
      chunk({
        tool_calls: [
          { index: 0, id: "call_first", function: { name: first, arguments: '{"part":' } },
          { index: 1, id: "call_edit", function: { name: edit, arguments: '{"input":"p' } },
        ],
      }),
      chunk(
        {
          tool_calls: [
            { index: 1, function: { arguments: 'atch"}' } },
            { index: 0, function: { arguments: "1}" } },
          ],
        },
        "tool_calls",
      ),
    ];
  });
  assert.deepEqual(
    events
      .filter((event) => event.type === "response.output_item.done")
      .map(({ item }) => [item.type, item.name, item.namespace, item.call_id, item.arguments ?? item.input]),
    [
      ["function_call", "shared", "first", "call_first", '{"part":1}'],
      ["custom_tool_call", "edit", undefined, "call_edit", "patch"],
    ],
  );
});

test("a parallel native tool history replays both outputs and preserves streamed text", async () => {
  const events = await run(
    {
      input: [
        message,
        { type: "function_call", name: "shared", namespace: "second", call_id: "call_second", arguments: "{}" },
        { type: "custom_tool_call", name: "edit", call_id: "call_edit", input: "patch" },
        { type: "custom_tool_call_output", call_id: "call_edit", output: "changed" },
        { type: "function_call_output", call_id: "call_second", output: "found" },
      ],
    },
    (input) => {
      const [user, assistant, edit, read] = input.messages;
      assert.equal(user.content, "Read and edit");
      assert.equal(assistant.content, "");
      assert.deepEqual(
        assistant.tool_calls.map((call) => [call.id, call.function.name, call.function.arguments]),
        [
          ["call_second", input.tools[1].function.name, "{}"],
          ["call_edit", input.tools[2].function.name, '{"input":"patch"}'],
        ],
      );
      assert.deepEqual(
        [edit, read],
        [
          { role: "tool", tool_call_id: "call_edit", content: "changed" },
          { role: "tool", tool_call_id: "call_second", content: "found" },
        ],
      );
      return [chunk({ content: "Read" }), chunk({ content: " and changed" }, "stop")];
    },
  );
  assert.deepEqual(
    events.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta),
    ["Read", " and changed"],
  );
  assert.equal(events.at(-1).type, "response.completed");
});

test("freeform input remains byte-for-byte intact when the model names its single wrapper field differently", async () => {
  const raw = "first line\n  second line\n";
  const events = await run({ input: [message] }, () => [
    chunk(
      {
        tool_calls: [
          {
            index: 0,
            id: "call_raw",
            function: {
              name: "edit",
              arguments: JSON.stringify({ content: raw }),
            },
          },
        ],
      },
      "tool_calls",
    ),
  ]);
  assert.equal(events.find((event) => event.type === "response.custom_tool_call_input.done").input, raw);
  assert.equal(events.at(-1).type, "response.completed");
});

test("a native notification cannot split a tool call from its result in Chat Completions history", async () => {
  const notice = { role: "user", content: "<subagent_notification>completed</subagent_notification>" };
  const events = await run(
    {
      input: [
        message,
        { type: "function_call", name: "shared", namespace: "second", call_id: "call_wait", arguments: "{}" },
        { type: "message", ...notice },
        { type: "function_call_output", call_id: "call_wait", output: "completed" },
      ],
    },
    ({ messages }) => {
      assert.deepEqual(
        messages.map((entry) => entry.role),
        ["user", "assistant", "tool", "user"],
      );
      assert.equal(messages[2].tool_call_id, "call_wait");
      assert.deepEqual(messages[3], notice);
      return [chunk({ content: "Confirmed" }, "stop")];
    },
  );
  assert.equal(events.at(-1).type, "response.completed");
});
