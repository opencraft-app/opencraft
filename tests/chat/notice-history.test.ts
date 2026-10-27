import assert from "node:assert/strict";
import test from "node:test";
import { reduceNoticeHistory, type NoticeRecord } from "../../apps/workbench-web/src/components/notice-history";

test("history survives presentation dismissal, coalesces an operation and reopens unread on recurrence", () => {
  const first = reduceNoticeHistory([], { type: "publish", tone: "error", notice: { key: "archive:host:thread", message: "Failed" }, now: 1 });
  const read = reduceNoticeHistory(first, { type: "read" });
  assert.equal(first[0]!.read, false, "read action does not mutate an older snapshot");
  assert.equal(read[0]!.read, true);
  const updated = reduceNoticeHistory(read, { type: "publish", tone: "success", notice: { key: "archive:host:thread", message: "Saved" }, now: 2 });
  assert.deepEqual(updated, [{ key: "archive:host:thread", message: "Saved", tone: "success", receivedAt: 2, occurrences: 2, read: false }]);
  assert.deepEqual(reduceNoticeHistory(updated, { type: "clear" }), []);
});

test("history stays bounded and target identities remain independent", () => {
  let records: readonly NoticeRecord[] = [];
  for (let n = 0; n < 75; n++) records = reduceNoticeHistory(records, { type: "publish", tone: "info", notice: { key: `host:${n}`, message: "Changed" }, now: n });
  assert.equal(records.length, 50);
  assert.equal(records[0]!.key, "host:74");
  assert.equal(records.at(-1)!.key, "host:25");
  records = reduceNoticeHistory(records, { type: "publish", tone: "warning", notice: { key: "host:30", message: "Changed again" }, now: 80 });
  assert.equal(records.length, 50);
  assert.equal(records[0]!.key, "host:30");
  assert.equal(records[0]!.occurrences, 2);
});
