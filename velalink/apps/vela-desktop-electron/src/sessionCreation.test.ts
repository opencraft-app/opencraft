import assert from "node:assert/strict";
import test from "node:test";

import { normalizeInitialSessionMessage } from "./sessionCreation";

test("initial session message trims string prompts", () => {
  assert.equal(normalizeInitialSessionMessage("  hello Vela  "), "hello Vela");
});

test("initial session message ignores non-string event payloads", () => {
  assert.equal(normalizeInitialSessionMessage({ type: "click" }), "");
  assert.equal(normalizeInitialSessionMessage(null), "");
});
