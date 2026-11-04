import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialReadinessPolicy, validateInitialReadinessPolicy, readInitialReadinessPolicy,
  selectInitialReadinessBudget, validateInitialReadinessAttempt } from '../../scripts/server-deployment/initial-readiness-budget.mjs';

const release = { version: '2.0.0', buildId: 'fixed-build', fullRelease: {
  authorization: 'verified-installation', manifestSha256: 'a'.repeat(64), releaseSequence: 7 } };
const target = { version: release.version, buildId: release.buildId,
  manifestSha256: release.fullRelease.manifestSha256, releaseSequence: 7 };
const record = () => ({ policy: initialReadinessPolicy({ ...target }), policySha256: 'b'.repeat(64) });

test('no policy keeps the default, only all four verified target fields select a long attempt', async () => {
  assert.equal(await selectInitialReadinessBudget('/missing', release, 'job', null, { readPolicy: async () => null }), null);
  const chosen = await selectInitialReadinessBudget('/policy', release, 'job', null, { readPolicy: async () => record(), now: 1000 });
  assert.equal(chosen.deadlineAt, 1_801_000);
  assert.equal(chosen.reason, 'root-owned-exact-target'); assert.equal(chosen.jobId, 'job');
  for (const field of Object.keys(target)) {
    const different = structuredClone(release);
    if (field === 'releaseSequence') different.fullRelease[field]++;
    else if (field === 'manifestSha256') different.fullRelease[field] = 'c'.repeat(64);
    else different[field] += '-other';
    assert.equal(await selectInitialReadinessBudget('/policy', different, 'job', null, { readPolicy: async () => record() }), null, field);
  }
  assert.equal(await selectInitialReadinessBudget('/policy', { version: '2.0.0', buildId: 'fixed-build' }, 'job', null,
    { readPolicy: async () => record() }), null, 'a waiting policy cannot authorize unsigned input');
});

test('same accepted attempt retains its exhausted deadline; changed policy, job or target rejects', async () => {
  const chosen = await selectInitialReadinessBudget('/policy', release, 'job', null, { readPolicy: async () => record(), now: 1000 });
  assert.equal(await selectInitialReadinessBudget('/policy', release, 'job', chosen,
    { readPolicy: async () => record(), now: 9_000_000 }), chosen);
  for (const [job, nextRelease, readPolicy] of [
    ['other', release, async () => record()], ['job', { ...release, buildId: 'other' }, async () => record()],
    ['job', release, async () => null], ['job', release, async () => ({ ...record(), policySha256: 'c'.repeat(64) })],
  ]) await assert.rejects(selectInitialReadinessBudget('/policy', nextRelease, job, chosen, { readPolicy }));
  for (const malformed of [false, 0, '', {}]) await assert.rejects(selectInitialReadinessBudget('/policy', release, 'job', malformed, { readPolicy: async () => record() }));
  assert.throws(() => validateInitialReadinessAttempt({ ...chosen, deadlineAt: chosen.deadlineAt + 1 }, release, 'job'));
});

test('bad policy is explicit failure, never a silent short-budget fallback', async () => {
  for (const change of [p => p.timeoutMs = 1, p => p.timeoutMs = 3_600_000, p => p.kind = 'other',
    p => p.target.manifestSha256 = 'bad', p => p.target.releaseSequence = 0, p => p.path = '/arbitrary',
    p => p.target.extra = true]) {
    const value = record(); change(value.policy);
    assert.throws(() => validateInitialReadinessPolicy(value.policy));
    await assert.rejects(selectInitialReadinessBudget('/policy', release, 'job', null, { readPolicy: async () => value }));
  }
});

test('protected record loader rejects links, writable mode, oversized and malformed files', { skip: process.getuid?.() !== 0 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'readiness-record-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'policy'), options = { validateRoot: async () => {} };
  await writeFile(path, JSON.stringify(record().policy), { mode: 0o600 });
  assert.deepEqual(JSON.parse(JSON.stringify((await readInitialReadinessPolicy(path, options)).policy)), record().policy);
  await chmod(path, 0o644); await assert.rejects(readInitialReadinessPolicy(path, options)); await chmod(path, 0o600);
  await symlink(path, join(dir, 'alias')); await assert.rejects(readInitialReadinessPolicy(join(dir, 'alias'), options));
  await link(path, join(dir, 'hard')); await assert.rejects(readInitialReadinessPolicy(path, options)); await rm(join(dir, 'hard'));
  for (const value of ['{bad', 'x'.repeat(16_385)]) { await writeFile(path, value); await assert.rejects(readInitialReadinessPolicy(path, options)); }
});
