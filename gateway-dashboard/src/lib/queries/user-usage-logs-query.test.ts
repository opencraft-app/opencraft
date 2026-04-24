import test from "node:test";
import assert from "node:assert/strict";
import {
  buildUserUsageLogsQueryParams,
  getUserUsageLogsColumns,
  getUserUsageLogsQueryKey,
  getUsageLogsStateForRangeChange,
} from "./user-usage-logs-query.ts";

test("buildUserUsageLogsQueryParams uses default 7d params", () => {
  const result = buildUserUsageLogsQueryParams({
    range: "7d",
    page: 1,
    pageSize: 20,
  });

  assert.deepEqual(result, {
    enabled: true,
    params: {
      range: "7d",
      page: 1,
      page_size: 20,
    },
  });
});

test("buildUserUsageLogsQueryParams disables custom requests without a full date range", () => {
  const result = buildUserUsageLogsQueryParams({
    range: "custom",
    start: "2026-03-01",
    end: "",
    page: 2,
    pageSize: 20,
  });

  assert.deepEqual(result, {
    enabled: false,
    params: {
      range: "custom",
      page: 2,
      page_size: 20,
      start: "2026-03-01",
      end: "",
    },
  });
});

test("getUserUsageLogsQueryKey includes all filter fields", () => {
  assert.deepEqual(
    getUserUsageLogsQueryKey("usr_001", {
      range: "custom",
      start: "2026-03-01",
      end: "2026-03-31",
      page: 3,
      pageSize: 50,
    }),
    ["users", "usr_001", "usage-logs", "custom", "2026-03-01", "2026-03-31", 3, 50],
  );
});

test("getUsageLogsStateForRangeChange resets page to 1", () => {
  const next = getUsageLogsStateForRangeChange({
    range: "7d",
    start: "",
    end: "",
    page: 4,
    pageSize: 20,
  }, "30d");

  assert.deepEqual(next, {
    range: "30d",
    start: "",
    end: "",
    page: 1,
    pageSize: 20,
  });
});

test("getUserUsageLogsColumns hides technical fields by default", () => {
  assert.deepEqual(getUserUsageLogsColumns(false), [
    "请求时间",
    "模型",
    "请求次数",
    "Prompt Tokens",
    "Completion Tokens",
    "Total Tokens",
    "Request ID",
  ]);
});

test("getUserUsageLogsColumns appends technical fields when enabled", () => {
  assert.deepEqual(getUserUsageLogsColumns(true), [
    "请求时间",
    "模型",
    "请求次数",
    "Prompt Tokens",
    "Completion Tokens",
    "Total Tokens",
    "Request ID",
    "状态码",
    "延迟",
    "来源",
  ]);
});
