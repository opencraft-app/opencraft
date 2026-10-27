import assert from "node:assert/strict";
import test from "node:test";
import { generateStopChaos, parseStopTrace, simulateStopRecovery, type StopChaosEvent } from "./fixtures/stop-recovery-chaos";
import { ChaosViolation, shrinkChaosFailure } from "./fixtures/recovery-chaos";

test("stop chaos drives retained history, reply receipts, reentry and uncertain results", async () => {
  assert.deepEqual(generateStopChaos(42), generateStopChaos(42));
  const totals: Record<string, number> = {};
  for (let seed = 0; seed < 12; seed++) {
    const result = await simulateStopRecovery(generateStopChaos(seed));
    for (const [key, value] of Object.entries(result.coverage)) totals[key] = (totals[key] ?? 0) + value;
  }
  for (const key of ["stop-before-history", "stop-before-prompt-receipt", "effective-reenter", "effective-dispose-on-send", "effective-release-on-send", "stale-target-rejected", "uncertain-stop"]) assert.ok(totals[key], key);
});
for (const [mutant, prefix, rule] of [
  ["history-gated-stop", ["read"], "STOP_PROGRESS"],
  ["prompt-gated-stop", ["hold-receipt", "question"], "STOP_PROGRESS"],
  ["retarget-stop", [], "STOP_TARGET"],
  ["replay-stop", [], "STOP_NO_REPLAY"],
] as const) test(`stop chaos detects ${mutant}, preserves its rule while shrinking and replays normally`, { timeout: 10000 }, async () => {
  const trace: StopChaosEvent[] = ["pad", ...prefix, "stop", "pad"].map(type => ({ type }));
  const run = (events: readonly StopChaosEvent[]) => simulateStopRecovery(events, { mutant });
  const exact = (error: unknown) => error instanceof ChaosViolation && error.rule === rule && error.cleanupFailure === undefined;
  await assert.rejects(run(trace), exact);
  const minimal = await shrinkChaosFailure(trace, rule, run);
  await assert.rejects(run(minimal), exact); await simulateStopRecovery(parseStopTrace(minimal));
});
test("stop replay rejects unknown event types and invalid input", () => {
  assert.throws(() => parseStopTrace([{ type: "invented" }]));
  assert.throws(() => parseStopTrace(null));
});
