import assert from 'node:assert/strict';
import test from 'node:test';
import { ChaosViolation, shrinkChaosFailure } from './fixtures/recovery-chaos';
import { generateHostDeliveryChaos, parseHostDeliveryTrace, simulateHostDelivery, hostDeliveryActions,
  type HostDeliveryEvent } from './fixtures/host-delivery-chaos';

for (const [mutant, rule, events] of [
  ['observed-ready', 'HOST_NATIVE_READINESS', [{ type: 'open' }, { type: 'status-reentry' }]],
  ['stale-send', 'HOST_SEND_ADMISSION', [{ type: 'open' }, { type: 'frame-race' }]],
  ['retained-wait', 'HOST_WAIT_RETIREMENT', [{ type: 'open' }, { type: 'send' }, { type: 'lose' }]],
] as const) test(`Host delivery tooling control ${mutant} shrinks its exact rule and normally replays`, async () => {
  const trace: HostDeliveryEvent[] = [...events], run = (events: readonly HostDeliveryEvent[]) => simulateHostDelivery(events, { mutant });
  await assert.rejects(run(trace), (error: unknown) => error instanceof ChaosViolation && error.rule === rule && !error.cleanupFailure);
  const minimal = await shrinkChaosFailure(trace, rule, run);
  assert.equal(minimal.length, trace.length); await simulateHostDelivery(minimal);
});

test('Host delivery chaos keeps old ACKs isolated, frees budget before peer admission and explicitly heals', async () => {
  const result = await simulateHostDelivery(['open', 'send', 'lose', 'peer', 'reconnect', 'send', 'ack-old',
    'ack-old', 'status-reentry', 'frame-race', 'reconnect', 'send', 'close', 'peer', 'bridge', 'heal'].map(type => ({ type } as HostDeliveryEvent)));
  assert.ok(result.nativeAdmissions >= 3); assert.equal(result.heals, 1);
});

test('Host delivery generator/parser are bounded, deterministic and contain no implicit native heal', async () => {
  const empty = await simulateHostDelivery([]); assert.equal(empty.connectIntents, 0); assert.equal(empty.nativeEvents, 0);
  const trace = generateHostDeliveryChaos(0, 120); assert.equal(trace.length, 122); assert.equal(trace.at(-1)?.type, 'heal');
  assert.deepEqual(generateHostDeliveryChaos(0, 120), trace); assert.deepEqual(parseHostDeliveryTrace(trace), trace);
  assert.equal(new Set(trace.filter(e => e.type !== 'open').map(e => e.type)).size, hostDeliveryActions.length);
  for (const invalid of [null, [{ type: 'fake' }], [{}], Array(10001).fill({ type: 'send' })]) assert.throws(() => parseHostDeliveryTrace(invalid));
  for (let seed = 0; seed < 20; seed++) await simulateHostDelivery(generateHostDeliveryChaos(seed, 120));
});
