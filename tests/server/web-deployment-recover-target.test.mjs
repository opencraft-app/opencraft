import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { targetRecoveryFixture as fixture } from '../support/target-recovery-fixture.mjs';
import { verifyFailedTarget } from '../../scripts/web-deployment/recover-target.mjs';

for (const scenario of ['wrong-job', 'wrong-version', 'wrong-build', 'wrong-manifest', 'arbitrary-path', 'child-manifest', 'child-path', 'child-phase', 'corrupt-file', 'new-watermark', 'digest-collision', 'revoked', 'owner-conflict', 'owner-changed']) {
  test(`same-target recovery refuses ${scenario} before any activation`, async t => {
    const f = await fixture(t);
    if (scenario === 'wrong-job') f.input.jobId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    if (scenario === 'wrong-version') f.input.version = '9.0.0';
    if (scenario === 'wrong-build') f.input.buildId = 'other';
    if (scenario === 'wrong-manifest') f.input.manifestSha256 = 'a'.repeat(64);
    if (scenario === 'arbitrary-path') f.input.path = f.config.targetRoot;
    if (scenario === 'child-manifest') f.child.manifestSha256 = 'a'.repeat(64);
    if (scenario === 'child-path') f.child.retainedRoot = f.persisted.current.releaseRoot;
    if (scenario === 'child-phase') f.child.phase = 'completed';
    await writeFile(f.childPath, JSON.stringify(f.child));
    if (scenario === 'corrupt-file') await writeFile(join(f.config.targetRoot, 'LICENSE'), 'changed');
    if (scenario === 'new-watermark' || scenario === 'digest-collision') {
      const path = join(f.config.webState, 'full-release-state.json');
      const state = JSON.parse(await readFile(path, 'utf8'));
      if (scenario === 'new-watermark') state.highestSequence++;
      else state.manifestSha256 = 'b'.repeat(64);
      await writeFile(path, JSON.stringify(state));
    }
    if (scenario === 'revoked') f.trust.revokedKeyIds = ['fixture'];
    if (scenario === 'owner-conflict') f.args.upgrade = async () => ({ allowed: false });
    if (scenario === 'owner-changed') f.args.active = () => false;
    const before = await readFile(join(f.config.webState, 'full-release-state.json'), 'utf8');
    await assert.rejects(verifyFailedTarget(f.args));
    assert.equal(await readFile(join(f.config.webState, 'full-release-state.json'), 'utf8'), before);
    assert.equal(JSON.parse(await readFile(join(f.config.webState, 'deployment.json'), 'utf8')).job.error, f.persisted.job.error);
  });
}
