import test from "node:test";
import assert from "node:assert/strict";
import { DshExecutionRecord } from "../apps/local-agent-host/src/dsh-execution-record.js";
test("real projection lifecycle records bounded telemetry without sensitive payloads", () => {
  const execution = new DshExecutionRecord("s", "t", "/");
  execution.project({ type: "turn/start", seq: 1, time: 1000, data: { turn: 1 } });
  execution.project({ type: "assistant/chunk", seq: 2, time: 1100, data: { chunk: { type: "text-delta", index: 0, text: "sensitive-fixture-text" } } });
  execution.project({ type: "turn/end", seq: 3, time: 1200, data: { reason: { kind: "completed" } } });
  const snapshot = execution.telemetry.snapshot();
  assert.equal(snapshot.status, "ok");
  assert.equal(snapshot.events, 3);
  assert.equal(snapshot.textDeltas, 1);
  assert.equal(snapshot.nativeWatermark, 3);
  assert.equal(JSON.stringify(snapshot).includes("sensitive-fixture-text"), false);
  assert.ok(snapshot.endedAt !== null);
});
