import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { imageReferences, exportDeployment, roles } from '../scripts/ci/export-deployment.mjs';
const refs = Object.fromEntries(roles.map((role, index) => [role, 'registry.example/team/opencraft@sha256:' + String(index).repeat(64)]));
test('formal and fast snapshots export the same four immutable references', () => {
  assert.deepEqual(imageReferences(refs), refs);
  assert.deepEqual(imageReferences({ images: Object.fromEntries(roles.map(role => [role, { ref: refs[role], platform: { Os: 'linux', Architecture: 'amd64' } }])) }), refs);
});
test('missing fourth role, local IDs, mutable tags and wrong platform are rejected', () => {
  for (const value of [undefined, 'sha256:' + 'a'.repeat(64), 'registry.example/team/app:latest', 'registry.example/team/app@sha256:no']) {
    assert.throws(() => imageReferences({ ...refs, proxy: value }));
  }
  assert.throws(() => imageReferences({ ...refs, hands: { ref: refs.hands, platform: { Os: 'linux', Architecture: 'arm64' } } }));
});
test('bundle is self-contained, records image locks and cannot overwrite a site', () => {
  const parent = mkdtempSync(join(tmpdir(), 'portable-deploy-'));
  try {
    const output = join(parent, 'bundle');
    exportDeployment({ releaseId: 'test', sourceRevision: 'a'.repeat(40), images: refs }, output);
    assert.deepEqual(JSON.parse(readFileSync(join(output, 'release.json'))).images, refs);
    assert.equal(readFileSync(join(output, 'images.env'), 'utf8').trim().split('\n').length, 4);
    assert.match(readFileSync(join(output, 'deploy.py'), 'utf8'), /files-smoke/);
    assert.match(readFileSync(join(output, 'compose.root-hands.yaml'), 'utf8'), /OPENCRAFT_HANDS_CLIENT_UID/);
    assert.match(readFileSync(join(output, 'compose.personal-git.yaml'), 'utf8'), /OPENCRAFT_HOST_GIT_RUNTIME_DIR/);
    assert.match(readFileSync(join(output, 'site.env.example'), 'utf8'), /^OPENCRAFT_HANDS_ROOT=1$/m);
    assert.match(readFileSync(join(output, 'site.env.example'), 'utf8'), /^OPENCRAFT_PERSONAL_GIT=1$/m);
    assert.match(readFileSync(join(output, 'deploy.py'), 'utf8'), /automationCancellation/);
    assert.match(readFileSync(join(output, 'deploy.py'), 'utf8'), /personal-git-worker/);
    assert.match(readFileSync(join(output, 'workspace-preflight.mjs'), 'utf8'), /checkWorkspaces/);
    writeFileSync(join(output, 'site.env'), 'do not overwrite');
    assert.throws(() => exportDeployment(refs, output));
    assert.equal(readFileSync(join(output, 'site.env'), 'utf8'), 'do not overwrite');
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
test('portable deployment safety validation (stdlib Python)', () => {
  const result = spawnSync('python3', ['-B', 'tests/portable-deployment_test.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
