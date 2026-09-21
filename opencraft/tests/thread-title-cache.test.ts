import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { readCachedThreadName, writeCachedThreadName } from "../apps/workbench-web/src/runtime/thread-title-cache.js";
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
