import assert from "node:assert/strict";
import test from "node:test";

import { anthropicCompactionResponse } from "../../packages/account-pool-host/src/anthropic-compaction.ts";

const completed = {
  id: "resp_1",
  status: "completed",
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "summary" }] }],
};

test("a completed nonempty summary becomes a compaction checkpoint", async () => {
  const response = await anthropicCompactionResponse(Response.json(completed), false);
  const body = await response.json();
  assert.equal(body.status, "completed");
  assert.equal(body.output[0].type, "compaction");
  assert.equal(body.output[0].id, "resp_1_checkpoint");
});

test("a non-object upstream body fails compaction and keeps the original history", async () => {
  for (const value of [null, [completed], "summary", 1]) {
    const response = await anthropicCompactionResponse(Response.json(value), false);
    const body = await response.json();
    assert.equal(body.status, "failed", JSON.stringify(value));
    assert.deepEqual(body.output, []);
    assert.equal(body.error.code, "compaction_failed");
  }
});
