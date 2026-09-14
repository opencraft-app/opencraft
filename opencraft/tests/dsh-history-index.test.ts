import test from "node:test";
import assert from "node:assert/strict";
import { DshHistoryIndex } from "../apps/local-agent-host/src/dsh-history-index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("index scans once, refreshes only new tail, and serves bounded pages after reopening", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-history-index-"));
  const path = join(root, "index.sqlite");
  let index = new DshHistoryIndex(path);
  try {
    const entries = Array.from({ length: 250 }, (_, seq) => ({ event: { seq, time: seq, type: "fixture", data: {} } }));
    let calls = 0;
    const fetch = async (before?: number) => {
      calls++;
      const all = entries.filter(value => before === undefined || value.event.seq < before);
      return { events: all.slice(-100), hasMore: all.length > 100 };
    };
    await index.refresh("s", fetch);
    assert.equal(calls, 3);
    assert.deepEqual(index.read("s", undefined, 2).map(value => value.event.seq), [249, 248]);
    entries.push({ event: { seq: 250, time: 250, type: "fixture", data: {} } });
    await index.refresh("s", fetch);
    assert.equal(calls, 4);
    index.close();
    index = new DshHistoryIndex(path);
    await index.refresh("s", fetch, true);
    assert.equal(calls, 4, "retired immutable generations require no network re-scan");
    assert.deepEqual(index.read("s", 4, 2).map(value => value.event.seq), [3, 2]);
    entries[250].event.data = { changed: true };
    await assert.rejects(index.refresh("s", fetch), /Immutable/);
    entries.splice(200);
    await assert.rejects(index.refresh("s", fetch), /regressed/);
  } finally { index.close(); await rm(root, { recursive: true, force: true }); }
});
test("failed partial scans are not exposed as complete history", async () => {
  const index = new DshHistoryIndex(":memory:");
  try {
    let calls = 0;
    await assert.rejects(index.refresh("s", async () => {
      if (calls++) throw new Error("connection lost");
      return { events: [{ event: { seq: 3, time: 3, type: "x", data: {} } }], hasMore: true };
    }), /connection lost/);
    assert.equal(index.complete("s"), false);
    assert.throws(() => index.read("s", undefined, 10), /incomplete/);
  } finally { index.close(); }
});
