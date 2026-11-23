import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chown, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareLayout, SERVICES } from '../../container-deployment/layout.mjs';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const image = process.env.OPENCRAFT_IMAGE ?? 'opencraft:local';
const name = `opencraft-smoke-${randomBytes(5).toString('hex')}`;
const directory = await mkdtemp(join(tmpdir(), name));
const data = join(directory, 'state'), workspace = join(directory, 'workspaces'), logs = join(directory, 'logs');
// Chromium deliberately keeps its sandbox enabled, so a root CI runner uses
// the image's unprivileged account unless the smoke caller selects another ID.
const deploymentUid = Number(process.env.OPENCRAFT_SMOKE_UID ?? (process.getuid() === 0 ? 1000 : process.getuid()));
const deploymentGid = Number(process.env.OPENCRAFT_SMOKE_GID ?? (process.getgid() === 0 ? 1000 : process.getgid()));
if (![deploymentUid, deploymentGid].every(Number.isInteger)) throw new Error('Smoke UID and GID must be integers');
const architecture = execFileSync('docker', ['image', 'inspect', image, '--format', '{{.Architecture}}'], { encoding: 'utf8' }).trim();
const env = { ...process.env, OPENCRAFT_IMAGE: image, OPENCRAFT_DATA_DIR: data,
  OPENCRAFT_HOST_DATA_DIR: data, OPENCRAFT_HOST_WORKSPACE_DIR: workspace,
  OPENCRAFT_HOST_LOG_DIR: logs, OPENCRAFT_LOG_DIR: '/var/log/opencraft',
  OPENCRAFT_HOST_EXECUTION_DIR: join(data, 'execution'), OPENCRAFT_EXECUTION_DIR: join(data, 'execution'),
  OPENCRAFT_BROWSER_DATA_DIR: join(data, 'execution', 'browser'),
  OPENCRAFT_CODEX_PROJECTLESS_DIR: join(workspace, 'sessions', 'codex'),
  OPENCRAFT_DSH_PROJECTLESS_DIR: join(workspace, 'sessions', 'dsh'),
  OPENCRAFT_GATEWAY_HOME: join(data, 'home', 'gateway'),
  OPENCRAFT_WORKSPACE_DIR: workspace, OPENCRAFT_UID: String(deploymentUid), OPENCRAFT_GID: String(deploymentGid),
  OPENCRAFT_PLATFORM: `linux/${architecture}` };
function docker(args, options = {}) {
  return (execFileSync('docker', args, { cwd: root, env, encoding: 'utf8', timeout: 600_000,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...options }) ?? '').trim();
}
const compose = args => docker(['compose', '--env-file', '/dev/null', '-f', join(root, 'deploy/docker/compose.yaml'), '-p', name, ...args]);
async function freePortBelowEphemeralRange() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = 20_000 + Math.floor(Math.random() * 12_000);
    const listener = createServer();
    const bound = await new Promise(resolve => {
      listener.once('error', () => resolve(false));
      listener.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (bound) { await new Promise(resolve => listener.close(resolve)); return port; }
  }
  throw new Error('no free port below the ephemeral range');
}

async function waitFor(read, predicate, description) {
  let last;
  for (let attempt = 0; attempt < 240; attempt++) {
    try { const value = await read(); if (predicate(value)) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out: ${description}`, { cause: last });
}
const topPid = (service, pattern) => {
  const id = compose(['ps', '-q', service]);
  const line = docker(['top', id, '-eo', 'pid,args']).split('\n').find(value => value.includes(pattern));
  assert.ok(line, `${service} must run ${pattern}`);
  return Number(line.trim().split(/\s+/u)[0]);
};
const topIncludesNativeExecServer = service => {
  const id = compose(['ps', '-q', service]);
  return docker(['top', id, '-eo', 'pid,args']).split('\n').some(value =>
    value.includes('exec-server --listen stdio') && !value.includes('sandbox-command.mjs'));
};

let passed = false, origin;
try {
  const layout = await prepareLayout(env, { uid: process.getuid(), gid: process.getgid() });
  if (process.getuid() === 0) for (const path of [directory, layout.state, layout.execution, layout.gitCredentials, layout.workspace, layout.logs, ...SERVICES.map(service => join(logs, service))]) await chown(path, deploymentUid, deploymentGid);
  // The Gateway binds this port only after Brain and Hands are healthy, and they share
  // the host network. A kernel-assigned port is from the ephemeral range, so one of
  // them can be handed it in between; probe a free port below that range instead.
  env.OPENCRAFT_PORT = String(await freePortBelowEphemeralRange());
  origin = `http://127.0.0.1:${env.OPENCRAFT_PORT}`;
  compose(['up', '-d', '--no-build', '--wait']);
  const health = async () => {
    const response = await fetch(origin + '/health', { signal: AbortSignal.timeout(12_000) });
    return { status: response.status, body: await response.json() };
  };
  const ready = () => waitFor(health, value => value.status === 200 && value.body.ok && value.body.hosts?.['local-codex']?.state === 'ready', 'three-owner readiness');
  const first = await ready();
  // Brain and Hands each run one workspace agent with a container-private run directory.
  const agent = service => JSON.parse(docker(['exec', compose(['ps', '-q', service]), '/opt/opencraft/bin/opencraft-health', 'agent']));
  const agents = { brain: agent('brain'), hands: agent('hands') };
  assert.deepEqual(agents.brain.roles, ['brain']);
  assert.deepEqual(agents.hands.roles, ['hands', 'browser']);
  for (const value of Object.values(agents)) assert.equal(value.type, 'healthy');
  assert.deepEqual(agents.brain.components.map(c => c.name), ['codex-app-server', 'dsh-host', 'engine-host']);
  assert.deepEqual(agents.hands.components.map(c => c.name), ['exec', 'terminal', 'files', 'browser']);
  const sharedRun = await readdir(join(data, 'run'));
  for (const privateName of ['engine-host-config.json', 'dsh-host-config.json', 'codex-hands-sandbox.json', 'native-internal.sock', 'control.sock',
    // Step 4c: the Gateway reaches Brain owners as workspace endpoints, not through the shared run directory.
    'engine-host.json', 'dsh-host.json', 'codex-app-server.sock', 'native.sock', 'codex-app-server-environment.json'])
    assert.ok(!sharedRun.includes(privateName), `${privateName} must stay container-private`);
  const gatewayLinks = docker(['exec', compose(['ps', '-q', 'gateway']), 'ls', '/run/opencraft-links/brain', '/run/opencraft-links/hands']);
  assert.match(gatewayLinks, /link\.sock[\s\S]*link\.sock/, 'the Gateway reaches Brain and Hands through their static-docker links');
  assert.notEqual(spawnSync('docker', ['exec', compose(['ps', '-q', 'gateway']), 'test', '-e', '/run/opencraft-agent/control.sock']).status, 0,
    'Gateway cannot see an agent run directory');
  const terminalProbe = await readFile(join(root, 'scripts/smoke/server/hands-terminal-probe.mjs'), 'utf8');
  const gatewayContainer = compose(['ps', '-q', 'gateway']);
  const terminal = JSON.parse(docker(['exec', '-i', gatewayContainer, '/opt/opencraft/bin/node', '--input-type=module', '-', 'start', workspace], { input: terminalProbe }));
  // Namespace inode plus cgroup path: v2 gives each container a private namespace, v1 shares the host's.
  const cgroupNamespace = service => compose(['exec', '-T', service, '/opt/opencraft/bin/node', '-p',
    "const fs = require('node:fs'); fs.readlinkSync('/proc/self/ns/cgroup') + (fs.readFileSync('/proc/self/cgroup', 'utf8').split('\\n').find(line => /^0::|:memory:/.test(line)) ?? '::').split(':')[2]"]);
  assert.equal(terminal.cgroupNamespace, cgroupNamespace('hands'), 'PTY must run in the Hands container');
  for (const service of ['brain', 'gateway']) assert.notEqual(terminal.cgroupNamespace, cgroupNamespace(service), `PTY must not run in ${service}`);
  for (const service of SERVICES) {
    const records = (await readFile(join(logs, service, 'service.log'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(records.length > 0 && records.every(record => record.time && record.stream));
  }
  const handsContainer = compose(['ps', '-q', 'hands']);
  assert.ok(docker(['exec', handsContainer, 'cat', '/var/log/opencraft/brain/service.log']).length > 0);
  const denied = spawnSync('docker', ['exec', handsContainer, 'sh', '-c', 'echo forbidden >> /var/log/opencraft/brain/service.log'], { encoding: 'utf8' });
  assert.notEqual(denied.status, 0, 'Hands must not modify Brain logs');
  // core.pid is the proxy's account Core; Brain owns AppServer, native Codex and the engine Hosts.
  const proxyCore = first.body.core.pid;
  const brain = {
    core: first.body.core.appServerPid, codex: first.body.core.codexPid,
    engine: first.body.engineHost.pid, dsh: first.body.dsh.enginePid,
  };
  const hands = {
    owner: topPid('hands', 'owner.cjs'),
    worker: topPid('hands', 'worker.cjs'),
    exec: topPid('hands', 'exec-server --listen stdio'),
  };
  assert.equal(topIncludesNativeExecServer('brain'), false,
    'Brain must delegate Codex native execution to Hands');
  const marker = randomBytes(12).toString('hex');
  await writeFile(join(data, 'docker-smoke-marker'), marker);

  // Recreate only the stateless attachment. Both resource owners must survive.
  compose(['up', '-d', '--no-deps', '--force-recreate', 'gateway']);
  const second = await ready();
  const resumedTerminal = JSON.parse(docker(['exec', '-i', compose(['ps', '-q', 'gateway']), '/opt/opencraft/bin/node', '--input-type=module', '-', 'resume', workspace, JSON.stringify(terminal)], { input: terminalProbe }));
  assert.equal(resumedTerminal.preserved, true);
  assert.deepEqual({ core: second.body.core.appServerPid, codex: second.body.core.codexPid,
    engine: second.body.engineHost.pid, dsh: second.body.dsh.enginePid }, brain);
  assert.deepEqual({ owner: topPid('hands', 'owner.cjs'), worker: topPid('hands', 'worker.cjs'),
    exec: topPid('hands', 'exec-server --listen stdio') }, hands);
  assert.equal(await readFile(join(data, 'docker-smoke-marker'), 'utf8'), marker);

  // Loss is reported; Gateway never starts an embedded fallback owner.
  compose(['stop', '-t', '30', 'brain']);
  await waitFor(health, value => value.status === 503 && !value.body.ok, 'Brain loss reported');
  compose(['start', 'brain']);
  const recovered = await ready();
  assert.notEqual(recovered.body.core.appServerPid, brain.core);
  assert.equal(recovered.body.core.pid, proxyCore, 'Brain restart must not restart the model proxy');
  assert.deepEqual({ owner: topPid('hands', 'owner.cjs'), worker: topPid('hands', 'worker.cjs') },
    { owner: hands.owner, worker: hands.worker });
  assert.notEqual(topPid('hands', 'exec-server --listen stdio'), hands.exec,
    'Brain restart must replace its leased Hands execution process');
  assert.equal(topIncludesNativeExecServer('brain'), false,
    'Brain must not reacquire an embedded Codex exec-server');
  const restarted = agent('brain');
  assert.notEqual(restarted.incarnation.id, agents.brain.incarnation.id, 'a Brain restart is a new agent incarnation');
  assert.equal(agent('hands').incarnation.id, agents.hands.incarnation.id);

  // A critical child failure ends the whole agent; Docker restarts the container as a new incarnation.
  const brainId = compose(['ps', '-q', 'brain']);
  const startedAt = () => docker(['inspect', '-f', '{{.State.StartedAt}}', brainId]);
  const before = startedAt();
  process.kill(topPid('brain', 'runtime/engine-host.mjs'), 'SIGKILL');
  await waitFor(async () => startedAt(), value => value !== before, 'Brain agent exit and container restart');
  const replaced = await ready();
  assert.equal(replaced.body.core.pid, proxyCore, 'a Brain child failure must not restart the model proxy');
  const reincarnated = agent('brain');
  assert.notEqual(reincarnated.incarnation.id, restarted.incarnation.id);
  assert.match(await readFile(join(logs, 'brain', 'service.log'), 'utf8'), /workspace-agent-child-failed[^\n]*engine-host/);
  assert.equal(agent('hands').incarnation.id, agents.hands.incarnation.id, 'Hands is a separate agent');
  passed = true;
  console.log(JSON.stringify({ ok: true, origin, persistence: true,
    gatewayRestartKeepsBrain: true, gatewayRestartKeepsHands: true, brainUnavailable: 503, brainRecovery: true,
    agentIncarnations: [agents.brain.incarnation.id, restarted.incarnation.id, reincarnated.incarnation.id], criticalChildExit: true }));
} catch (error) {
  const logs = spawnSync('docker', ['compose', '--env-file', '/dev/null', '-f', join(root, 'deploy/docker/compose.yaml'), '-p', name, 'logs', '--tail=100'],
    { cwd: root, env, encoding: 'utf8' });
  process.stderr.write((logs.stdout ?? '') + (logs.stderr ?? ''));
  throw error;
} finally {
  if (!(passed && process.env.OPENCRAFT_CONTAINER_SMOKE_KEEP === '1')) {
    // --volumes: the static-docker link volumes are per project and hold no data.
    try { compose(['down', '--remove-orphans', '--volumes']); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
}
