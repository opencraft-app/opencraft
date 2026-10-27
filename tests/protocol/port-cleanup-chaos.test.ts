import assert from 'node:assert/strict';
import test from 'node:test';
import { generatePortChaos, parsePortTrace, simulatePortCleanup, type PortEvent, type PortMutant } from './fixtures/port-cleanup-chaos';
import { ChaosViolation, shrinkChaosFailure } from './fixtures/recovery-chaos';
test('Port saved inputs are deterministic, bounded and validated', () => {
  assert.deepEqual(generatePortChaos(17, 100), generatePortChaos(17, 100));
  assert.doesNotThrow(() => parsePortTrace(generatePortChaos(17, 10000)));
  for (const value of [null, [{ type: 'fault', value: 'skip' }], [{ type: 'setup', side: 'client' }], [{ type: 'reenter', enabled: 'yes' }]]) assert.throws(() => parsePortTrace(value));
});
test('empty Port traces have no cleanup side effects', async () => { assert.equal((await simulatePortCleanup([])).cleanupCalls, 0); });
test('random Port faults, reentry, late delivery and recovery preserve ownership', async () => {
  for (let seed = 0; seed < 40; seed++) await simulatePortCleanup(generatePortChaos(seed, 100));
});
const setup: PortEvent = { type: 'setup', side: 'client', ready: false, peer: false, lifetime: 'last-claim' };
for (const [mutant, rule, events] of [
  ['orphan-wait', 'PORT_LOCAL_SETTLEMENT', [setup, { type: 'fault', value: 'remove' }, { type: 'stop' }]],
  ['orphan-native', 'PORT_NATIVE_RETIREMENT', [{ ...setup, side: 'server' }, { type: 'stop' }]],
  ['forget-handle', 'PORT_HANDLE_RETRY', [setup, { type: 'fault', value: 'remove' }, { type: 'stop' }, { type: 'fault', value: 'none' }, { type: 'stop' }]],
  ['duplicate-terminal', 'PORT_TERMINAL_ONCE', [setup, { type: 'stop' }]],
] as [PortMutant, string, PortEvent[]][]) test(`Port observation control ${mutant} shrinks under exact ${rule} and replays without control`, async () => {
  const run = (input: readonly PortEvent[]) => simulatePortCleanup(input, { mutant });
  await assert.rejects(run(events), e => e instanceof ChaosViolation && e.rule === rule);
  const minimal = await shrinkChaosFailure(events, rule, run);
  await assert.rejects(run(minimal), e => e instanceof ChaosViolation && e.rule === rule);
  await simulatePortCleanup(minimal); assert.ok(minimal.length <= events.length);
});
