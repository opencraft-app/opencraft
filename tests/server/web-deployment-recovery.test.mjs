import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signedInspectionFixture } from '../support/full-upgrade-fixture.mjs';
import { verifyCurrentRecovery } from '../../scripts/web-deployment/recover-current.mjs';
import { sha256 } from '../../scripts/full-release/contract.mjs';
import { Journal } from '../../scripts/full-upgrade/journal.mjs';
import { webChildControl } from '../../scripts/full-upgrade/web-child.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'web-attested-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { targetRoot: join(root, 'retained'), webState: join(root, 'web'),
    trustFile: join(root, 'trust.json'), profilePath: join(root, 'profile.json') };
  await signedInspectionFixture(config);
  await writeFile(join(config.targetRoot, 'LICENSE'), 'license'); await chmod(join(config.targetRoot, 'LICENSE'), 0o644);
  await chmod(join(config.targetRoot, 'release/upgrade-policy.json'), 0o644);
  const digest = sha256(await readFile(join(config.targetRoot, 'release/full-release.json')));
  const current = { releaseRoot: config.targetRoot, version: '2.0.0', buildId: 'fixture2',
    fullRelease: { manifestSha256: digest, releaseId: 'fixture-release' } };
  const child = { schemaVersion: 1, id: '89eed8a6-6d26-49c8-a11c-3bf9d89a98e1', version: '3.0.0', buildId: 'fixture3',
    phase: 'recovery-required', startedAt: new Date().toISOString(), finishedAt: null };
  const persisted = { schemaVersion: 1, current, previous: null, job: { id: child.id, version: child.version, phase: 'failed', error: 'original rollback failed' } };
  const childPath = join(config.webState, 'upgrade-children', child.id + '.json');
  await mkdir(join(config.webState, 'upgrade-children')); await writeFile(childPath, JSON.stringify(child));
  await writeFile(join(config.webState, 'deployment.json'), JSON.stringify(persisted));
  const trust = JSON.parse(await readFile(config.trustFile, 'utf8'));
  const input = { jobId: child.id, version: current.version, buildId: current.buildId };
  const execution = { verifyRecovery: async () => ({ process: { pid: 11, bootId: 'boot', startTicks: '1' }, core: { pid: 12, codexPid: 13 } }) };
  return { config, childPath, persisted, child, args: { directory: config.webState, persisted, execution, trust, input, active: () => true } };
}

test('attested rollback retires the same unknown child, retains its original failure and reconciles idempotently', async t => {
  const { config, childPath, args, persisted } = await fixture(t);
  const journal = await new Journal(join(config.webState, 'journal')).open(); t.after(() => journal.close());
  assert.equal((await webChildControl(config, { operationId: args.input.jobId }, journal, 'boot')).state, 'recovery-required');
  const verified = await verifyCurrentRecovery(args);
  assert.equal(verified.next.job.error, persisted.job.error);
  assert.equal(verified.child.recovery.outcome, 'rolled-back');
  assert.equal(JSON.parse(await readFile(childPath, 'utf8')).phase, 'recovery-required', 'verification itself writes no receipt');
  await writeFile(join(config.webState, 'deployment.json'), JSON.stringify(verified.next));
  assert.equal((await webChildControl(config, { operationId: args.input.jobId }, journal, 'boot')).state, 'recovery-required', 'crash before child receipt stays unknown');
  await writeFile(childPath, JSON.stringify(verified.child));
  const result = await webChildControl(config, { operationId: args.input.jobId }, journal, 'boot');
  assert.equal(result.state, 'rolled-back'); assert.equal(result.components[0].healthy, true);
  assert.equal((await journal.load(result.jobId)).steps[0].receipt.outcome, 'not-applied');
  // A later update replaces deployment.job. The old verified terminal receipt
  // must remain terminal, rather than re-blocking all subsequent installs.
  await writeFile(join(config.webState, 'deployment.json'), JSON.stringify({ ...verified.next, job: { id: 'later' } }));
  assert.equal((await webChildControl(config, { operationId: args.input.jobId }, journal, 'boot')).state, 'rolled-back');
});

for (const scenario of ['wrong-job', 'wrong-version', 'wrong-build', 'unknown-field', 'unavailable-execution', 'active-owner-changed', 'corrupted-package', 'revoked-key', 'disk-state-changed']) {
  test(`recovery refuses ${scenario} without changing the unknown child`, async t => {
    const { config, childPath, args } = await fixture(t);
    if (scenario === 'wrong-job') args.input.jobId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    if (scenario === 'wrong-version') args.input.version = '9.0.0';
    if (scenario === 'wrong-build') args.input.buildId = 'wrong';
    if (scenario === 'unknown-field') args.input.force = true;
    if (scenario === 'unavailable-execution') args.execution.verifyRecovery = async () => { throw new Error('unavailable'); };
    if (scenario === 'active-owner-changed') args.active = () => false;
    if (scenario === 'corrupted-package') await writeFile(join(config.targetRoot, 'LICENSE'), 'changed');
    if (scenario === 'revoked-key') args.trust.revokedKeyIds = ['fixture'];
    if (scenario === 'disk-state-changed') args.execution.verifyRecovery = async () => { await writeFile(join(config.webState, 'deployment.json'), '{}'); return {}; };
    await assert.rejects(verifyCurrentRecovery(args));
    assert.equal(JSON.parse(await readFile(childPath, 'utf8')).phase, 'recovery-required');
  });
}

test('terminal recovery claim missing the matching durable deployment evidence remains unknown', async t => {
  const { config, childPath, args } = await fixture(t);
  const verified = await verifyCurrentRecovery(args);
  await writeFile(childPath, JSON.stringify(verified.child));
  const journal = await new Journal(join(config.webState, 'journal')).open(); t.after(() => journal.close());
  assert.equal((await webChildControl(config, { operationId: args.input.jobId }, journal, 'boot')).state, 'recovery-required');
});
