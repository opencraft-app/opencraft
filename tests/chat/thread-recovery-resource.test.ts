import assert from "node:assert/strict";
import test from "node:test";
import { ThreadRecoveryResource } from "@opencraft/workbench-runtime";
import type { TurnRecoveryNotice } from "@opencraft/appserver-protocol";
const notice: TurnRecoveryNotice = { threadId: "t", turnId: "auto", rootTurnId: "original", attempts: 1, limit: 3, state: "continued", sourceKind: "system" };
test("newer server notices and a connection replacement fence late reads", async () => {
  let resolve!: (value: { recovery: TurnRecoveryNotice | null }) => void;
  const resource = new ThreadRecoveryResource({ supported: () => true, read: () => new Promise(r => { resolve = r; }) });
  const first = resource.refresh("t"); resource.observe("t", { ...notice, state: "exhausted", attempts: 3 });
  resolve({ recovery: notice }); await first; assert.equal(resource.getSnapshot("t")?.state, "exhausted");
  const second = resource.refresh("t"); resource.reset(); resolve({ recovery: notice }); await second;
  assert.equal(resource.getSnapshot("t"), null);
});
test("unsupported Hosts and malformed or cross-thread projections cannot fabricate a notice", async () => {
  let reads = 0;
  const resource = new ThreadRecoveryResource({ supported: () => false, read: async () => { reads++; return { recovery: notice }; } });
  await resource.refresh("t"); assert.equal(reads, 0);
  resource.observe("t", { ...notice, sourceKind: "human" }); resource.observe("other", notice);
  assert.equal(resource.getSnapshot("t"), null); assert.equal(resource.getSnapshot("other"), null);
  resource.observe("t", notice); assert.deepEqual(resource.getSnapshot("t"), notice);
  resource.observe("t", null); assert.equal(resource.getSnapshot("t"), null);
});
