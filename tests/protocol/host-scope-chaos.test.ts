import assert from 'node:assert/strict';
import test from 'node:test';
import { generateScopeChaos, parseScopeTrace, simulateHostScopes, type ScopeEvent, type ScopeMutant } from './fixtures/host-scope-chaos';
import { ChaosViolation, shrinkChaosFailure } from './fixtures/recovery-chaos';

test('Host scope traces are deterministic and validate their saved identity fields', () => {
  assert.deepEqual(generateScopeChaos(42, 80), generateScopeChaos(42, 80));
  assert.deepEqual(parseScopeTrace(generateScopeChaos(0, 0)), generateScopeChaos(0, 0));
  assert.throws(() => parseScopeTrace([{ type: 'grant', host: 'foreign' }]));
  assert.throws(() => parseScopeTrace([{ type: 'late', host: 'a' }]));
  assert.throws(() => parseScopeTrace([{ type: 'setup', layout: 'shared' }]));
});
test('empty Host scope traces allocate no providers or clients', async () => {
  const result = await simulateHostScopes([]); assert.equal(result.connectIntents, 0); assert.equal(result.nativeAdmissions, 0);
});
test('repeated cross-Host rounds preserve their own native clients and physical owners', async () => {
  for (let seed = 0; seed < 40; seed++) await simulateHostScopes(generateScopeChaos(seed, 80));
});
const setup: ScopeEvent = { type: 'setup', layout: 'shared', lifetime: 'server', noticeA: 'success', noticeB: 'success' };
test('explicit heals create new Renderer incarnations on the same Host server', async () => {
  const events: ScopeEvent[] = [setup];
  for (let i = 0; i < 4; i++) events.push({ type: 'grant', host: 'a' }, { type: 'grant', host: 'b' }, { type: 'retire', host: 'a' }, { type: 'probe', host: 'b' }, { type: 'heal' });
  const result = await simulateHostScopes(events); assert.equal(result.connectIntents, 8); assert.equal(result.cleanupCalls, 8); assert.equal(result.coverage['cycle.heal'], 4);
});
for (const [mutant, rule, events] of [
  ['notify-peer', 'SCOPE_NOTIFICATION_TARGET', [setup, { type: 'grant', host: 'a' }, { type: 'grant', host: 'b' }, { type: 'retire', host: 'a' }]],
  ['drop-reply', 'SCOPE_RPC_REPLY', [{ ...setup, layout: 'opaque' }, { type: 'grant', host: 'a' }, { type: 'grant', host: 'b' }]],
  ['leak-native', 'SCOPE_NATIVE_CLIENTS', [setup, { type: 'grant', host: 'a' }, { type: 'retire', host: 'a' }]],
] as [ScopeMutant, string, ScopeEvent[]][]) test(`Host scope control ${mutant} shrinks under its exact rule and replays normally`, async () => {
  const run = (input: readonly ScopeEvent[]) => simulateHostScopes(input, { mutant });
  await assert.rejects(run(events), error => error instanceof ChaosViolation && error.rule === rule);
  const minimal = await shrinkChaosFailure(events, rule, run);
  await assert.rejects(run(minimal), error => error instanceof ChaosViolation && error.rule === rule);
  await simulateHostScopes(minimal); assert.ok(minimal.length <= events.length);
});
