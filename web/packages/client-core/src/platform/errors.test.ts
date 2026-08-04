import assert from "node:assert/strict";
import test from "node:test";

import {PlatformError, responseError} from "./errors.js";

test("responseError preserves the platform request ID and Retry-After", async () => {
  const response = new Response(
    JSON.stringify({
      error: {
        code: "rate_limited",
        message: "请求过于频繁",
        requestId: "request-1",
      },
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Retry-After": "12",
      },
      status: 429,
    },
  );

  const error = await responseError(response);

  assert.ok(error instanceof PlatformError);
  assert.equal(error.code, "RATE_LIMITED");
  assert.equal(error.message, "请求过于频繁");
  assert.equal(error.platformCode, "rate_limited");
  assert.equal(error.requestId, "request-1");
  assert.equal(error.retryAfterSeconds, 12);
});

test("responseError maps malformed success-independent responses deterministically", async () => {
  const unauthorized = await responseError(new Response("", {status: 401}));
  const unavailable = await responseError(new Response("oops", {status: 503}));
  const unexpected = await responseError(new Response("oops", {status: 418}));

  assert.equal(unauthorized.code, "AUTH_REQUIRED");
  assert.equal(unavailable.code, "REMOTE_UNAVAILABLE");
  assert.equal(unexpected.code, "PROTOCOL");
});
