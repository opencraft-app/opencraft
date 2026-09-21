import assert from "node:assert/strict";
import test from "node:test";

import { classifyHermesBotExecutionFailure } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/bot-execution-failure.js";
import { executionFromTurn, restoredExecutionsFromTurns } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/bot-protocol-handler.js";

test("Hermes provider quota failures have one safe Bot error code across execution topologies", () => {
  assert.deepEqual(
    classifyHermesBotExecutionFailure({
      reasonCode: "provider_quota_limit",
      error: "HTTP 402: private upstream response",
    }),
    { code: "BOT_PROVIDER_QUOTA_LIMIT", retryable: false },
  );
  assert.deepEqual(
    classifyHermesBotExecutionFailure({
      error: { message: "Hermes turn failed", errorSurface: { layer: "billing", code: "billing", retryable: false } },
    }),
    { code: "BOT_PROVIDER_QUOTA_LIMIT", retryable: false },
  );
});

test("direct Bot turn failures use the shared provider quota classification", () => {
  const execution = executionFromTurn("conversation", {
    id: "turn",
    status: "failed",
    items: [],
    startedAt: null,
    completedAt: null,
    error: { message: "HTTP 403: 用户额度不足, 剩余额度: $0.000000" },
  } as any, { botId: "999", name: "999" } as any);
  assert.deepEqual(execution.error, { code: "BOT_PROVIDER_QUOTA_LIMIT", retryable: false });
});

test("direct Bot history restores failed executions but omits settled success rows", () => {
  const failed = {
    id: "failed", status: "failed", items: [], startedAt: 1, completedAt: 2,
    error: "HTTP 402: quota exhausted", itemsView: "full", durationMs: 1,
  } as any;
  const running = { ...failed, id: "running", status: "inProgress", error: null, completedAt: null };
  const completed = { ...failed, id: "completed", status: "completed", error: null };
  const executions = restoredExecutionsFromTurns("conversation", [completed, failed, running], { botId: "999", name: "999" } as any);
  assert.deepEqual(executions.map(({ executionId, status }) => [executionId, status]), [
    ["failed", "failed"],
    ["running", "running"],
  ]);
  assert.deepEqual(executions[0]?.error, { code: "BOT_PROVIDER_QUOTA_LIMIT", retryable: false });
});
