import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signBytes } from '../../scripts/full-release/contract.mjs';
import { acceptGenerationPlan, switchGeneration } from '../../scripts/full-upgrade/generation-upgrade.mjs';
import { fingerprint } from '../../scripts/full-upgrade/inventory.mjs';
import { Journal } from '../../scripts/full-upgrade/journal.mjs';
const hash = 'a'.repeat(64);
const combination = { ownerId: 'codex', targetId: 'new', from: 'fixture-old', to: 'fixture-new' };
function planFixture(selectedCombination = combination) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const matrixBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'opencraft.generation-compatibility', manifestSha256: hash,
    expiresAt: Date.now() + 3600000, combinations: [{ combination: selectedCombination, status: 'verified', forward: true, rollback: true, retainBindings: true }] }));
  const args = { manifestSha256: hash, inventoryFingerprint: hash, policy: { retain: true }, matrixBytes,
    signature: signBytes(matrixBytes, privateKey, 'fixture'), trust: { keys: { fixture: publicKey.export({ type: 'spki', format: 'pem' }) } }, combination: selectedCombination };
  return { args, plan: acceptGenerationPlan(args) };
}
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'p2c-journal-'));
  const journal = await new Journal(join(root, 'journal')).open();
  t.after(async () => { await journal.close(); await rm(root, { recursive: true, force: true }); });
  const state = { owner: 'owner-1', epoch: 1, current: 'old', generations: [{ id: 'old', state: 'active', incarnation: 1 }] };
  const calls = [];
  const owner = { id: 'codex', snapshot: async () => structuredClone(state),
    prepare: async () => { calls.push('prepare'); state.generations.push({ id: 'new', state: 'ready', incarnation: 1 }); },
    preparation: async (id, expected) => { assert.equal(state.owner, expected.owner, 'owner changed'); return { id, owner: state.owner, epoch: state.epoch }; },
    activate: async (id, expected, proof, operationId) => {
      calls.push('activate:' + id); assert.equal(expected.epoch, state.epoch); assert.equal(proof.epoch, state.epoch);
      state.current = id; state.epoch++; state.lastActivation = { operationId, owner: state.owner, generationId: id, epoch: state.epoch }; state.generations.forEach(g => { g.state = g.id === id ? 'active' : 'draining'; });
    }, cleanup: async () => { calls.push('cleanup'); return { retained: true }; }, ...overrides };
  const { plan } = planFixture({ ...combination, from: fingerprint(state) });
  const args = { plan, operationId: 'fixture-op', bootId: 'fixture-boot', journal, lockPath: join(root, 'host.lock'), owner, targetId: 'new', validate: async () => true };
  return { args, state, calls, journal, owner };
}
test('P2c signed matrix is an exact allowlist and plan binds policy, inventory and target', () => {
  const { args, plan } = planFixture();
  for (const update of [{ manifestSha256: 'b'.repeat(64) }, { combination: { ...combination, to: 'untested' } }, { now: Date.now() + 7200000 }, { trust: { ...args.trust, revokedKeyIds: ['fixture'] } }]) assert.throws(() => acceptGenerationPlan({ ...args, ...update }));
  assert.notEqual(acceptGenerationPlan({ ...args, policy: { retain: false } }).planDigest, plan.planDigest);
  assert.notEqual(acceptGenerationPlan({ ...args, inventoryFingerprint: 'b'.repeat(64) }).planDigest, plan.planDigest);
});
test('P2c accepted default retains old work and repeated operation does not mutate', async t => {
  const f = await fixture(t); assert.equal((await switchGeneration(f.args)).state, 'active-draining');
  assert.equal(f.state.current, 'new'); assert.equal(f.state.generations[0].state, 'draining');
  await switchGeneration(f.args); assert.deepEqual(f.calls, ['prepare', 'activate:new']);
});
test('P2c plan drift before prepare blocks without mutation', async t => {
  const f = await fixture(t); f.args.validate = async () => false;
  assert.equal((await switchGeneration(f.args)).state, 'blocked'); assert.deepEqual(f.calls, []);
});
test('P2c drift before activation revokes only unadmitted candidate', async t => {
  const f = await fixture(t); f.args.validate = async (_, stage) => stage === 'before-prepare';
  assert.equal((await switchGeneration(f.args)).state, 'rolled-back'); assert.deepEqual(f.calls, ['prepare', 'cleanup']);
});
test('P2c lost activation reply compensates only the exact activation CAS, retaining new bindings', async t => {
  const f = await fixture(t), activate = f.owner.activate;
  f.owner.activate = async (...args) => { await activate(...args); if (args[0] === 'new') throw new Error('reply lost'); return {}; };
  assert.equal((await switchGeneration(f.args)).state, 'rolled-back');
  assert.equal(f.state.current, 'old'); assert.equal(f.state.epoch, 3);
  assert.deepEqual(f.calls, ['prepare', 'activate:new', 'activate:old', 'cleanup']);
});
for (const drift of ['owner', 'epoch']) test(`P2c ${drift} drift after activation prevents stale compensation`, async t => {
  const f = await fixture(t), activate = f.owner.activate;
  f.owner.activate = async (...args) => { await activate(...args); if (drift === 'owner') f.state.owner = 'owner-2'; else f.state.epoch++; throw new Error('uncertain'); };
  assert.equal((await switchGeneration(f.args)).state, 'recovery-required'); assert.deepEqual(f.calls, ['prepare', 'activate:new']);
});
test('P2c journal fsync failure stops all owner mutations and does not compensate', async t => {
  const f = await fixture(t), persist = f.journal.persist; let n = 0;
  f.journal.persist = async (...args) => { if (++n === 2) throw new Error('ENOSPC'); return persist(...args); };
  await assert.rejects(switchGeneration(f.args)); assert.deepEqual(f.calls, []);
});
test('P2c restart with uncertain intent never replays prepare or activation', async t => {
  const f = await fixture(t), persist = f.journal.persist; let n = 0;
  f.journal.persist = async (...args) => { if (++n === 3) throw new Error('receipt lost'); return persist(...args); };
  await assert.rejects(switchGeneration(f.args)); assert.deepEqual(f.calls, ['prepare']);
  await f.journal.close(); f.args.journal = await new Journal(f.journal.directory).open(); t.after(() => f.args.journal.close());
  assert.equal((await switchGeneration(f.args)).state, 'recovery-required'); assert.deepEqual(f.calls, ['prepare']);
});


test('P2c a competing activation before this operation intent is never compensated', async t => {
  const f = await fixture(t);
  f.args.validate = async (_, stage) => {
    if (stage === 'before-prepare') return true;
    f.state.current = 'new'; f.state.epoch = 2;
    f.state.lastActivation = { operationId: 'foreign', generationId: 'new', epoch: 2, owner: f.state.owner };
    return false;
  };
  assert.equal((await switchGeneration(f.args)).state, 'recovery-required');
  assert.deepEqual(f.calls, ['prepare']);
});
test('P2c a foreign activation with this operation intent is never compensated', async t => {
  const f = await fixture(t);
  f.owner.activate = async () => {
    f.calls.push('foreign-activation'); f.state.current = 'new'; f.state.epoch = 2;
    f.state.lastActivation = { operationId: 'foreign', generationId: 'new', epoch: 2, owner: f.state.owner };
    throw new Error('CAS rejected');
  };
  assert.equal((await switchGeneration(f.args)).state, 'recovery-required');
  assert.deepEqual(f.calls, ['prepare', 'foreign-activation']);
});
test('P2c prepare reply loss with a late candidate cannot report rolled-back from absence', async t => {
  const f = await fixture(t); let finish;
  const late = new Promise(resolve => { finish = resolve; }).then(() => f.state.generations.push({ id: 'new', state: 'ready', incarnation: 1 }));
  f.owner.prepare = async () => { f.calls.push('prepare'); throw new Error('request still running'); };
  assert.equal((await switchGeneration(f.args)).state, 'recovery-required');
  finish(); await late;
  assert.equal((await f.journal.load('fixture-op')).state, 'recovery-required'); assert.deepEqual(f.calls, ['prepare']);
});
test('P2c owner replacement just before preparation cannot activate the new owner with an old plan', async t => {
  const f = await fixture(t);
  f.args.validate = async (_, stage) => { if (stage === 'before-activate') f.state.owner = 'owner-2'; return true; };
  assert.equal((await switchGeneration(f.args)).state, 'recovery-required'); assert.deepEqual(f.calls, ['prepare']);
});

test('P2c ACP executable and script must be immutable members of the signed closure', { skip: process.getuid?.() !== 0 }, async t => {
  const { acpExecutionIdentity } = await import('../../scripts/full-upgrade/generation-control.mjs');
  const { homedir } = await import('node:os');
  const { writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(homedir(), '.p2c-closure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = join(root, 'interpreter'), script = join(root, 'peer.mjs');
  await writeFile(command, 'fixture-node'); await writeFile(script, 'fixture-code');
  const config = { command, args: [script] }, first = await acpExecutionIdentity(config, root);
  await writeFile(script, 'changed-code'); assert.notEqual(await acpExecutionIdentity(config, root), first);
  await assert.rejects(acpExecutionIdentity({ command: process.execPath, args: [script] }, root), /outside-signed-closure/);
  await assert.rejects(acpExecutionIdentity({ command, args: ['peer.mjs'] }, root), /argument-closure/);
  await assert.rejects(acpExecutionIdentity({ ...config, env: { NODE_OPTIONS: '--require /unverified.js' } }, root), /loader-environment/);
});

test('P2c locked snapshot drift cannot replace the signed plan owner/Host identity', async t => {
  const f = await fixture(t); f.state.host = 'replacement-host-lease';
  assert.equal((await switchGeneration(f.args)).state, 'blocked'); assert.deepEqual(f.calls, []);
});
