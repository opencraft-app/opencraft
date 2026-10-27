import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSocketChaos, parseSocketTrace, simulateSocketDisposal, type SocketEvent, type SocketMutant } from './fixtures/socket-disposal-chaos';
import { ChaosViolation, shrinkChaosFailure } from './fixtures/recovery-chaos';
test('Socket traces remain deterministic, validated and replayable at the size limit', () => {
  assert.deepEqual(generateSocketChaos(42, 100), generateSocketChaos(42, 100));
  assert.doesNotThrow(() => parseSocketTrace(generateSocketChaos(42, 10000)));
  for (const trace of [[{ type: 'mode', value: 'throw' }], [{ type: 'connect', host: 'foreign' }], [{ type: 'reenter', enabled: true }]]) assert.throws(() => parseSocketTrace(trace));
});
test('empty Socket trace allocates nothing', async () => { assert.equal((await simulateSocketDisposal([])).connectIntents, 0); });
test('Socket disposal, renewal, reentry, held close events and late frames retain their owners', async () => {
  for (let seed = 0; seed < 60; seed++) await simulateSocketDisposal(generateSocketChaos(seed, 120));
});
const setup: SocketEvent = { type: 'setup' }, connect: SocketEvent = { type: 'connect', host: 'a' }, stop: SocketEvent = { type: 'close' };
for (const [mutant, rule, trace] of [
  ['forget-debt', 'SOCKET_CLEANUP_PROGRESS', [setup, connect, { type: 'mode', target: 'newest', value: 'throw-before' }, stop, { type: 'mode', target: 'newest', value: 'ok' }, stop]],
  ['admit-before-close', 'SOCKET_RENEWAL_BARRIER', [setup, connect, { type: 'mode', target: 'newest', value: 'throw-before' }, { type: 'loss', target: 'newest' }, connect]],
  ['drop-local-close', 'SOCKET_LOCAL_RETIREMENT', [setup, connect, { type: 'event-fault', enabled: true }, stop]],
  ['repeat-close', 'SOCKET_SUCCESS_ONCE', [setup, connect, stop]],
] as [SocketMutant, string, SocketEvent[]][]) test(`Socket observation control ${mutant} preserves exact ${rule} through shrinking and normal replay`, async () => {
  const run = (input: readonly SocketEvent[]) => simulateSocketDisposal(input, { mutant });
  await assert.rejects(run(trace), e => e instanceof ChaosViolation && e.rule === rule);
  const minimal = await shrinkChaosFailure(trace, rule, run);
  await assert.rejects(run(minimal), e => e instanceof ChaosViolation && e.rule === rule);
  await simulateSocketDisposal(minimal); assert.ok(minimal.length <= trace.length);
});
