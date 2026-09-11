import assert from "node:assert/strict";
import test from "node:test";

import { requiresCtlOperatorToken } from "./route-policy.ts";

test("only mutating gateway operator routes require the CTL internal token", () => {
  assert.equal(requiresCtlOperatorToken(["instances", "ins-1", "gateway", "migrate"], "POST"), true);
  assert.equal(requiresCtlOperatorToken(["users", "usr_1", "gateway", "quota", "reset"], "POST"), true);
  assert.equal(requiresCtlOperatorToken(["bots"], "GET"), false);
  assert.equal(requiresCtlOperatorToken(["bots", "ins-1"], "DELETE"), false);
});
