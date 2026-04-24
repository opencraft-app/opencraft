import test from "node:test";
import assert from "node:assert/strict";
import { getApiKeyStatusLabel } from "./api-key-status-label.ts";

test("getApiKeyStatusLabel returns localized labels", () => {
  assert.equal(getApiKeyStatusLabel("active"), "活跃");
  assert.equal(getApiKeyStatusLabel("revoked"), "已撤销");
  assert.equal(getApiKeyStatusLabel("all"), "全部");
});
