import assert from "node:assert/strict";
import test from "node:test";
import { HermesTranscriptWindow } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/transcript-window";
import type { HermesMessagesPage } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/types";

const page = (start: number, count: number, offset = 0): HermesMessagesPage => ({
  session_id: "s", messages: Array.from({ length: count }, (_, i) => ({ id: start + i, role: "assistant", content: "part" })),
  pagination: { offset, limit: 120, returned: count, order: "latest" },
});

test("Desktop tail reads exactly 120 rows once even if all belong to one long execution", async () => {
  const calls: unknown[] = [];
  const window = new HermesTranscriptWindow({ async readMessages(id, query) { calls.push({ id, query }); return page(121, 120); }, dispose() {} }, "s");
  const tail = await window.readTail();
  assert.deepEqual(calls, [{ id: "s", query: { limit: 120, offset: 0, order: "latest", includeCompacted: true } }]);
  assert.equal(tail.messages.length, 120);
  assert.equal(tail.nextOffset, 120);
  assert.equal(tail.possiblyTruncated, true);
});

test("older demand is single-flight, deduplicates shifted offsets and preserves backfill on refresh", async () => {
  let calls = 0;
  const window = new HermesTranscriptWindow({ async readMessages() {
    calls++;
    return calls === 1 ? page(121, 120) : calls === 2 ? page(2, 120, 120) : page(125, 120);
  }, dispose() {} }, "s");
  await window.readTail();
  const first = window.readOlder();
  assert.equal(window.readOlder(), first);
  const older = await first;
  assert.equal(older.messages.length, 239);
  assert.equal(new Set(older.messages.map(m => m.id)).size, 239);
  assert.equal(await window.readOlder(undefined, 120), older, "a replayed cursor cannot fetch the following page");
  assert.equal(calls, 2);
  const refresh = await window.readTail();
  assert.equal(refresh.messages[0].id, 2);
  assert.equal(refresh.messages.at(-1)?.id, 244);
});

test("stale older response cannot modify a refreshed window or advance its cursor", async () => {
  let calls = 0;
  let finish!: (p: HermesMessagesPage) => void;
  const window = new HermesTranscriptWindow({ async readMessages() {
    calls++;
    if (calls === 2) return new Promise(resolve => { finish = resolve; });
    return calls === 1 ? page(121, 120) : page(300, 2);
  }, dispose() {} }, "s");
  await window.readTail();
  const pending = window.readOlder();
  const fresh = await window.readTail();
  finish(page(1, 120, 120));
  await pending;
  assert.equal(window.getSnapshot(), fresh);
  assert.equal(fresh.nextOffset, 2);
});
