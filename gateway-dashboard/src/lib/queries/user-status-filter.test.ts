import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_USER_STATUS_FILTER,
  normalizeUserStatusFilter,
  toUserStatusQueryParam,
} from "./user-status-filter.ts";

test("default user status filter is active", () => {
  assert.equal(DEFAULT_USER_STATUS_FILTER, "active");
});

test("normalizeUserStatusFilter falls back to active for unsupported values", () => {
  assert.equal(normalizeUserStatusFilter("disabled"), "active");
  assert.equal(normalizeUserStatusFilter(""), "active");
});

test("toUserStatusQueryParam omits all filter from request params", () => {
  assert.equal(toUserStatusQueryParam("all"), undefined);
  assert.equal(toUserStatusQueryParam("active"), "active");
  assert.equal(toUserStatusQueryParam("suspended"), "suspended");
  assert.equal(toUserStatusQueryParam("deleted"), "deleted");
});
