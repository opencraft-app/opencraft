import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { imageReferences, exportDeployment, roles, defaultTemplate, templateFiles, coreComposeFiles } from '../scripts/ci/export-deployment.mjs';
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
    // The deployment model is the source deployment's Compose file, byte for byte.
    for (const [file, source] of Object.entries(coreComposeFiles)) assert.equal(readFileSync(join(output, file), 'utf8'), readFileSync(source, 'utf8'), file);
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
    assert.deepEqual(readdirSync(output).sort(), [...templateFiles, ...Object.keys(coreComposeFiles), 'images.env', 'release.json'].sort());
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
    assert.deepEqual(readdirSync(join(parent, 'cli')).sort(), [...templateFiles, ...Object.keys(coreComposeFiles), 'images.env', 'release.json', 'register.py'].sort());
    assert.equal(readFileSync(join(parent, 'cli', 'README.md'), 'utf8'), '# Example product deployment\n');
    for (const include of [['../register.py'], ['sub/register.py'], ['images.env'], ['README.md'], ['register.py', 'register.py'], ['missing.py']]) {
      const output = join(parent, 'rejected');
      assert.throws(() => exportDeployment(refs, output, { template, include }), include.join());
      rmSync(output, { recursive: true, force: true });
    }
    // A template cannot carry its own copy of the deployment model.
    writeFileSync(join(template, 'compose.yaml'), 'services: {}\n');
    assert.throws(() => exportDeployment(refs, join(parent, 'forked-model'), { template }), /comes from core deploy\/docker/);
    assert.equal(existsSync(join(parent, 'forked-model')), false);
    mkdirSync(join(parent, 'incomplete'));
    assert.throws(() => exportDeployment(refs, join(parent, 'from-incomplete'), { template: join(parent, 'incomplete') }), /ENOENT/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
test('portable deployment safety validation (stdlib Python)', () => {
  const result = spawnSync('python3', ['-B', 'tests/portable-deployment_test.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

// The portable overlay may change only what a portable site selects; everything
// else (services, link volumes, agent tmpfs, proxy, environment) is compose.yaml's.
test('compose.portable.yaml only names the project and the Gateway listener', () => {
  const keys = readFileSync(join(defaultTemplate, 'compose.portable.yaml'), 'utf8').split('\n')
    .filter(line => line.trim() && !line.trimStart().startsWith('#')).map(line => line.match(/^( *)([A-Za-z0-9_.-]+):/))
    .filter(Boolean).map(([, indent, key]) => indent.length / 2 + ':' + key);
  assert.deepEqual(keys, ['0:name', '0:services', '1:gateway', '2:command']);
  assert.ok(!templateFiles.includes('compose.yaml') && !existsSync(join(defaultTemplate, 'compose.yaml')),
    'the portable template must not carry its own copy of the deployment model');
});

const composeAvailable = () => spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0;
test('a portable bundle renders the source deployment model and passes deploy.py (root and nonroot Hands)', t => {
  if (!composeAvailable()) return t.skip('Docker Compose CLI is unavailable');
  const parent = mkdtempSync(join(tmpdir(), 'portable-deploy-'));
  try {
    const bundle = join(parent, 'bundle');
    exportDeployment(refs, bundle);
    const site = readFileSync(join(bundle, 'site.env.example'), 'utf8').replaceAll('/srv/opencraft', join(parent, 'site'));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENCRAFT|COMPOSE)_/.test(key)));
    const render = (directory, files) => JSON.parse(execFileSync('docker', ['compose', '--project-directory', directory,
      '--env-file', join(bundle, 'site.env'), '--env-file', join(bundle, 'images.env'), ...files.flatMap(file => ['-f', file]),
      'config', '--format', 'json'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }));
    for (const rootHands of ['1', '0']) {
      writeFileSync(join(bundle, 'site.env'), site.replace(/^OPENCRAFT_HANDS_ROOT=1$/m, 'OPENCRAFT_HANDS_ROOT=' + rootHands));
      const profiles = [...(rootHands === '1' ? ['compose.root-hands.yaml'] : []), 'compose.personal-git.yaml'];
      const portable = render(bundle, ['compose.yaml', 'compose.role-images.yaml', 'compose.portable.yaml', ...profiles].map(file => join(bundle, file)));
      const source = render(bundle, ['deploy/docker/compose.yaml', 'deploy/docker/compose.role-images.yaml',
        ...profiles.map(file => 'deploy/docker/deploy/' + file)].map(file => join(process.cwd(), file)));
      assert.deepEqual(Object.keys(portable.services).sort(), ['brain', 'gateway', 'hands', 'proxy']);
      assert.deepEqual(portable.volumes, source.volumes, 'link volumes');
      for (const role of Object.keys(source.services)) {
        const { command: portableCommand, ...rest } = portable.services[role];
        const { command: sourceCommand, ...expected } = source.services[role];
        assert.deepEqual(rest, expected, role);
        if (role !== 'gateway') { assert.deepEqual(portableCommand, sourceCommand, role); continue; }
        // The only delta: an explicit listener with access control on.
        const strip = command => command.filter((value, index) => value !== '--access-control' && value !== '--host' && command[index - 1] !== '--host');
        assert.deepEqual(strip(portableCommand), strip(sourceCommand).map(value => value === '10000' ? '11080' : value));
        assert.ok(portableCommand.includes('--access-control'));
      }
      assert.equal(portable.services.hands.user, rootHands === '1' ? '0:0' : '1000:1000');
      // deploy.py accepts exactly this rendering, so a change to compose.yaml that the
      // portable preflight does not understand fails here instead of on a site.
      writeFileSync(join(parent, 'config.json'), JSON.stringify(portable));
      const check = spawnSync('python3', ['-B', '-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('deploy', sys.argv[1]); deploy = importlib.util.module_from_spec(spec); spec.loader.exec_module(deploy)
deploy.validate(json.load(open(sys.argv[2])), json.load(open(sys.argv[3])))
deploy.directory_plan(json.load(open(sys.argv[2]))['services'], (1000, 1000))
`, join(bundle, 'deploy.py'), join(parent, 'config.json'), join(bundle, 'release.json')], { encoding: 'utf8' });
      assert.equal(check.status, 0, check.stderr);
    }
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
