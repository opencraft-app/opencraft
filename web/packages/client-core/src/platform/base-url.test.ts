import assert from "node:assert/strict";
import test from "node:test";

import {normalizeApiBaseUrl} from "./base-url.js";
import {PlatformError} from "./errors.js";

test("normalizeApiBaseUrl appends /v1 exactly once", () => {
  assert.equal(normalizeApiBaseUrl("https://api.example.test"), "https://api.example.test/v1");
  assert.equal(normalizeApiBaseUrl("https://api.example.test/"), "https://api.example.test/v1");
  assert.equal(normalizeApiBaseUrl("https://api.example.test/v1"), "https://api.example.test/v1");
  assert.equal(normalizeApiBaseUrl("https://api.example.test/v1/"), "https://api.example.test/v1");
});

test("normalizeApiBaseUrl rejects relative and non-http URLs", () => {
  for (const value of ["/api", "file:///tmp/api"]) {
    assert.throws(
      () => normalizeApiBaseUrl(value),
      (error: unknown) =>
        error instanceof PlatformError && error.code === "CONFIG",
    );
  }
});
