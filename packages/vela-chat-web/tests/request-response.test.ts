import assert from "node:assert/strict";
import test from "node:test";

import { buildRequestResponseInputEvent } from "../../../app/chat/requestResponses";

test("maps question dock answers to user.request_answer input events", () => {
  assert.deepEqual(
    buildRequestResponseInputEvent({
      kind: "answer",
      requestId: "req_question",
      answer: "Use option B",
    }),
    {
      type: "user.request_answer",
      request_id: "req_question",
      answer: "Use option B",
    },
  );
});

test("maps confirmation dock responses to user.tool_confirmation input events", () => {
  assert.deepEqual(
    buildRequestResponseInputEvent({
      kind: "confirmation",
      requestId: "req_confirm",
      result: "allow",
    }),
    {
      type: "user.tool_confirmation",
      request_id: "req_confirm",
      result: "allow",
    },
  );
});
