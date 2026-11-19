import test from "node:test";
import assert from "node:assert/strict";
import { nativeTurnFailure } from "../src/adapters/codex/turn-failure.mjs";
test("native failures retain only declared codes and HTTP status, never provider messages", () => {
  const events = [],
    telemetry = { event: (...v) => events.push(v) };
  const error = nativeTurnFailure(
    {
      status: "failed",
      error: {
        message: "Bearer private prompt",
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } },
      },
    },
    telemetry,
    "reception",
  );
  assert.match(error.message, /httpConnectionFailed, HTTP 429/);
  assert.equal(error.code, "CODEX_TURN_FAILED");
  assert.doesNotMatch(JSON.stringify(events), /Bearer|private|prompt/);
  for (const info of [
    "secret-model-output",
    { secret: "secret" },
    { httpConnectionFailed: { httpStatusCode: "secret" } },
  ]) {
    assert.doesNotMatch(
      nativeTurnFailure({ status: "private-status", error: { codexErrorInfo: info } }, telemetry, "reception").message,
      /secret|private/,
    );
  }
});

test("429 keeps typed safe metadata; optional Host cooldown enriches without parsing provider text", async () => {
  const { enrichModelFailure } = await import("../src/adapters/codex/turn-failure.mjs");
  const e = nativeTurnFailure({
    status: "failed",
    error: { message: "private body", codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } },
  });
  assert.equal(e.httpStatus, 429);
  assert.equal(e.modelFailure.kind, "rate_limit");
  const retryAt = Date.now() + 90000;
  await enrichModelFailure(
    e,
    async (purpose) => {
      assert.equal(purpose, "memory-verify");
      return { httpStatus: 429, retryAt };
    },
    "memory-verify",
  );
  assert.equal(e.modelFailure.retryAt, retryAt);
  await enrichModelFailure(e, async () => ({ kind: "quota_exhausted" }), "memory-verify");
  assert.equal(e.modelFailure.kind, "quota_exhausted");
  assert.doesNotMatch(JSON.stringify(e), /private body/);
});
