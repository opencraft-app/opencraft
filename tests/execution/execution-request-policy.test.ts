import assert from "node:assert/strict";
import test from "node:test";
import {
  executionRequestEffect as effect,
  requiresEnvironmentAuthority,
  requiresCurrentEnvironmentAuthority,
} from "../../scripts/execution-request-policy.js";

test("effects separate input admission, shared control and use of configured credentials", () => {
  for (const method of ["turn/start", "thread/queue/add", "thread/queue/start"])
    assert.equal(effect(method), "admit-input");
  for (const method of ["turn/steer", "thread/queue/steer"]) assert.equal(effect(method), "active-turn-input");
  for (const method of ["thread/goal/set", "thread/goal/clear", "turn/interrupt"]) {
    assert.equal(effect(method), "thread-control");
    assert.ok(requiresEnvironmentAuthority(method));
    assert.ok(!requiresCurrentEnvironmentAuthority(method));
  }
  for (const method of ["thread/queue/update", "thread/queue/delete", "thread/queue/reorder"])
    assert.equal(effect(method), "queued-intent");
  for (const method of [
    "thread/shellCommand",
    "thread/settings/update",
    "review/start",
    "thread/realtime/start",
    "thread/backgroundTerminals/kill",
    "turn/futureOperation",
  ]) {
    assert.equal(effect(method), "configured-execution");
    assert.ok(requiresCurrentEnvironmentAuthority(method));
  }
  for (const method of ["thread/read", "thread/goal/get", "thread/queue/list", "thread/backgroundTerminals/list"])
    assert.equal(effect(method), "none");
});
