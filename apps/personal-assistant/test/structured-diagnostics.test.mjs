import test from "node:test";
import assert from "node:assert/strict";
import { decodeOutput, outputSchema, StructuredOutputError } from "../src/adapters/models/structured-output.mjs";

function failure(value, input = {}) {
  try {
    decodeOutput("reception", JSON.stringify(value), input);
  } catch (e) {
    assert.ok(e instanceof StructuredOutputError);
    return e;
  }
  assert.fail("Expected schema rejection");
}
test("schema diagnostics locate missing and invalid fields without including output values", () => {
  for (const [proposal, code, path] of [
    [{ kind: "remember", key: "city", value: "PRIVATE_CITY" }, "required", "$.proposal.expectedRevision"],
    [
      {
        kind: "remember",
        key: "city",
        value: "PRIVATE_CITY",
        expectedRevision: "PRIVATE_REVISION",
      },
      "type",
      "$.proposal.expectedRevision",
    ],
    [{ kind: "query", name: "PRIVATE_QUERY", params: {} }, "enum", "$.proposal.name"],
    [{ kind: "batch", commands: [{ kind: "delegate" }] }, "required", "$.proposal.commands[].goal"],
    [{ kind: "reply", text: "PRIVATE_TEXT", PRIVATE_SECRET: "PRIVATE_VALUE" }, "unexpected", "$.proposal.<unknown>"],
  ]) {
    const e = failure({ proposal });
    assert.deepEqual(e.diagnostic, { stage: "wire", code, path });
    assert.doesNotMatch(e.message + JSON.stringify(e), /PRIVATE_/);
  }
  assert.throws(
    () => decodeOutput("reception", '{"PRIVATE_SECRET":', {}),
    (e) => {
      assert.deepEqual(e.diagnostic, {
        stage: "json",
        code: "invalid_json",
        path: "$",
      });
      assert.doesNotMatch(e.message + JSON.stringify(e), /PRIVATE_/);
      return true;
    },
  );
});
test("wire-valid cross-branch fields remain rejected and canonical optional omission remains accepted", () => {
  const schema = outputSchema("reception", {});
  const proposal = Object.fromEntries(Object.keys(schema.properties.proposal.properties).map((k) => [k, null]));
  Object.assign(proposal, { kind: "reply", text: "ok", goal: "PRIVATE_GOAL" });
  const e = failure({ proposal });
  assert.deepEqual(e.diagnostic, {
    stage: "command_contract",
    code: "unexpected",
    path: "$.proposal.goal",
  });
  assert.deepEqual(decodeOutput("reception", '{"proposal":{"kind":"delegate","goal":"A"}}', {}), {
    kind: "delegate",
    goal: "A",
  });
  const report = failure({ proposal: { kind: "delegate", goal: "A" } }, { source: { kind: "execution-report" } });
  assert.equal(report.diagnostic.path, "$.proposal.kind");
});
