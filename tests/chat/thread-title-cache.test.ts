import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { readCachedThreadName, writeCachedThreadName } from "../../apps/workbench-web/src/runtime/thread-title-cache.js";
test("optimistic names update all Host-scoped catalog shapes without crossing Host identity", () => {
  const query = new QueryClient();
  query.setQueryData(["appserver", "local", "threads", "sidebar"], { data: [{ id: "thread", name: "Old" }] });
  query.setQueryData(["appserver", "local", "threads", "pages"], { pages: [{ data: [{ id: "thread", name: "Old" }] }], pageParams: [null] });
  query.setQueryData(["appserver", "remote", "threads"], { data: [{ id: "thread", name: "Remote" }] });
  writeCachedThreadName(query, { hostId: "local", threadId: "thread" }, "New");
  assert.equal(readCachedThreadName(query, { hostId: "local", threadId: "thread" }), "New");
  assert.equal(readCachedThreadName(query, { hostId: "remote", threadId: "thread" }), "Remote");
  query.clear();
});

test("unnamed cached Threads display preview while an explicit name in another page still wins", () => {
  const query = new QueryClient();
  try {
    query.setQueryData(["appserver", "local", "threads", "sidebar"], { data: [{ id: "thread", name: "", preview: "首条任务" }] });
    assert.equal(readCachedThreadName(query, { hostId: "local", threadId: "thread" }), "首条任务");
    query.setQueryData(["appserver", "local", "threads", "pages"], { pages: [{ data: [{ id: "thread", name: "手动标题", preview: "首条任务" }] }] });
    assert.equal(readCachedThreadName(query, { hostId: "local", threadId: "thread" }), "手动标题");
    assert.equal(readCachedThreadName(query, { hostId: "other", threadId: "thread" }), "New chat");
  } finally { query.clear(); }
});
