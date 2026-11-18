import assert from "node:assert/strict";
import test from "node:test";
import { isTimelineTurnSettled, type TimelineStatus } from "../../packages/chat-core/src/index";

test("completed-message actions wait until the Turn has settled", () => {
  const expected: Record<TimelineStatus, boolean> = {
    pending: false,
    streaming: false,
    complete: true,
    failed: true,
    interrupted: true,
  };
  for (const [status, settled] of Object.entries(expected))
    assert.equal(isTimelineTurnSettled(status as TimelineStatus), settled, status);
});
