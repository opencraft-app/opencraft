import test from "node:test";
import assert from "node:assert/strict";
import { acceptsImport, emptyHistory, foldHistory, importCoverage, reduceHistory, unknownCoverage,
  type HistoryChange, type HistoryRecord } from "../../packages/app-host-server/src/conversation-model.js";
const record = (id: string, text = id, coverage: HistoryRecord["coverage"] = "complete"): HistoryRecord =>
  ({ id, groupId: null, kind: "entry", type: "message", value: { text }, coverage, sourceCursor: null });
const put = (id: string, text = id): HistoryChange => ({ type: "put", record: record(id, text) });
const page = (ids: string[], next: string | null = null, cursor: string | null = null, stable = false) =>
  ({ ids, next, cursor, stable, source: "synthetic", generation: stable ? "native-1" : null, query: "all/desc" });

test("membership removal is replayable even when every surviving body is unchanged", () => {
  const changes: HistoryChange[] = [put("a"), put("b"), { type: "remove", id: "b" }];
  const events = changes.map((change, i) => ({ id: `event-${i}`, seq: i + 1, change }));
  const state = foldHistory(events);
  assert.deepEqual(Object.keys(state.records), ["a"]);
  assert.deepEqual(foldHistory(JSON.parse(JSON.stringify(events))), state);
  assert.equal(events.length, 3);
});
test("object identity, event identity and body equality are distinct", () => {
  const changes = [put("a", "A"), put("a", "B"), put("a", "A")];
  const events = changes.map((change, i) => ({ seq: i + 1, id: String(i), change }));
  assert.equal(foldHistory(events).records.a!.value.text, "A");
  assert.deepEqual(foldHistory([...events, events[2]!]), foldHistory(events));
  assert.throws(() => foldHistory([...events, { ...events[2]!, change: put("a", "conflict") }]), /Conflicting/);
});
test("summary and partial updates cannot erase complete detail; explicit null is retained", () => {
  let state = reduceHistory(emptyHistory(), put("a", "full tool output"));
  state = reduceHistory(state, { type: "put", record: record("a", "summary", "headers") });
  assert.equal(state.records.a!.value.text, "full tool output");
  state = reduceHistory(state, { type: "metadata", value: { name: "name", cwd: "/x" } });
  state = reduceHistory(state, { type: "metadata", value: { name: null } });
  assert.deepEqual(state.metadata, { name: null, cwd: "/x" });
});
test("old A, live D and a latest D page retain the missing middle", () => {
  const old = importCoverage(unknownCoverage(), page(["a"]));
  const latest = importCoverage(old, page(["d"], "older"));
  assert.equal(latest.state, "partial"); assert.deepEqual(latest.visible, ["d"]);
  assert.deepEqual(JSON.parse(JSON.stringify(latest)), latest);
});
test("cursor chains are bound to source, generation and query; EOF is not evidence of stable multi-page coverage", () => {
  const start = importCoverage(unknownCoverage(), page(["d"], "older"));
  const end = importCoverage(start, page(["a"], null, "older"));
  assert.equal(end.state, "partial"); assert.equal(end.next, null);
  for (const patch of [{ source: "other" }, { generation: "other" }, { query: "archived" }, { cursor: "wrong" }])
    assert.throws(() => importCoverage(start, { ...page(["a"], null, "older"), ...patch }));
  const stable = importCoverage(unknownCoverage(), page(["d"], "older", null, true));
  assert.equal(importCoverage(stable, page(["a"], null, "older", true)).state, "complete");
});
test("source order is explicit and independent of ingestion order", () => {
  let state = foldHistory([put("d"), put("a")].map((change, i) => ({ seq: i + 1, id: String(i), change })));
  state = reduceHistory(state, { type: "order", kind: "entry", groupId: null, ids: ["a", "d"] });
  assert.deepEqual(Object.values(state.order)[0], ["a", "d"]);
  assert.throws(() => reduceHistory(state, { type: "order", kind: "entry", groupId: null, ids: ["d", "d"] }));
});
test("deleted, replaced or updated heads reject an outstanding import", () => {
  const fence = { epoch: "e1", revision: 2 };
  assert.ok(acceptsImport({ ...fence, deleted: false }, fence));
  for (const current of [{ ...fence, deleted: true }, { ...fence, epoch: "e2", deleted: false }, { ...fence, revision: 3, deleted: false }])
    assert.equal(acceptsImport(current, fence), false);
});
test("baseline plus suffix is identical to full replay for deterministic varied histories", () => {
  let random = 813;
  for (let run = 0; run < 80; run++) {
    const events = Array.from({ length: 60 }, (_, i) => {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const id = `r${random % 11}`;
      const change: HistoryChange = random % 4 === 0 ? { type: "remove", id } : put(id, String(random));
      return { seq: i + 1, id: `e${i}`, change };
    });
    const cut = 1 + random % 58, baseline = foldHistory(events.slice(0, cut));
    assert.deepEqual(foldHistory(events.slice(cut), baseline), foldHistory(events));
    assert.deepEqual(foldHistory(JSON.parse(JSON.stringify(events))), foldHistory(events));
  }
});
