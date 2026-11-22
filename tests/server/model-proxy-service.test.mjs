import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { deploymentPaths, proxyConfiguration } from '../../scripts/container-deployment/paths.mjs';
import { codexCoreArguments, proxyHealth, waitForProxy } from '../../scripts/container-deployment/proxy-core.mjs';

const base = { OPENCRAFT_DATA_DIR: '/var/lib/opencraft', OPENCRAFT_WORKSPACE_DIR: '/workspace' };

test('model proxy mode defaults to embedded and an external proxy requires a fixed port', () => {
  assert.deepEqual(proxyConfiguration({}), { proxyMode: 'embedded', proxyPort: null }, 'outside Compose the launcher still embeds the Core unless told otherwise');
  assert.deepEqual(proxyConfiguration({ OPENCRAFT_PROXY_PORT: '45071' }), { proxyMode: 'embedded', proxyPort: 45071 });
  assert.deepEqual(proxyConfiguration({ OPENCRAFT_PROXY_MODE: 'external', OPENCRAFT_PROXY_PORT: '45071' }), { proxyMode: 'external', proxyPort: 45071 });
  assert.throws(() => proxyConfiguration({ OPENCRAFT_PROXY_MODE: 'external' }), /fixed OPENCRAFT_PROXY_PORT/);
  assert.throws(() => proxyConfiguration({ OPENCRAFT_PROXY_MODE: 'remote' }), /embedded or external/);
  for (const port of ['80', '65536', '4507a', '1e4', '-1']) assert.throws(() => proxyConfiguration({ OPENCRAFT_PROXY_PORT: port }), /1024 to 65535/);
  assert.equal(deploymentPaths(base).proxyMode, 'embedded');
});

test('embedded Brain and the proxy service start the same account Core command', () => {
  const paths = deploymentPaths(base);
  assert.deepEqual(codexCoreArguments(paths, '/opt/opencraft', 45071), [
    '--app-server-endpoint', '/var/lib/opencraft/run/codex-app-server.sock', '--proxy-port', '45071',
    '--endpoint', '/var/lib/opencraft/run/codex-core.sock', '--token-file', '/var/lib/opencraft/daemon.token',
    '--codex-executable', '/opt/opencraft/runtime/codex/bin/codex',
    '--runtime-directory', '/workspace',
    '--data-directory', '/var/lib/opencraft/codex',
    '--native-codex-home-directory', '/var/lib/opencraft/native-codex',
  ]);
  assert.throws(() => codexCoreArguments(paths, '/opt/opencraft', 0), /port/);
});

async function fakeCore(t, respond) {
  const directory = await mkdtemp(join(tmpdir(), 'opencraft-proxy-health-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const socket = join(directory, 'core.sock'), token = join(directory, 'token');
  await writeFile(token, 'synthetic-token\n', { mode: 0o600 });
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ path: request.url, authorization: request.headers.authorization });
    const [status, body] = respond();
    response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body));
  });
  await new Promise(accept => server.listen(socket, accept));
  t.after(() => new Promise(accept => server.close(accept)));
  return { socket, token, seen };
}

test('proxy health is the open account owner, authenticated, without requiring the Brain AppServer', async t => {
  let reply = [200, { pid: 42, handoff: { phase: 'open' } }];
  const core = await fakeCore(t, () => reply);
  assert.deepEqual(await proxyHealth(core.socket, core.token), { pid: 42, phase: 'open' });
  assert.deepEqual(core.seen[0], { path: '/owner-handoff', authorization: 'Bearer synthetic-token' });
  for (const value of [[200, { pid: 42, handoff: { phase: 'fenced' } }], [503, { error: 'x' }], [200, { pid: 0, handoff: { phase: 'open' } }]]) {
    reply = value;
    await assert.rejects(proxyHealth(core.socket, core.token), /not serving accounts/);
  }
  reply = [200, { pid: 9, handoff: { phase: 'open', uncertain: Array.from({ length: 4000 }, (_, i) => ({ id: 'u' + i, detail: 'x'.repeat(100) })) } }];
  assert.equal((await proxyHealth(core.socket, core.token)).pid, 9, 'a large retained uncertainty ledger is still healthy');
  reply = [200, { pid: 7, handoff: { phase: 'open' } }];
  assert.equal((await waitForProxy(core.socket, core.token, { attempts: 2, delayMs: 1 })).pid, 7);
  await assert.rejects(waitForProxy(join(core.socket, 'missing'), core.token, { attempts: 2, delayMs: 1 }), /did not become ready/);
});

const composeExecutable = process.env.OPENCRAFT_COMPOSE_EXECUTABLE ?? 'docker';
const composePrefix = process.env.OPENCRAFT_COMPOSE_EXECUTABLE ? [] : ['compose'];
const composeAvailable = () => spawnSync(composeExecutable, [...composePrefix, 'version'], { stdio: 'ignore' }).status === 0;

const renderCompose = (...files) => JSON.parse(execFileSync(composeExecutable, [...composePrefix, ...files.flatMap(file => ['-f', file]), 'config', '--format', 'json'], {
    cwd: new URL('../..', import.meta.url), encoding: 'utf8',
    env: { ...process.env, OPENCRAFT_UID: '1234', OPENCRAFT_GID: '2345',
      OPENCRAFT_HOST_DATA_DIR: '/srv/opencraft/state', OPENCRAFT_DATA_DIR: '/var/lib/opencraft',
      OPENCRAFT_HOST_LOG_DIR: '/srv/opencraft/logs', OPENCRAFT_LOG_DIR: '/var/log/opencraft',
      OPENCRAFT_HOST_WORKSPACE_DIR: '/srv/opencraft/workspaces', OPENCRAFT_WORKSPACE_DIR: '/workspace' },
}));

test('the default Compose runs an independent proxy owner and Brain waits for it', t => {
  if (!composeAvailable()) return t.skip('Docker Compose CLI is unavailable');
  const config = renderCompose('deploy/docker/compose.yaml');
  // The retired overlay is a no-op: old commands render the same deployment.
  assert.deepEqual(renderCompose('deploy/docker/compose.yaml', 'deploy/docker/compose.proxy.yaml'), config);
  assert.deepEqual(Object.keys(config.services).sort(), ['brain', 'gateway', 'hands', 'proxy']);
  const proxy = config.services.proxy, brain = config.services.brain;
  assert.deepEqual(proxy.entrypoint, ['/opt/opencraft/bin/node', '/opt/opencraft/runtime/container-service.mjs', 'proxy']);
  assert.equal(proxy.network_mode, 'host'); assert.equal(proxy.user, '1234:2345'); assert.equal(proxy.stop_grace_period, '2m30s');
  assert.equal(proxy.environment.OPENCRAFT_PROXY_PORT, '45071');
  assert.equal(brain.environment.OPENCRAFT_PROXY_MODE, 'external');
  assert.equal(brain.environment.OPENCRAFT_PROXY_PORT, proxy.environment.OPENCRAFT_PROXY_PORT);
  assert.equal(brain.depends_on.proxy.condition, 'service_healthy');
  assert.deepEqual(proxy.volumes.map(v => [v.source, v.target, v.read_only === true]), [
    ['/srv/opencraft/state', '/var/lib/opencraft', false], ['/srv/opencraft/workspaces', '/workspace', false],
    ['/srv/opencraft/logs', '/var/log/opencraft', true], ['/srv/opencraft/logs/proxy', '/var/log/opencraft/proxy', false],
  ]);
  assert.equal(deploymentPaths(proxy.environment).dataDirectory, deploymentPaths(brain.environment).dataDirectory);
});
