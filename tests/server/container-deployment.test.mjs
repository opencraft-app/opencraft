import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { deploymentPaths, proxyConfiguration, readPrivateToken } from '../../scripts/container-deployment/paths.mjs';
import { handsResources } from '../../scripts/container-deployment/resources.mjs';
import { AGENT_RUN_DIRECTORY, inspectWorkspaceAgentServices, OWNER_ORDER, RESTORE_PROXY_MODE_VARIABLE, RESTORE_PROXY_PORT_VARIABLE, EMBEDDED_CORE_ENVIRONMENT, brainEmbedsAccountCore, ownerSteps, restoreSteps, assertImageReference, deploymentIdentity, parseEnvironment, setEnvironmentValue } from '../../scripts/container-deployment/compose-release.mjs';
import { legacyLayoutValues } from '../../scripts/container-deployment/layout.mjs';

const composeExecutable = process.env.OPENCRAFT_COMPOSE_EXECUTABLE ?? 'docker';
const composePrefix = process.env.OPENCRAFT_COMPOSE_EXECUTABLE ? [] : ['compose'];
const composeAvailable = () => spawnSync(composeExecutable, [...composePrefix, 'version'], { stdio: 'ignore' }).status === 0;
const compose = (args, options) => execFileSync(composeExecutable, [...composePrefix, ...args], options);

test('Compose release transactions preserve env content and owner dependency order', () => {
  assert.deepEqual(OWNER_ORDER, ['hands', 'proxy', 'brain', 'gateway']);
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
  // Engine descriptors are agent-private; the Gateway reads them through workspace endpoints.
  assert.equal(paths.engineDescriptor, '/run/opencraft-agent/engine-host.json');
  assert.equal(paths.executionContext,'assets');
  assert.equal(deploymentPaths({OPENCRAFT_DATA_DIR:'/state',OPENCRAFT_WORKSPACE_DIR:'/work',OPENCRAFT_EXECUTION_CONTEXT:'legacy'}).executionContext,'legacy');
  assert.throws(()=>deploymentPaths({OPENCRAFT_DATA_DIR:'/state',OPENCRAFT_WORKSPACE_DIR:'/work',OPENCRAFT_EXECUTION_CONTEXT:'fallback'}),/EXECUTION_CONTEXT/);
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

test('the first proxy-default release stops an embedded-Core Brain before the proxy takes the account writer', () => {
  const steps = ownerSteps({ brainEmbedsCore: true });
  assert.deepEqual(steps, [['stop', 'brain'], ['up', 'hands'], ['up', 'proxy'], ['up', 'brain'], ['up', 'gateway']]);
  assert.ok(steps.findIndex(([, s]) => s === 'proxy') < steps.findIndex(([a, s]) => a === 'up' && s === 'brain'));
  // Already switched: Brain keeps serving while the proxy is replaced; nothing is stopped first.
  assert.deepEqual(ownerSteps({ brainEmbedsCore: false }), OWNER_ORDER.map(service => ['up', service]));
  assert.equal(brainEmbedsAccountCore(['PATH=/bin', 'OPENCRAFT_DATA_DIR=/d']), true, 'pre-proxy Brain had no proxy mode');
  assert.equal(brainEmbedsAccountCore(['OPENCRAFT_PROXY_MODE=embedded']), true);
  assert.equal(brainEmbedsAccountCore(['OPENCRAFT_PROXY_MODE=external', 'OPENCRAFT_PROXY_PORT=45071']), false);
  assert.equal(brainEmbedsAccountCore(null), false, 'no Brain container: nothing holds the writer');
});

test('a failed switch from an embedded-Core release restores that topology, not only the previous image', t => {
  // The previous release had no proxy owner (and its image may not provide one): remove it and embed the Core again.
  const steps = restoreSteps({ embeddedCoreBefore: true });
  // Gateway is recreated: when the failed release never reached it, its health may already be failing after Brain stopped.
  assert.deepEqual(steps, [['stop', 'brain'], ['remove', 'proxy'], ['up', 'hands'], ['up-embedded', 'brain'], ['recreate', 'gateway']]);
  assert.ok(steps.findIndex(([a]) => a === 'remove') < steps.findIndex(([a]) => a === 'up-embedded'), 'the proxy releases the account writer first');
  assert.equal(steps.some(([a, s]) => a.startsWith('up') && s === 'proxy'), false);
  // A release that already ran the proxy topology restores the same four owners in order.
  assert.deepEqual(restoreSteps({ embeddedCoreBefore: false }), OWNER_ORDER.map(service => ['up', service]));
  if (!composeAvailable()) return t.skip('Docker Compose CLI is unavailable');
  const render = extra => JSON.parse(compose(['-f', 'deploy/docker/compose.yaml', 'config', '--format', 'json', 'brain'], {
    cwd: new URL('../..', import.meta.url), encoding: 'utf8',
    env: { ...process.env, OPENCRAFT_UID: '1234', OPENCRAFT_GID: '2345', OPENCRAFT_HOST_DATA_DIR: '/srv/opencraft/state',
      OPENCRAFT_DATA_DIR: '/var/lib/opencraft', OPENCRAFT_HOST_WORKSPACE_DIR: '/srv/opencraft/workspaces', OPENCRAFT_WORKSPACE_DIR: '/workspace', ...extra },
  })).services.brain.environment;
  const restored = render({ ...EMBEDDED_CORE_ENVIRONMENT, OPENCRAFT_PROXY_PORT: '45931' });
  assert.equal(restored.OPENCRAFT_PROXY_MODE, 'embedded');
  // No fixed port: the embedded Core picks a free one, as before the switch, even if a failed proxy still holds it.
  assert.equal(restored.OPENCRAFT_PROXY_PORT ?? '', '');
  assert.deepEqual(proxyConfiguration(restored), { proxyMode: 'embedded', proxyPort: null });
  assert.equal(brainEmbedsAccountCore(Object.entries(restored).map(([k, v]) => `${k}=${v}`)), true, 'the next upgrade switches it again');
  const normal = render({ OPENCRAFT_PROXY_PORT: '45931' });
  assert.deepEqual(proxyConfiguration(normal), { proxyMode: 'external', proxyPort: 45931 });
  assert.deepEqual(proxyConfiguration(render({})), { proxyMode: 'external', proxyPort: 45071 });
});

test('doctor refuses a restore-only proxy mode persisted in .env', async () => {
  const { doctor } = await import('../../scripts/container-deployment/compose-release.mjs');
  for (const [name, value] of [[RESTORE_PROXY_MODE_VARIABLE, 'embedded'], [RESTORE_PROXY_PORT_VARIABLE, '']])
    await assert.rejects(doctor({ OPENCRAFT_HOST_DATA_DIR: '/srv/s', OPENCRAFT_DATA_DIR: '/var/lib/opencraft', OPENCRAFT_HOST_WORKSPACE_DIR: '/srv/w',
      OPENCRAFT_WORKSPACE_DIR: '/workspace', OPENCRAFT_UID: '1000', OPENCRAFT_GID: '1000', [name]: value }), new RegExp(`Remove ${name}`));
});

test('doctor fails before any release step when .env or deployment state cannot be committed by the deployment UID', async t => {
  // A release writes .env and compose-state.json by atomic rename only after all four owners were applied.
  const root_ = process.getuid() === 0;
  // The unprivileged child must traverse every ancestor; an isolated test TMPDIR may be private to root.
  const root = await mkdtemp(join(root_ ? '/tmp' : tmpdir(), 'opencraft-doctor-writable-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // access(2) ignores modes for root, so the check runs as an unprivileged deployment identity.
  const uid = root_ ? 65534 : process.getuid(), gid = root_ ? 65534 : process.getgid();
  const { mkdir, chown } = await import('node:fs/promises');
  const own = async (path, mode) => { await mkdir(path, { recursive: true, mode }); await chmod(path, mode); if (root_) await chown(path, uid, gid); };
  await chmod(root, 0o755);
  const state = join(root, 'state'), deploy = join(root, 'deploy');
  for (const path of [state, join(state, 'execution'), join(state, 'execution', 'git-credentials'), join(state, 'logs'),
    ...['brain', 'gateway', 'hands', 'proxy'].map(service => join(state, 'logs', service)), join(root, 'work'), deploy]) await own(path, 0o700);
  const environment = { OPENCRAFT_HOST_DATA_DIR: state, OPENCRAFT_DATA_DIR: '/var/lib/opencraft', OPENCRAFT_HOST_WORKSPACE_DIR: join(root, 'work'),
    OPENCRAFT_WORKSPACE_DIR: '/workspace', OPENCRAFT_UID: String(uid), OPENCRAFT_GID: String(gid) };
  const doctorAs = () => spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { doctor } from ${JSON.stringify(new URL('../../scripts/container-deployment/compose-release.mjs', import.meta.url).href)};
    try { await doctor(${JSON.stringify(environment)}, { allowOversubscription: true, deployDirectory: ${JSON.stringify(deploy)} }); console.log('doctor-passed-writable'); }
    catch (error) { console.log(/not writable/.test(error.message) ? 'doctor-refused ' + error.message : 'doctor-later ' + error.message); }
  `], { encoding: 'utf8', ...(root_ ? { uid, gid } : {}) });
  const outcome = () => { const result = doctorAs(); assert.equal(result.status, 0, String(result.stderr)); return result.stdout.trim(); };
  if (root_ && doctorAs().error?.code === 'EACCES') return t.skip('this Node executable is not runnable by an unprivileged deployment UID');
  // Writable: the check passes (any later failure, e.g. Compose rendering in this sandbox, is a different check).
  assert.doesNotMatch(outcome(), /^doctor-refused/);
  await chmod(deploy, 0o500);
  assert.match(outcome(), /^doctor-refused .*deploy.*\.env/);
  await chmod(deploy, 0o700);
  await own(join(state, 'deployment'), 0o500);
  assert.match(outcome(), /^doctor-refused .*deployment.*compose-state\.json/);
  await chmod(join(state, 'deployment'), 0o700);
  assert.doesNotMatch(outcome(), /^doctor-refused/);
});

test('Brain and Hands render the same non-default execution budget', t => {
  if (!composeAvailable())
    return t.skip('Docker Compose CLI is unavailable');
  const config = JSON.parse(compose(['-f', 'deploy/docker/compose.yaml', 'config', '--format', 'json'], {
    cwd: new URL('../..', import.meta.url), encoding: 'utf8',
    env: { ...process.env, OPENCRAFT_UID: '1234', OPENCRAFT_GID: '2345',
      OPENCRAFT_HOST_DATA_DIR: '/srv/opencraft/state', OPENCRAFT_DATA_DIR: '/var/lib/opencraft',
      OPENCRAFT_HOST_WORKSPACE_DIR: '/srv/opencraft/workspaces', OPENCRAFT_WORKSPACE_DIR: '/workspace',
      OPENCRAFT_HANDS_CPUS: '2.0', OPENCRAFT_HANDS_MEMORY_BYTES: '4294967296' },
  }));
  const { brain, hands } = config.services;
  // Hands rejects a lease whose declared resources differ from its own budget.
  assert.deepEqual(handsResources(brain.environment), { cpuMillis: 2000, memoryBytes: 4294967296 });
  assert.deepEqual(handsResources(brain.environment), handsResources(hands.environment));
  assert.equal(hands.cpus, 2);
  assert.equal(hands.mem_limit, '4294967296');
});

test('rendered Compose separates gateway, brain and hands while preserving path identity', t => {
  if (!composeAvailable())
    return t.skip('Docker Compose CLI is unavailable');
  const config = JSON.parse(compose(['-f', 'deploy/docker/compose.yaml', 'config', '--format', 'json'], {
    cwd: new URL('../..', import.meta.url), encoding: 'utf8',
    env: { ...process.env, OPENCRAFT_UID: '1234', OPENCRAFT_GID: '2345',
      OPENCRAFT_HOST_DATA_DIR: '/srv/opencraft/state', OPENCRAFT_DATA_DIR: '/var/lib/opencraft',
      OPENCRAFT_HOST_LOG_DIR: '/srv/opencraft/logs', OPENCRAFT_LOG_DIR: '/var/log/opencraft',
      OPENCRAFT_HOST_WORKSPACE_DIR: '/srv/opencraft/workspaces', OPENCRAFT_WORKSPACE_DIR: '/workspace' },
  }));
  assert.deepEqual(Object.keys(config.services).sort(), ['brain', 'gateway', 'hands', 'proxy']);
  const service = config.services.gateway, brain = config.services.brain, hands = config.services.hands, proxy = config.services.proxy;
  for (const value of [service, brain, hands, proxy]) {
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
  assert.deepEqual(hands.volumes.filter(v => v.type === 'bind').map(v => [v.source, v.target]), [
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
    if (name === 'proxy') continue; // The account Core owns no thread cwd or browser state.
    assert.equal(value.environment.OPENCRAFT_CODEX_PROJECTLESS_DIR, '/workspace/sessions/codex');
    assert.equal(value.environment.OPENCRAFT_BROWSER_DATA_DIR, '/var/lib/opencraft/execution/browser');
  }
  assert.equal(proxy.pid, undefined);
  assert.equal(brain.environment.OPENCRAFT_PROXY_MODE, 'external');
  assert.equal(brain.depends_on.proxy.condition, 'service_healthy');
  assert.equal(service.environment.OPENCRAFT_ASSISTANT_PROXY_CALLER_FILE, '/var/lib/opencraft/run/proxy-callers/assistant.json');
  assert.equal(hands.environment.OPENCRAFT_HANDS_EXECUTION_SOCKET, '/var/lib/opencraft/execution/exec-owner.sock');
  assert.equal(hands.environment.OPENCRAFT_WORKSPACE_DIR, '/workspace');
  assert.equal(hands.environment.OPENCRAFT_HANDS_CPUS, '4.0');
  assert.equal(hands.environment.OPENCRAFT_HANDS_MEMORY_BYTES, '8589934592');
  assert.equal(hands.cpus, 4);
  assert.equal(hands.mem_limit, '8589934592');
  // The Gateway reaches Brain and Hands only through their static-docker links.
  assert.equal(service.environment.OPENCRAFT_WORKSPACE_ENVIRONMENTS, 'static-docker://brain static-docker://hands');
  assert.equal(service.environment.OPENCRAFT_BROWSER_OWNER_SOCKET, undefined);
  assert.equal(brain.cpus, 4);
  assert.equal(brain.mem_limit, '8589934592');
  assert.deepEqual(service.volumes.filter(v => v.type === 'volume').map(v => [v.source, v.target]),
    [['brain-link', '/run/opencraft-links/brain'], ['hands-link', '/run/opencraft-links/hands']]);
  for (const [name, value] of [['brain', brain], ['hands', hands]]) {
    assert.deepEqual(value.volumes.filter(v => v.type === 'volume').map(v => [v.source, v.target]), [[`${name}-link`, '/run/opencraft-link']]);
    assert.equal(value.environment.OPENCRAFT_AGENT_LINK_DIR, '/run/opencraft-link');
  }
  assert.equal(proxy.volumes.some(v => v.type === 'volume'), false, 'the proxy never sees a workspace link');
  assert.equal(config.volumes['brain-link'].driver_opts.type, 'tmpfs');
  // Some Compose versions omit false-valued bind options from JSON output.
  assert.deepEqual(service.volumes.filter(v => v.type === 'bind').map(v => [v.type, v.source, v.target, v.bind?.create_host_path ?? false]), [
    ['bind', '/srv/opencraft/state/execution/git-credentials', '/var/lib/opencraft/git-credentials', false],
    ['bind', '/srv/opencraft/state', '/var/lib/opencraft', false], ['bind', '/srv/opencraft/workspaces', '/workspace', false],
    ['bind', '/srv/opencraft/logs', '/var/log/opencraft', false], ['bind', '/srv/opencraft/logs/gateway', '/var/log/opencraft/gateway', false],
  ]);
  const paths = deploymentPaths(service.environment);
  assert.equal(service.command[service.command.indexOf('--data-dir') + 1], paths.dataDirectory);
  assert.equal(service.command[service.command.indexOf('--engines') + 1], 'dsh,pi');
  // Brain and Hands workspace agents keep their run directory private to each container.
  for (const value of [brain, hands]) {
    assert.deepEqual(value.tmpfs, [`${AGENT_RUN_DIRECTORY}:uid=1234,gid=2345,mode=0700,size=16m`]);
    assert.equal(value.environment.OPENCRAFT_AGENT_RUN_DIR, AGENT_RUN_DIRECTORY);
    assert.equal(deploymentPaths(value.environment).engineConfig.startsWith(AGENT_RUN_DIRECTORY + '/'), true);
  }
  assert.deepEqual(service.tmpfs, ['/run/opencraft-gateway:uid=1234,gid=2345,mode=0700,size=1m'], 'Gateway never sees an agent run directory');
  inspectWorkspaceAgentServices(config);
  const { tmpfs, ...withoutTmpfs } = brain;
  assert.throws(() => inspectWorkspaceAgentServices({ services: { ...config.services, brain: withoutTmpfs } }), /brain has no private/);
  assert.throws(() => inspectWorkspaceAgentServices({ services: { ...config.services, hands: { ...hands,
    volumes: [...hands.volumes, { type: 'bind', source: '/srv/x', target: AGENT_RUN_DIRECTORY }] } } }), /must not share/);
  assert.throws(() => inspectWorkspaceAgentServices({ services: { ...config.services, brain: { ...brain,
    volumes: brain.volumes.filter(v => v.type !== 'volume') } } }), /no private static-docker link/);
  assert.throws(() => inspectWorkspaceAgentServices({ services: { ...config.services, proxy: { ...proxy,
    volumes: [...proxy.volumes, { type: 'volume', source: 'hands-link', target: '/x' }] } } }), /proxy must not mount the hands link/);
  assert.throws(() => inspectWorkspaceAgentServices({ services: { ...config.services, gateway: { ...service,
    volumes: service.volumes.filter(v => v.source !== 'brain-link') } } }), /gateway does not mount the brain link/);
});

test('the agent run directory is container-private and launch configuration leaves the shared data mount', () => {
  const paths = deploymentPaths({ OPENCRAFT_DATA_DIR: '/var/lib/opencraft', OPENCRAFT_WORKSPACE_DIR: '/workspace' });
  assert.equal(paths.agentRunDirectory, '/run/opencraft-agent');
  assert.equal(paths.agentControlEndpoint, '/run/opencraft-agent/control.sock');
  for (const key of ['engineConfig', 'dshConfig', 'sandboxConfig', 'codexPrivateDirectory']) assert.ok(paths[key].startsWith('/run/opencraft-agent/'), key);
  // Brain owners publish nothing in the shared run directory (step 4c); only AccountCore remains there.
  for (const key of ['appServerEndpoint', 'appServerNativeSocket', 'appServerTokenFile', 'engineSocket', 'engineDescriptor', 'dshSocket', 'dshDescriptor'])
    assert.ok(paths[key].startsWith('/run/opencraft-agent/'), key);
  assert.ok(paths.coreEndpoint.startsWith('/var/lib/opencraft/run/'));
  assert.equal(paths.agentLinkDirectory, null);
  assert.equal(deploymentPaths({ OPENCRAFT_DATA_DIR: '/var/lib/opencraft', OPENCRAFT_WORKSPACE_DIR: '/workspace', OPENCRAFT_AGENT_LINK_DIR: '/run/opencraft-link' }).agentLinkDirectory, '/run/opencraft-link');
  for (const shared of ['/var/lib/opencraft/run/link', '/run/opencraft-agent/link', '/workspace/link', 'relative'])
    assert.throws(() => deploymentPaths({ OPENCRAFT_DATA_DIR: '/var/lib/opencraft', OPENCRAFT_WORKSPACE_DIR: '/workspace', OPENCRAFT_AGENT_LINK_DIR: shared }));
  for (const shared of ['/var/lib/opencraft/run', '/workspace/agent', '/var/lib/opencraft/execution/agent'])
    assert.throws(() => deploymentPaths({ OPENCRAFT_DATA_DIR: '/var/lib/opencraft', OPENCRAFT_WORKSPACE_DIR: '/workspace', OPENCRAFT_AGENT_RUN_DIR: shared }), /container-private/);
});

test('prebuilt role images preserve the runtime service contract and project paths', t => {
  if (spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status !== 0)
    return t.skip('Docker Compose CLI is unavailable');
  const env = { ...process.env, OPENCRAFT_HOST_WORKSPACE_DIR: '/srv/projects', OPENCRAFT_WORKSPACE_DIR: '/srv/projects' };
  const roles = ['gateway', 'brain', 'hands', 'proxy'];
  const image = role => `example.org/opencraft/${role}:v1`;
  for (const role of roles) env[`OPENCRAFT_${role.toUpperCase()}_IMAGE`] = image(role);
  const render = (...extra) => JSON.parse(execFileSync('docker', ['compose', '--env-file', 'deploy/docker/.env.example',
    '-f', 'deploy/docker/compose.yaml', ...extra, 'config', '--format', 'json'], {
    cwd: new URL('../..', import.meta.url), encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'],
  })).services;
  const base = render();
  const overlay = ['-f', 'deploy/docker/compose.role-images.yaml'];
  const rendered = render(...overlay);
  for (const role of roles) {
    const { build, ...expected } = base[role];
    assert.ok(build);
    assert.deepEqual(rendered[role], { ...expected, image: image(role) });
    assert.ok(rendered[role].volumes.some(v => v.source === '/srv/projects' && v.target === v.source));
  }
  delete env.OPENCRAFT_PROXY_IMAGE;
  assert.equal(render(...overlay).proxy.image, image('brain'), 'the proxy defaults to the Brain role image');
  env.OPENCRAFT_HANDS_IMAGE = '';
  assert.throws(() => render(...overlay), /OPENCRAFT_HANDS_IMAGE/u);
});

test('the published env example renders without hidden required variables', t => {
  if (!composeAvailable())
    return t.skip('Docker Compose CLI is unavailable');
  assert.doesNotThrow(() => compose(['-f', 'deploy/docker/compose.yaml', '--env-file', 'deploy/docker/.env.example', 'config'], {
    cwd: new URL('../..', import.meta.url), stdio: 'pipe',
  }));
});

test('adopted legacy deployments render the existing browser, execution and thread cwd identities', t => {
  if (!composeAvailable()) return t.skip('Docker Compose CLI is unavailable');
  const environment = { OPENCRAFT_UID: '1234', OPENCRAFT_GID: '2345', OPENCRAFT_HOST_DATA_DIR: '/home/demo/.opencraft',
    OPENCRAFT_DATA_DIR: '/data/.opencraft', OPENCRAFT_HOST_WORKSPACE_DIR: '/srv/projects', OPENCRAFT_WORKSPACE_DIR: '/data' };
  const config = JSON.parse(compose(['-f', 'deploy/docker/compose.yaml', 'config', '--format', 'json'], {
    cwd: new URL('../..', import.meta.url), encoding: 'utf8', env: { ...process.env, ...environment, ...legacyLayoutValues(environment) },
  }));
  const hands = config.services.hands, brain = config.services.brain;
  assert.equal(hands.environment.OPENCRAFT_BROWSER_DATA_DIR, '/data/.opencraft/hands');
  assert.equal(config.services.gateway.environment.OPENCRAFT_GATEWAY_HOME, '/data/.opencraft/container-home');
  assert.equal(brain.environment.OPENCRAFT_CODEX_PROJECTLESS_DIR, '/data/.opencraft/hands/projectless-workspaces');
  assert.equal(hands.environment.OPENCRAFT_CODEX_PROJECTLESS_DIR, brain.environment.OPENCRAFT_CODEX_PROJECTLESS_DIR);
  assert.ok(hands.volumes.some(v => v.source === '/home/demo/.opencraft/hands' && v.target === '/data/.opencraft/hands'));
  assert.ok(hands.volumes.some(v => v.target === '/var/log/opencraft' && v.read_only));
});

test('custom container candidates carry pinned bases, source identity and a verified owned runtime input', async () => {
  const root = new URL('../..', import.meta.url);
  const [dockerfile, workflow, build, license] = await Promise.all([
    readFile(new URL('deploy/docker/Dockerfile.owned-electron', root), 'utf8'),
    readFile(new URL('.github/workflows/container.yml', root), 'utf8'),
    readFile(new URL('scripts/ci/build-container.sh', root), 'utf8'),
    readFile(new URL('LICENSE', root), 'utf8'),
  ]);
  assert.match(dockerfile, /node:26\.7\.0-bookworm-slim@sha256:[a-f0-9]{64}/u);
  assert.match(dockerfile, /debian:bookworm-slim@sha256:[a-f0-9]{64}/u);
  for (const label of ['org.opencontainers.image.source', 'org.opencontainers.image.revision', 'org.opencontainers.image.licenses'])
    assert.match(dockerfile, new RegExp(label.replaceAll('.', '\\.'), 'u'));
  // The image declares the repository's own license (LICENSE: MIT No Attribution).
  assert.match(license, /^MIT No Attribution\n/u);
  for (const [, declared] of dockerfile.matchAll(/org\.opencontainers\.image\.licenses="([^"]+)"/gu)) assert.equal(declared, 'MIT-0');
  assert.match(workflow, /architecture: amd64/u);
  assert.match(workflow, /target: linux-x64/u);
  assert.match(workflow, /kind: browser/u);
  // CI and the server release build through one script.
  assert.match(workflow, /run: bash scripts\/ci\/build-container\.sh "\$\{\{ matrix\.architecture \}\}"/u);
  assert.match(build, /--build-context "owned-electron=\$OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION"/u);
  for (const argument of ['OPENCRAFT_BUILD_ID', 'OPENCRAFT_SOURCE_REVISION', 'SOURCE_DATE_EPOCH'])
    assert.match(build, new RegExp(`--build-arg "${argument}=`, 'u'));
  const installIndex = workflow.indexOf('npm ci --no-audit --no-fund');
  const testIndex = workflow.indexOf('node --import tsx --test tests/server/container-deployment.test.mjs');
  assert.ok(installIndex >= 0 && testIndex > installIndex, 'install dependencies before the container regressions');
});

test('every image stage that runs a workspace agent installs the static-docker link interpreter', async () => {
  const root = new URL('../..', import.meta.url);
  // The agent's link broker runs /usr/bin/python3 (OPENCRAFT_AGENT_PYTHON default); an image
  // without it attaches the Gateway and then refuses every endpoint process.
  const stages = text => {
    const result = new Map();
    let current;
    for (const line of text.replace(/\\\n/gu, ' ').split('\n')) {
      const from = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/iu.exec(line);
      if (from) { current = { base: from[1], body: '' }; if (from[2]) result.set(from[2], current); continue; }
      if (current) current.body += line + '\n';
    }
    return result;
  };
  const installsPython = (all, name) => {
    for (let stage = all.get(name); stage; stage = all.get(stage.base))
      if (/apt-get install[^\n]*\spython3(\s|$)/u.test(stage.body)) return true;
    return false;
  };
  for (const [file, agentStages] of [
    ['deploy/docker/Dockerfile', ['runtime']],
    // `runtime` is the image every Compose service runs (CI builds --target runtime).
    ['deploy/docker/Dockerfile.owned-electron', ['runtime', 'brain', 'hands', 'full']],
  ]) {
    const all = stages(await readFile(new URL(file, root), 'utf8'));
    for (const name of agentStages) {
      assert.ok(all.has(name), `${file} declares ${name}`);
      assert.ok(installsPython(all, name), `${file} stage ${name} must install python3 for the link broker`);
    }
  }
});

test('the local GitHub builder is portable, locked, revision-pinned and advances its moving tag only after success', async () => {
  const root = new URL('../..', import.meta.url);
  const [builder, environmentExample, service, timer] = await Promise.all([
    readFile(new URL('scripts/container-deployment/build-from-github.sh', root), 'utf8'),
    readFile(new URL('deploy/container-build/opencraft-github-build.env.example', root), 'utf8'),
    readFile(new URL('deploy/container-build/opencraft-github-build.service', root), 'utf8'),
    readFile(new URL('deploy/container-build/opencraft-github-build.timer', root), 'utf8'),
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
