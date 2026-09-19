import assert from "node:assert/strict";
import test from "node:test";
import { changesThreadCatalog } from "../apps/workbench-web/src/runtime/thread-catalog-query.js";
test("thread metadata changes and completed work invalidate catalog queries, not token deltas", () => {
  assert.equal(changesThreadCatalog("thread/name/updated"), true);
  assert.equal(changesThreadCatalog("thread/archived"), true);
  assert.equal(changesThreadCatalog("thread/unarchived"), true);
  assert.equal(changesThreadCatalog("turn/completed"), true);
  assert.equal(changesThreadCatalog("item/agentMessage/delta"), false);
});
