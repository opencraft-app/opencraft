import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { imageReferences, exportDeployment, roles, defaultTemplate, templateFiles } from '../scripts/ci/export-deployment.mjs';
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
test('default CLI exports exactly the core template files', () => {
  const parent = mkdtempSync(join(tmpdir(), 'portable-deploy-'));
  try {
    const snapshot = join(parent, 'snapshot.json'), output = join(parent, 'bundle');
    writeFileSync(snapshot, JSON.stringify({ releaseId: 'cli', images: refs }));
    execFileSync(process.execPath, ['scripts/ci/export-deployment.mjs', snapshot, output], { env: { ...process.env, NODE_OPTIONS: '' } });
    assert.deepEqual(readdirSync(output).sort(), [...templateFiles, 'images.env', 'release.json'].sort());
    for (const file of templateFiles) assert.equal(readFileSync(join(output, file), 'utf8'), readFileSync(join(defaultTemplate, file), 'utf8'), file);
    const usage = spawnSync(process.execPath, ['scripts/ci/export-deployment.mjs', snapshot], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
    assert.notEqual(usage.status, 0); assert.match(usage.stderr, /Usage:/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
test('a product template directory and extra files are explicit options', () => {
  const parent = mkdtempSync(join(tmpdir(), 'portable-deploy-'));
  try {
    const template = join(parent, 'product-template');
    cpSync(defaultTemplate, template, { recursive: true });
    writeFileSync(join(template, 'README.md'), '# Example product deployment\n');
    writeFileSync(join(template, 'register.py'), 'print("example")\n');
    writeFileSync(join(template, 'not-exported.txt'), 'private');
    exportDeployment(refs, join(parent, 'api'), { template, include: ['register.py'] });
    assert.equal(readFileSync(join(parent, 'api', 'README.md'), 'utf8'), '# Example product deployment\n');
    assert.equal(readFileSync(join(parent, 'api', 'register.py'), 'utf8'), 'print("example")\n');
    assert.equal(existsSync(join(parent, 'api', 'not-exported.txt')), false);
    const snapshot = join(parent, 'snapshot.json');
    writeFileSync(snapshot, JSON.stringify(refs));
    execFileSync(process.execPath, ['scripts/ci/export-deployment.mjs', '--template', template, '--include', 'register.py', snapshot, join(parent, 'cli')], { env: { ...process.env, NODE_OPTIONS: '' } });
    assert.deepEqual(readdirSync(join(parent, 'cli')).sort(), [...templateFiles, 'images.env', 'release.json', 'register.py'].sort());
    assert.equal(readFileSync(join(parent, 'cli', 'README.md'), 'utf8'), '# Example product deployment\n');
    for (const include of [['../register.py'], ['sub/register.py'], ['images.env'], ['README.md'], ['register.py', 'register.py'], ['missing.py']]) {
      const output = join(parent, 'rejected');
      assert.throws(() => exportDeployment(refs, output, { template, include }), include.join());
      rmSync(output, { recursive: true, force: true });
    }
    mkdirSync(join(parent, 'incomplete'));
    assert.throws(() => exportDeployment(refs, join(parent, 'from-incomplete'), { template: join(parent, 'incomplete') }), /ENOENT/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
test('portable deployment safety validation (stdlib Python)', () => {
  const result = spawnSync('python3', ['-B', 'tests/portable-deployment_test.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
