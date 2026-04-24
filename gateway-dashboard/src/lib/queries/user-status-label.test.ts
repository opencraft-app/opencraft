import test from "node:test";
import assert from "node:assert/strict";
import { getUserStatusLabel } from "./user-status-label.ts";

test("getUserStatusLabel returns localized labels", () => {
  assert.equal(getUserStatusLabel("active"), "活跃");
  assert.equal(getUserStatusLabel("suspended"), "已禁用");
  assert.equal(getUserStatusLabel("disabled"), "已禁用");
  assert.equal(getUserStatusLabel("deleted"), "已删除");
  assert.equal(getUserStatusLabel("expired"), "已过期");
  assert.equal(getUserStatusLabel("all"), "全部");
  assert.equal(getUserStatusLabel("custom-status"), "custom-status");
});
