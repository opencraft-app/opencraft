import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_API_KEY_STATUS_FILTER,
  normalizeApiKeyStatusFilter,
  toApiKeyStatusQueryParam,
} from "./api-key-status-filter.ts";

test("default api key status filter is active", () => {
  assert.equal(DEFAULT_API_KEY_STATUS_FILTER, "active");
});

test("normalizeApiKeyStatusFilter falls back to active for unsupported values", () => {
  assert.equal(normalizeApiKeyStatusFilter("disabled"), "active");
  assert.equal(normalizeApiKeyStatusFilter(""), "active");
});

test("toApiKeyStatusQueryParam omits all filter from request params", () => {
  assert.equal(toApiKeyStatusQueryParam("all"), undefined);
  assert.equal(toApiKeyStatusQueryParam("active"), "active");
  assert.equal(toApiKeyStatusQueryParam("revoked"), "revoked");
});
