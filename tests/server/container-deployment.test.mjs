import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { deploymentPaths, readPrivateToken } from '../../scripts/container-deployment/paths.mjs';
import { handsResources } from '../../scripts/container-deployment/resources.mjs';
import { OWNER_ORDER, assertImageReference, deploymentIdentity, parseEnvironment, setEnvironmentValue } from '../../scripts/container-deployment/compose-release.mjs';

test('Compose release transactions preserve env content and owner dependency order', () => {
  assert.deepEqual(OWNER_ORDER, ['hands', 'brain', 'gateway']);
  const source = '# deployment\nOPENCRAFT_IMAGE=opencraft:v1\nOPENCRAFT_PORT=10000\n';
  assert.deepEqual(parseEnvironment(source), { OPENCRAFT_IMAGE: 'opencraft:v1', OPENCRAFT_PORT: '10000' });
  assert.equal(setEnvironmentValue(source, 'OPENCRAFT_IMAGE', 'ghcr.io/opencraft-app/opencraft@sha256:abc'),
    '# deployment\nOPENCRAFT_IMAGE=ghcr.io/opencraft-app/opencraft@sha256:abc\nOPENCRAFT_PORT=10000\n');
  assert.throws(() => setEnvironmentValue('OPENCRAFT_IMAGE=a\nOPENCRAFT_IMAGE=b\n', 'OPENCRAFT_IMAGE', 'c'), /Duplicate/);
  assert.doesNotThrow(() => assertImageReference(`ghcr.io/opencraft-app/opencraft@sha256:${'a'.repeat(64)}`));
  assert.doesNotThrow(() => assertImageReference('ghcr.io/opencraft-app/opencraft:v1.2.3'));
  for (const image of ['ghcr.io/opencraft-app/opencraft', 'localhost:5000/opencraft', 'opencraft:latest', 'opencraft:local'])
    assert.throws(() => assertImageReference(image), /mutable/);
  assert.throws(() => assertImageReference('opencraft@sha256:abc'), /complete/);
  assert.deepEqual(deploymentIdentity({ OPENCRAFT_UID: '1000', OPENCRAFT_GID: '1000' }), { uid: 1000, gid: 1000 });
  for (const environment of [{ OPENCRAFT_UID: '0', OPENCRAFT_GID: '1000' }, { OPENCRAFT_UID: '1000', OPENCRAFT_GID: '0' }])
    assert.throws(() => deploymentIdentity(environment), /non-root/);
});

test('Hands resource settings have one strict representation for Compose and Brain', () => {
  assert.deepEqual(handsResources({}), { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 });
  assert.deepEqual(handsResources({ OPENCRAFT_HANDS_CPUS: '2.5', OPENCRAFT_HANDS_MEMORY_BYTES: '4294967296' }),
    { cpuMillis: 2500, memoryBytes: 4 * 1024 ** 3 });
  for (const environment of [
    { OPENCRAFT_HANDS_CPUS: '0' }, { OPENCRAFT_HANDS_CPUS: '1.0001' },
    { OPENCRAFT_HANDS_MEMORY_BYTES: 'infinite' }, { OPENCRAFT_HANDS_MEMORY_BYTES: '1.5' },
  ]) assert.throws(() => handsResources(environment));
});

test('external execution uses one absolute data identity and a separate runtime cwd', () => {
  for (const env of [{}, { OPENCRAFT_DATA_DIR: 'relative', OPENCRAFT_WORKSPACE_DIR: '/work' },
    { OPENCRAFT_DATA_DIR: '/', OPENCRAFT_WORKSPACE_DIR: '/work' },
    { OPENCRAFT_DATA_DIR: '/state', OPENCRAFT_WORKSPACE_DIR: '/state/.' }])
    assert.throws(() => deploymentPaths(env));
  const paths = deploymentPaths({ OPENCRAFT_DATA_DIR: '/srv/state/', OPENCRAFT_WORKSPACE_DIR: '/srv/projects' });
  assert.equal(paths.dataDirectory, '/srv/state');
  assert.equal(paths.runtimeDirectory, '/srv/projects');
  assert.equal(paths.coreEndpoint, '/srv/state/run/codex-core.sock');
  assert.equal(paths.engineDescriptor, '/srv/state/run/engine-host.json');
});

test('core authentication refuses readable-by-others and empty files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'opencraft-container-token-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'token');
  await writeFile(path, 'synthetic-local-token\n', { mode: 0o600 });
  assert.equal(await readPrivateToken(path), 'synthetic-local-token');
  await chmod(path, 0o644);
  await assert.rejects(readPrivateToken(path), /private file/);
  await chmod(path, 0o600);
  await writeFile(path, ' \n');
  await assert.rejects(readPrivateToken(path), /Invalid core token/);
});

test('rendered Compose separates gateway, brain and hands while preserving path identity', t => {
  if (spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status !== 0)
    return t.skip('Docker Compose CLI is unavailable');
  const config = JSON.parse(execFileSync('docker', ['compose', '-f', 'docker/compose.yaml', 'config', '--format', 'json'], {
    cwd: new URL('../..', import.meta.url), encoding: 'utf8',
    env: { ...process.env, OPENCRAFT_UID: '1234', OPENCRAFT_GID: '2345',
      OPENCRAFT_HOST_DATA_DIR: '/home/demo/.opencraft', OPENCRAFT_DATA_DIR: '/data/.opencraft',
      OPENCRAFT_HOST_WORKSPACE_DIR: '/srv/projects', OPENCRAFT_WORKSPACE_DIR: '/data' },
  }));
  assert.deepEqual(Object.keys(config.services).sort(), ['brain', 'gateway', 'hands']);
  const service = config.services.gateway, brain = config.services.brain, hands = config.services.hands;
  for (const value of [service, brain, hands]) {
    assert.equal(value.user, '1234:2345');
    assert.equal(value.network_mode, 'host');
    assert.equal(value.ports, undefined);
  }
  assert.equal(service.pid, 'host');
  assert.equal(brain.pid, 'host');
  assert.equal(hands.pid, undefined);
  assert.deepEqual(hands.cap_drop, ['ALL']);
  assert.deepEqual([...hands.cap_add].sort(), ['SETGID', 'SETUID', 'SYS_ADMIN', 'SYS_CHROOT']);
  assert.equal(hands.environment.HOME, '/data/.opencraft/hands');
  assert.deepEqual(hands.volumes.map(v => [v.source, v.target]), [
    ['/home/demo/.opencraft/hands', '/data/.opencraft/hands'],
    ['/srv/projects', '/data'],
  ]);
  assert.equal(hands.environment.OPENCRAFT_HANDS_EXECUTION_SOCKET, '/data/.opencraft/hands/exec-owner.sock');
  assert.equal(hands.environment.OPENCRAFT_WORKSPACE_DIR, '/data');
  assert.equal(hands.environment.OPENCRAFT_HANDS_CPUS, '4.0');
  assert.equal(hands.environment.OPENCRAFT_HANDS_MEMORY_BYTES, '8589934592');
  assert.equal(hands.cpus, 4);
  assert.equal(hands.mem_limit, '8589934592');
  // Some Compose versions omit false-valued bind options from JSON output.
  assert.deepEqual(service.volumes.map(v => [v.type, v.source, v.target, v.bind?.create_host_path ?? false]), [
    ['bind', '/home/demo/.opencraft', '/data/.opencraft', false], ['bind', '/srv/projects', '/data', false],
  ]);
  const paths = deploymentPaths(service.environment);
  assert.equal(service.command[service.command.indexOf('--data-dir') + 1], paths.dataDirectory);
  assert.equal(service.command[service.command.indexOf('--engines') + 1], 'dsh,pi');
  assert.equal(service.environment.OPENCRAFT_BROWSER_OWNER_SOCKET, '/data/.opencraft/hands/owner.sock');
  assert.deepEqual(brain.entrypoint, ['/opt/opencraft/bin/opencraft-host']);
  assert.deepEqual(hands.entrypoint, ['/opt/opencraft/bin/opencraft-hands']);
});

test('the published env example renders without hidden required variables', t => {
  if (spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status !== 0)
    return t.skip('Docker Compose CLI is unavailable');
  assert.doesNotThrow(() => execFileSync('docker', ['compose', '-f', 'docker/compose.yaml', '--env-file', 'docker/.env.example', 'config'], {
    cwd: new URL('../..', import.meta.url), stdio: 'pipe',
  }));
});

test('container candidates carry pinned bases, source identity and both public architectures', async () => {
  const root = new URL('../..', import.meta.url);
  const [dockerfile, workflow] = await Promise.all([
    readFile(new URL('docker/Dockerfile', root), 'utf8'),
    readFile(new URL('.github/workflows/container.yml', root), 'utf8'),
  ]);
  assert.match(dockerfile, /node:26\.7\.0-bookworm-slim@sha256:[a-f0-9]{64}/u);
  assert.match(dockerfile, /debian:bookworm-slim@sha256:[a-f0-9]{64}/u);
  for (const label of ['org.opencontainers.image.source', 'org.opencontainers.image.revision', 'org.opencontainers.image.licenses'])
    assert.match(dockerfile, new RegExp(label.replaceAll('.', '\\.'), 'u'));
  for (const architecture of ['amd64', 'arm64']) assert.match(workflow, new RegExp(`architecture: ${architecture}`, 'u'));
  for (const argument of ['OPENCRAFT_BUILD_ID', 'OPENCRAFT_SOURCE_REVISION', 'SOURCE_DATE_EPOCH'])
    assert.match(workflow, new RegExp(`--build-arg "${argument}=`, 'u'));
});
