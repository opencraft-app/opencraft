import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { deploymentPaths, readPrivateToken } from '../../scripts/container-deployment/paths.mjs';
import { handsResources } from '../../scripts/container-deployment/resources.mjs';
import { OWNER_ORDER, assertImageReference, deploymentIdentity, parseEnvironment, setEnvironmentValue } from '../../scripts/container-deployment/compose-release.mjs';
import { legacyLayoutValues } from '../../scripts/container-deployment/layout.mjs';

const composeExecutable = process.env.OPENCRAFT_COMPOSE_EXECUTABLE ?? 'docker';
const composePrefix = process.env.OPENCRAFT_COMPOSE_EXECUTABLE ? [] : ['compose'];
const composeAvailable = () => spawnSync(composeExecutable, [...composePrefix, 'version'], { stdio: 'ignore' }).status === 0;
const compose = (args, options) => execFileSync(composeExecutable, [...composePrefix, ...args], options);

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
  if (!composeAvailable())
    return t.skip('Docker Compose CLI is unavailable');
  const config = JSON.parse(compose(['-f', 'docker/compose.yaml', 'config', '--format', 'json'], {
    cwd: new URL('../..', import.meta.url), encoding: 'utf8',
    env: { ...process.env, OPENCRAFT_UID: '1234', OPENCRAFT_GID: '2345',
      OPENCRAFT_HOST_DATA_DIR: '/srv/opencraft/state', OPENCRAFT_DATA_DIR: '/var/lib/opencraft',
      OPENCRAFT_HOST_LOG_DIR: '/srv/opencraft/logs', OPENCRAFT_LOG_DIR: '/var/log/opencraft',
      OPENCRAFT_HOST_WORKSPACE_DIR: '/srv/opencraft/workspaces', OPENCRAFT_WORKSPACE_DIR: '/workspace' },
  }));
  assert.deepEqual(Object.keys(config.services).sort(), ['brain', 'gateway', 'hands']);
  const service = config.services.gateway, brain = config.services.brain, hands = config.services.hands;
  for (const value of [service, brain, hands]) {
    assert.equal(value.user, '1234:2345');
    assert.deepEqual(value.build.args, { OPENCRAFT_UID: '1234', OPENCRAFT_GID: '2345' });
    assert.equal(value.network_mode, 'host');
    assert.equal(value.ports, undefined);
    assert.deepEqual(value.logging, { driver: 'local', options: { 'max-size': '10m', 'max-file': '3' } });
  }
  assert.equal(service.pid, 'host');
  assert.equal(brain.pid, 'host');
  assert.equal(hands.pid, undefined);
  assert.deepEqual(hands.cap_drop, ['ALL']);
  assert.deepEqual([...hands.cap_add].sort(), ['SETGID', 'SETUID', 'SYS_ADMIN', 'SYS_CHROOT']);
  assert.equal(hands.environment.HOME, '/var/lib/opencraft/execution');
  assert.deepEqual(hands.volumes.map(v => [v.source, v.target]), [
    ['/srv/opencraft/state/execution/git-credentials', '/var/lib/opencraft/git-credentials'],
    ['/srv/opencraft/state/execution', '/var/lib/opencraft/execution'],
    ['/srv/opencraft/workspaces', '/workspace'],
    ['/srv/opencraft/logs', '/var/log/opencraft'],
    ['/srv/opencraft/logs/hands', '/var/log/opencraft/hands'],
  ]);
  for (const [name, value] of Object.entries(config.services)) {
    assert.equal(value.volumes.find(v => v.target === '/var/log/opencraft').read_only, true);
    assert.notEqual(value.volumes.find(v => v.target === `/var/log/opencraft/${name}`).read_only, true);
    assert.deepEqual(value.entrypoint, ['/opt/opencraft/bin/node', '/opt/opencraft/runtime/container-service.mjs', name]);
    assert.equal(value.environment.OPENCRAFT_CODEX_PROJECTLESS_DIR, '/workspace/sessions/codex');
    assert.equal(value.environment.OPENCRAFT_BROWSER_DATA_DIR, '/var/lib/opencraft/execution/browser');
  }
  assert.equal(hands.environment.OPENCRAFT_HANDS_EXECUTION_SOCKET, '/var/lib/opencraft/execution/exec-owner.sock');
  assert.equal(hands.environment.OPENCRAFT_WORKSPACE_DIR, '/workspace');
  assert.equal(hands.environment.OPENCRAFT_HANDS_CPUS, '4.0');
  assert.equal(hands.environment.OPENCRAFT_HANDS_MEMORY_BYTES, '8589934592');
  assert.equal(hands.cpus, 4);
  assert.equal(hands.mem_limit, '8589934592');
  // Some Compose versions omit false-valued bind options from JSON output.
  assert.deepEqual(service.volumes.map(v => [v.type, v.source, v.target, v.bind?.create_host_path ?? false]), [
    ['bind', '/srv/opencraft/state/execution/git-credentials', '/var/lib/opencraft/git-credentials', false],
    ['bind', '/srv/opencraft/state', '/var/lib/opencraft', false], ['bind', '/srv/opencraft/workspaces', '/workspace', false],
    ['bind', '/srv/opencraft/logs', '/var/log/opencraft', false], ['bind', '/srv/opencraft/logs/gateway', '/var/log/opencraft/gateway', false],
  ]);
  const paths = deploymentPaths(service.environment);
  assert.equal(service.command[service.command.indexOf('--data-dir') + 1], paths.dataDirectory);
  assert.equal(service.command[service.command.indexOf('--engines') + 1], 'dsh,pi');
  assert.equal(service.environment.OPENCRAFT_BROWSER_OWNER_SOCKET, '/var/lib/opencraft/execution/browser/owner.sock');
});

test('prebuilt role images preserve the runtime service contract and project paths', t => {
  if (spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status !== 0)
    return t.skip('Docker Compose CLI is unavailable');
  const env = { ...process.env, OPENCRAFT_HOST_WORKSPACE_DIR: '/srv/projects', OPENCRAFT_WORKSPACE_DIR: '/srv/projects' };
  const roles = ['gateway', 'brain', 'hands'];
  const image = role => `example.org/opencraft/${role}:v1`;
  for (const role of roles) env[`OPENCRAFT_${role.toUpperCase()}_IMAGE`] = image(role);
  const render = (...extra) => JSON.parse(execFileSync('docker', ['compose', '--env-file', 'docker/.env.example',
    '-f', 'docker/compose.yaml', ...extra, 'config', '--format', 'json'], {
    cwd: new URL('../..', import.meta.url), encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'],
  })).services;
  const base = render();
  const overlay = ['-f', 'docker/compose.role-images.yaml'];
  const rendered = render(...overlay);
  for (const role of roles) {
    const { build, ...expected } = base[role];
    assert.ok(build);
    assert.deepEqual(rendered[role], { ...expected, image: image(role) });
    assert.ok(rendered[role].volumes.some(v => v.source === '/srv/projects' && v.target === v.source));
  }
  env.OPENCRAFT_HANDS_IMAGE = '';
  assert.throws(() => render(...overlay), /OPENCRAFT_HANDS_IMAGE/u);
});

test('the published env example renders without hidden required variables', t => {
  if (!composeAvailable())
    return t.skip('Docker Compose CLI is unavailable');
  assert.doesNotThrow(() => compose(['-f', 'docker/compose.yaml', '--env-file', 'docker/.env.example', 'config'], {
    cwd: new URL('../..', import.meta.url), stdio: 'pipe',
  }));
});

test('adopted legacy deployments render the existing browser, execution and thread cwd identities', t => {
  if (!composeAvailable()) return t.skip('Docker Compose CLI is unavailable');
  const environment = { OPENCRAFT_UID: '1234', OPENCRAFT_GID: '2345', OPENCRAFT_HOST_DATA_DIR: '/home/demo/.opencraft',
    OPENCRAFT_DATA_DIR: '/data/.opencraft', OPENCRAFT_HOST_WORKSPACE_DIR: '/srv/projects', OPENCRAFT_WORKSPACE_DIR: '/data' };
  const config = JSON.parse(compose(['-f', 'docker/compose.yaml', 'config', '--format', 'json'], {
    cwd: new URL('../..', import.meta.url), encoding: 'utf8', env: { ...process.env, ...environment, ...legacyLayoutValues(environment) },
  }));
  const hands = config.services.hands, brain = config.services.brain;
  assert.equal(hands.environment.OPENCRAFT_BROWSER_DATA_DIR, '/data/.opencraft/hands');
  assert.equal(config.services.gateway.environment.OPENCRAFT_BROWSER_OWNER_SOCKET, '/data/.opencraft/hands/owner.sock');
  assert.equal(config.services.gateway.environment.OPENCRAFT_GATEWAY_HOME, '/data/.opencraft/container-home');
  assert.equal(brain.environment.OPENCRAFT_CODEX_PROJECTLESS_DIR, '/data/.opencraft/hands/projectless-workspaces');
  assert.equal(hands.environment.OPENCRAFT_CODEX_PROJECTLESS_DIR, brain.environment.OPENCRAFT_CODEX_PROJECTLESS_DIR);
  assert.ok(hands.volumes.some(v => v.source === '/home/demo/.opencraft/hands' && v.target === '/data/.opencraft/hands'));
  assert.ok(hands.volumes.some(v => v.target === '/var/log/opencraft' && v.read_only));
});

test('custom container candidates carry pinned bases, source identity and a verified owned runtime input', async () => {
  const root = new URL('../..', import.meta.url);
  const [dockerfile, workflow] = await Promise.all([
    readFile(new URL('docker/Dockerfile.owned-electron', root), 'utf8'),
    readFile(new URL('.github/workflows/container.yml', root), 'utf8'),
  ]);
  assert.match(dockerfile, /node:26\.7\.0-bookworm-slim@sha256:[a-f0-9]{64}/u);
  assert.match(dockerfile, /debian:bookworm-slim@sha256:[a-f0-9]{64}/u);
  for (const label of ['org.opencontainers.image.source', 'org.opencontainers.image.revision', 'org.opencontainers.image.licenses'])
    assert.match(dockerfile, new RegExp(label.replaceAll('.', '\\.'), 'u'));
  assert.match(workflow, /architecture: amd64/u);
  assert.match(workflow, /target: linux-x64/u);
  assert.match(workflow, /kind: browser/u);
  assert.match(workflow, /--build-context "owned-electron=\$OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION"/u);
  for (const argument of ['OPENCRAFT_BUILD_ID', 'OPENCRAFT_SOURCE_REVISION', 'SOURCE_DATE_EPOCH'])
    assert.match(workflow, new RegExp(`--build-arg "${argument}=`, 'u'));
  assert.ok(workflow.indexOf('npm ci --no-audit --no-fund') < workflow.indexOf('node --test tests/server/container-deployment.test.mjs'));
});

test('standalone container Core entries ship the registry and recovery Workers beside the runtime', async () => {
  const packager = await readFile(new URL('../../scripts/package-container.mjs', import.meta.url), 'utf8');
  for (const [source, target] of [['generation-registry.worker.ts', 'generation-registry-worker.mjs'], ['router-evidence.worker.ts', 'router-evidence-worker.mjs']]) {
    assert.ok(packager.includes(`['apps/codex-core/src/${source}', '${target}', 'esm']`));
  }
});

test('the local GitHub builder is portable, locked, revision-pinned and advances its moving tag only after success', async () => {
  const root = new URL('../..', import.meta.url);
  const [builder, environmentExample, service, timer] = await Promise.all([
    readFile(new URL('scripts/container-deployment/build-from-github.sh', root), 'utf8'),
    readFile(new URL('packaging/container-build/opencraft-github-build.env.example', root), 'utf8'),
    readFile(new URL('packaging/container-build/opencraft-github-build.service', root), 'utf8'),
    readFile(new URL('packaging/container-build/opencraft-github-build.timer', root), 'utf8'),
  ]);
  assert.match(environmentExample, /^OPENCRAFT_BUILD_REPOSITORY=\/path\/to\/opencraft$/mu);
  assert.match(environmentExample, /^OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION=\/path\/to\/verified\/browser$/mu);
  assert.match(builder, /--build-context "owned-electron=\$distribution"/u);
  assert.doesNotMatch(environmentExample, /\/root\/|imconnect/u);
  assert.match(builder, /flock -n 9/u);
  assert.match(builder, /refs\/remotes\/origin\/\$branch\^\{commit\}/u);
  assert.match(builder, /org\.opencontainers\.image\.revision/u);
  assert.ok(builder.indexOf('docker build') < builder.indexOf('mv "$temporary_success" "$success_file"'));
  assert.match(service, /Type=oneshot/u);
  assert.match(service, /TimeoutStartSec=2h/u);
  assert.match(timer, /OnActiveSec=1min/u);
  assert.match(timer, /OnUnitInactiveSec=1min/u);
  assert.match(timer, /AccuracySec=1s/u);
  assert.match(timer, /Persistent=true/u);
});
