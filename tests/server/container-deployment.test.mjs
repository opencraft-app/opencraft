import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { deploymentPaths, readPrivateToken } from '../../scripts/container-deployment/paths.mjs';

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
  ]);
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
