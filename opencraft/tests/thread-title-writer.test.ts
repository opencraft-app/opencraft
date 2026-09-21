import assert from "node:assert/strict";
import test from "node:test";
import { ThreadTitleWriter } from "../packages/workbench-runtime/src/thread-title-writer.js";
test("old title failure cannot roll back a newer optimistic name and writes are serialized", async () => {
  let title = "Original", rejectFirst!: (error: Error) => void; const calls: string[] = [];
  const writer = new ThreadTitleWriter({ read: () => title, write: (_key, value) => { title = value; },
    persist: async (_key, value) => { calls.push(value); if (value === "A") await new Promise<void>((_resolve, reject) => { rejectFirst = reject; }); } });
  const a = writer.rename({ hostId: "local", threadId: "thread" }, "A");
  await Promise.resolve(); await Promise.resolve();
  const b = writer.rename({ hostId: "local", threadId: "thread" }, "B");
  assert.equal(title, "B"); assert.deepEqual(calls, ["A"]);
  rejectFirst(new Error("failed A")); await assert.rejects(a, /failed A/); await b;
  assert.equal(title, "B"); assert.deepEqual(calls, ["A", "B"]);
});
