import assert from "node:assert/strict";
import test from "node:test";

import {
  INTERNAL_FINISH_TOOL_NAME,
  decideNativeFinish,
  nativeFinalResponse,
  nativeFinalSSE,
  parseNativeTerminalSSE,
  prepareNativeFinishRequest,
  retryNativeFinishRequest,
} from "../src/services/model-native-finish.js";

test("TokenHub K3 receives a private finish tool and deterministic contract", () => {
  const body = JSON.parse(prepareNativeFinishRequest({
    model: "ep-xodwa4gc",
    instructions: "Work carefully.",
    input: "inspect",
    tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
  }));
  assert.deepEqual(body.tools.map((tool) => tool.name), ["exec_command", INTERNAL_FINISH_TOOL_NAME]);
  assert.match(body.instructions, /Work carefully/);
  assert.match(body.instructions, /ordinary assistant text/i);
  assert.deepEqual(body.tools.at(-1).parameters.required, ["answer"]);
});

test("the private finish tool remains selectable without broadening a forced work tool", () => {
  const none = JSON.parse(prepareNativeFinishRequest({ input: "inspect", tool_choice: "none" }));
  assert.equal(none.tool_choice, "auto");

  const allowed = JSON.parse(prepareNativeFinishRequest({
    input: "inspect",
    tool_choice: {
      type: "allowed_tools", mode: "auto",
      tools: [{ type: "function", name: "exec_command" }],
    },
  }));
  assert.deepEqual(allowed.tool_choice.tools.map((tool) => tool.name), [
    "exec_command", INTERNAL_FINISH_TOOL_NAME,
  ]);

  const forced = JSON.parse(prepareNativeFinishRequest({
    input: "inspect", tool_choice: { type: "function", name: "exec_command" },
  }));
  assert.deepEqual(forced.tool_choice, { type: "function", name: "exec_command" });
});

test("a completed native message retries while the private finish tool terminates", () => {
  const progress = {
    id: "resp_progress", status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Starting." }] }],
  };
  const progressDecision = decideNativeFinish(progress);
  assert.equal(progressDecision.kind, "retry");
  const retry = JSON.parse(retryNativeFinishRequest(
    prepareNativeFinishRequest({ input: "inspect" }),
    progress,
    progressDecision,
  ));
  assert.equal(retry.input.at(-2).role, "assistant");
  assert.equal(retry.input.at(-1).role, "developer");
  assert.match(retry.input.at(-1).content[0].text, /Continue the same task/);

  const completed = {
    id: "resp_done", status: "completed", model: "ep-xodwa4gc",
    instructions: JSON.parse(prepareNativeFinishRequest({ instructions: "Original." })).instructions,
    tools: JSON.parse(prepareNativeFinishRequest({})).tools,
    output: [{
      type: "function_call", name: INTERNAL_FINISH_TOOL_NAME,
      call_id: "finish_1", arguments: JSON.stringify({ answer: "All done." }),
    }],
  };
  const finishDecision = decideNativeFinish(completed);
  assert.deepEqual(finishDecision, { kind: "finish", answer: "All done." });
  const final = nativeFinalResponse(completed, finishDecision.answer);
  assert.equal(final.output[0].type, "message");
  assert.equal(final.output[0].content[0].text, "All done.");
  assert.equal(final.instructions, "Original.");
  assert.deepEqual(final.tools, []);
  assert.doesNotMatch(JSON.stringify(final), new RegExp(INTERNAL_FINISH_TOOL_NAME));

  const wire = nativeFinalSSE(completed, finishDecision.answer);
  assert.match(wire, /event: response\.output_text\.delta/);
  assert.match(wire, /event: response\.completed/);
  assert.doesNotMatch(wire, new RegExp(INTERNAL_FINISH_TOOL_NAME));
  assert.equal(parseNativeTerminalSSE(wire).response.output[0].content[0].text, "All done.");
});

test("a finish tool containing only an announced next action is rejected", () => {
  const decision = decideNativeFinish({
    status: "completed",
    output: [{
      type: "function_call",
      name: INTERNAL_FINISH_TOOL_NAME,
      arguments: JSON.stringify({
        answer: "继续，只读排查 COS 缺 artifact。我先取 deployer 最新日志，并同时查看生命周期规则。",
      }),
    }],
  });
  assert.deepEqual(decision, {
    kind: "retry",
    reason: "premature_finish_tool",
    output: [],
  });
});

test("real work tools remain visible and mixed finish/work calls fail closed", () => {
  assert.deepEqual(decideNativeFinish({
    status: "completed",
    output: [{ type: "function_call", name: "exec_command", arguments: "{}" }],
  }), { kind: "forward" });
  assert.equal(decideNativeFinish({
    status: "completed",
    output: [
      { type: "function_call", name: "exec_command", arguments: "{}" },
      {
        type: "function_call", name: INTERNAL_FINISH_TOOL_NAME,
        arguments: JSON.stringify({ answer: "done" }),
      },
    ],
  }).kind, "invalid");
});
