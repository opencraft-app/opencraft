import assert from "node:assert/strict";
import test from "node:test";
import { archiveThread } from "../../apps/workbench-web/src/runtime/thread-archive.js";

test("archive acknowledgement settles without waiting for a slow catalog", async () => {
  let refreshes = 0;
  await archiveThread({ archive: async () => {}, refreshThreads: () => { refreshes++; return new Promise(() => {}); } });
  assert.equal(refreshes, 1);
});
test("refresh failure cannot turn a confirmed archive into a failed mutation", async () => {
  await archiveThread({ archive: async () => {}, refreshThreads: async () => { throw new Error("offline"); } });
});
test("unknown archive outcome reconciles once without retrying the mutation", async () => {
  let attempts = 0, refreshes = 0;
  await assert.rejects(archiveThread({ archive: async () => { attempts++; throw new Error("receipt lost"); },
    refreshThreads: async () => { refreshes++; } }), /receipt lost/);
  assert.equal(attempts, 1);
  assert.equal(refreshes, 1);
});
