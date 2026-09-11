import assert from "node:assert/strict";
import test from "node:test";

import {
  canRunGatewayOperation,
  isGatewayOperationConfirmed,
  migrationNeedsLegacyKeyCleanup,
  migrationRequestBody,
  quotaResetRequestBody,
} from "./gateway-operation-policy.ts";

test("gateway operations are only available for Running bots", () => {
  assert.equal(canRunGatewayOperation("Running"), true);
  assert.equal(canRunGatewayOperation("Paused"), false);
  assert.equal(canRunGatewayOperation("Deleted"), false);
});

test("gateway operation confirmation requires the exact full user id", () => {
  assert.equal(isGatewayOperationConfirmed("usr_abc", "usr_abc"), true);
  assert.equal(isGatewayOperationConfirmed(" usr_abc ", "usr_abc"), true);
  assert.equal(isGatewayOperationConfirmed("usr_ab", "usr_abc"), false);
});

test("gateway operation request bodies always carry an explicit dry-run flag", () => {
  assert.deepEqual(migrationRequestBody("usr_abc", true), { user_id: "usr_abc", dry_run: true });
  assert.deepEqual(quotaResetRequestBody(false), { dry_run: false });
});

test("only a first migration with a failed legacy revoke needs cleanup", () => {
  assert.equal(migrationNeedsLegacyKeyCleanup("ai_gateway", false), true);
  assert.equal(migrationNeedsLegacyKeyCleanup("ai_gateway", true), false);
  assert.equal(migrationNeedsLegacyKeyCleanup("llm_gateway", false), false);
});
