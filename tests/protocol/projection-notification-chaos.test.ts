import assert from "node:assert/strict";
import test from "node:test";
import { generateProjectionChaos, parseProjectionTrace, simulateProjectionNotifications, type ProjectionChaosEvent } from "./fixtures/projection-notification-chaos";
import { ChaosViolation, shrinkChaosFailure } from "./fixtures/recovery-chaos";

test("projection chaos keeps native resource and peer delivery independent of Read", async () => {
  assert.deepEqual(generateProjectionChaos(42), generateProjectionChaos(42)); const totals: Record<string, number> = {};
  for (let seed = 0; seed < 8; seed++) {
    const result = await simulateProjectionNotifications(generateProjectionChaos(seed));
    for (const [key, value] of Object.entries(result.coverage)) totals[key] = (totals[key] ?? 0) + value;
  }
  for (const key of ["effective-read-a", "effective-read-b", "effective-read-workbench", "native-during-a-read", "native-during-b-read", "effective-cancel-a", "effective-cancel-b", "native-retirement", "snapshot-overlap", "bad-projector"]) assert.ok(totals[key], key);
});
for (const [mutant, prefix, rule] of [
  ["global-buffer", ["read-a"], "NATIVE_NOTIFICATION"],
  ["peer-buffer", ["read-a"], "PEER_INDEPENDENT"],
  ["native-replay", [], "NATIVE_NOTIFICATION"],
  ["drop-projection", [], "PROJECTION_CONSERVED"],
  ["missing-restore-wake", ["archive", "restore"], "RESOURCE_RESTORE_PROGRESS"],
] as const) test(`projection chaos detects ${mutant}, shrinks the same rule and replays normally`, { timeout: 10000 }, async () => {
  const trace: ProjectionChaosEvent[] = ["pad", ...prefix, "observe", "pad"].map(type => ({ type }));
  const run = (events: readonly ProjectionChaosEvent[]) => simulateProjectionNotifications(events, { mutant });
  const exact = (error: unknown) => error instanceof ChaosViolation && error.rule === rule && error.cleanupFailure === undefined;
  await assert.rejects(run(trace), exact); const minimal = await shrinkChaosFailure(trace, rule, run);
  await assert.rejects(run(minimal), exact); await simulateProjectionNotifications(parseProjectionTrace(minimal));
});
test("projection replay rejects unknown events and non-arrays", () => {
  assert.throws(() => parseProjectionTrace([{ type: "invented" }])); assert.throws(() => parseProjectionTrace(null));
});
