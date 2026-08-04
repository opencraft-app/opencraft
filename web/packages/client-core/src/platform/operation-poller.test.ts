import assert from "node:assert/strict";
import test from "node:test";

import {PlatformError} from "./errors.js";
import {
  isOperationTerminal,
  pollOperation,
  type OperationPollResult,
} from "./operation-poller.js";
import type {Operation} from "./api.js";

function operation(
  state: Operation["state"],
  id = "operation-1",
): Operation {
  return {
    createdAt: "2026-08-01T03:00:00.000Z",
    id,
		kind: "tat.computer.refresh",
    service: "tat",
    state,
  };
}

test("Operation terminal states match the platform contract", () => {
  assert.equal(isOperationTerminal(operation("pending")), false);
  assert.equal(isOperationTerminal(operation("running")), false);
  assert.equal(isOperationTerminal(operation("retry_wait")), false);
  assert.equal(isOperationTerminal(operation("succeeded")), true);
  assert.equal(isOperationTerminal(operation("failed")), true);
  assert.equal(isOperationTerminal(operation("uncertain")), true);
  assert.equal(isOperationTerminal(operation("superseded")), true);
});

test("pollOperation publishes every state and stops at a real terminal state", async () => {
  let now = 0;
  const sleeps: number[] = [];
  const updates: Operation[] = [];
  const states: Operation["state"][] = ["running", "succeeded"];

  const result = await pollOperation({
    initial: operation("pending"),
    load: async () => operation(states.shift() ?? "succeeded"),
    now: () => now,
    onUpdate: (value) => updates.push(value),
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
  });

  assert.equal(result.kind, "terminal");
  assert.equal(result.operation.state, "succeeded");
  assert.deepEqual(updates.map((item) => item.state), [
    "pending", "running", "succeeded",
  ]);
  assert.deepEqual(sleeps, [1000, 1000]);
});

test("pollOperation keeps the last state across transient errors", async () => {
  let now = 0;
  let attempts = 0;
  const result = await pollOperation({
    initial: operation("running"),
    load: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new PlatformError("REMOTE_UNAVAILABLE", "暂不可用");
      }
      return operation("succeeded");
    },
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
  });

  assert.equal(result.kind, "terminal");
  assert.equal(result.operation.state, "succeeded");
  assert.equal(attempts, 2);
});

test("long Retry-After pauses instead of polling the server early", async () => {
  let now = 0;
  let attempts = 0;
  const result: OperationPollResult = await pollOperation({
    initial: operation("pending"),
    load: async () => {
      attempts += 1;
      throw new PlatformError("RATE_LIMITED", "请求过于频繁", {
        retryAfterSeconds: 45,
      });
    },
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
  });

  assert.equal(result.kind, "rate_limited");
  assert.equal(result.operation.state, "pending");
  assert.equal(result.retryAfterSeconds, 45);
  assert.equal(attempts, 1);
});

test("pollOperation returns the last operation after one 30 second window", async () => {
  let now = 0;
  const result = await pollOperation({
    initial: operation("retry_wait"),
    load: async () => operation("retry_wait"),
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
  });

  assert.equal(result.kind, "timed_out");
  assert.equal(result.operation.state, "retry_wait");
  assert.equal(now, 30_000);
});

test("pollOperation aborts without publishing a stale response", async () => {
  const controller = new AbortController();
  const updates: Operation[] = [];
  controller.abort();

  const result = await pollOperation({
    initial: operation("running"),
    load: async () => operation("succeeded"),
    now: () => 0,
    onUpdate: (value) => updates.push(value),
    signal: controller.signal,
    sleep: async () => undefined,
  });

  assert.equal(result.kind, "aborted");
  assert.deepEqual(updates, []);
});
