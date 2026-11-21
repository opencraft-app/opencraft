import assert from "node:assert/strict";
import test from "node:test";

test("legacy script entries share the canonical packaged runtime, not duplicate implementations", async () => {
  const pairs = [
    [await import("../../apps/headless-server/src/conversation-execution.mjs"), await import("@opencraft/access-control/conversation-execution")],
    [await import("../../apps/headless-server/src/thread-orchestration-execution.mjs"), await import("@opencraft/access-control/thread-orchestration-execution")],
    [await import("../../apps/headless-server/src/im-channels-appserver.mjs"), await import("@opencraft/access-control/im-channels-appserver")],
  ];
  for (const [legacy, packaged] of pairs) {
    assert.deepEqual(Object.keys(legacy).sort(), Object.keys(packaged).sort());
    for (const key of Object.keys(legacy)) assert.equal(legacy[key as keyof typeof legacy], packaged[key as keyof typeof packaged]);
  }
});
