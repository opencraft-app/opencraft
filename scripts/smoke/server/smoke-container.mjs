import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chown, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const image = process.env.OPENCRAFT_IMAGE ?? 'opencraft:local';
const name = `opencraft-smoke-${randomBytes(5).toString('hex')}`;
const directory = await mkdtemp(join(tmpdir(), name));
const data = join(directory, 'data'), workspace = join(directory, 'workspaces');
// Chromium deliberately keeps its sandbox enabled, so a root CI runner uses
// the image's unprivileged account unless the smoke caller selects another ID.
const deploymentUid = Number(process.env.OPENCRAFT_SMOKE_UID ?? (process.getuid() === 0 ? 1000 : process.getuid()));
const deploymentGid = Number(process.env.OPENCRAFT_SMOKE_GID ?? (process.getgid() === 0 ? 1000 : process.getgid()));
if (![deploymentUid, deploymentGid].every(Number.isInteger)) throw new Error('Smoke UID and GID must be integers');
const architecture = execFileSync('docker', ['image', 'inspect', image, '--format', '{{.Architecture}}'], { encoding: 'utf8' }).trim();
const env = { ...process.env, OPENCRAFT_IMAGE: image, OPENCRAFT_DATA_DIR: data,
  OPENCRAFT_HOST_DATA_DIR: data, OPENCRAFT_HOST_WORKSPACE_DIR: workspace,
  OPENCRAFT_WORKSPACE_DIR: workspace, OPENCRAFT_UID: String(deploymentUid), OPENCRAFT_GID: String(deploymentGid),
  OPENCRAFT_PLATFORM: `linux/${architecture}` };
function docker(args, options = {}) {
  return (execFileSync('docker', args, { cwd: root, env, encoding: 'utf8', timeout: 600_000,
    stdio: ['ignore', 'pipe', 'pipe'], ...options }) ?? '').trim();
}
const compose = args => docker(['compose', '-f', join(root, 'docker/compose.yaml'), '-p', name, ...args]);
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
  await mkdir(data, { mode: 0o700 }); await mkdir(join(data, 'hands'), { mode: 0o700 }); await mkdir(workspace, { mode: 0o700 });
  if (process.getuid() === 0) for (const path of [directory, data, join(data, 'hands'), workspace]) await chown(path, deploymentUid, deploymentGid);
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  env.OPENCRAFT_PORT = String(listener.address().port); await new Promise(resolve => listener.close(resolve));
  origin = `http://127.0.0.1:${env.OPENCRAFT_PORT}`;
  compose(['up', '-d', '--no-build', '--wait']);
  const health = async () => {
    const response = await fetch(origin + '/health', { signal: AbortSignal.timeout(12_000) });
    return { status: response.status, body: await response.json() };
  };
  const ready = () => waitFor(health, value => value.status === 200 && value.body.ok && value.body.hosts?.['local-codex']?.state === 'ready', 'three-owner readiness');
  const first = await ready();
  const brain = {
    core: first.body.core.pid, codex: first.body.core.codexPid,
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
  assert.deepEqual({ core: second.body.core.pid, codex: second.body.core.codexPid,
    engine: second.body.engineHost.pid, dsh: second.body.dsh.enginePid }, brain);
  assert.deepEqual({ owner: topPid('hands', 'owner.cjs'), worker: topPid('hands', 'worker.cjs'),
    exec: topPid('hands', 'exec-server --listen stdio') }, hands);
  assert.equal(await readFile(join(data, 'docker-smoke-marker'), 'utf8'), marker);

  // Loss is reported; Gateway never starts an embedded fallback owner.
  compose(['stop', '-t', '30', 'brain']);
  await waitFor(health, value => value.status === 503 && !value.body.ok, 'Brain loss reported');
  compose(['start', 'brain']);
  const recovered = await ready();
  assert.notEqual(recovered.body.core.pid, brain.core);
  assert.deepEqual({ owner: topPid('hands', 'owner.cjs'), worker: topPid('hands', 'worker.cjs') },
    { owner: hands.owner, worker: hands.worker });
  assert.notEqual(topPid('hands', 'exec-server --listen stdio'), hands.exec,
    'Brain restart must replace its leased Hands execution process');
  assert.equal(topIncludesNativeExecServer('brain'), false,
    'Brain must not reacquire an embedded Codex exec-server');
  passed = true;
  console.log(JSON.stringify({ ok: true, origin, persistence: true,
    gatewayRestartKeepsBrain: true, gatewayRestartKeepsHands: true, brainUnavailable: 503, brainRecovery: true }));
} catch (error) {
  const logs = spawnSync('docker', ['compose', '-f', join(root, 'docker/compose.yaml'), '-p', name, 'logs', '--tail=100'],
    { cwd: root, env, encoding: 'utf8' });
  process.stderr.write((logs.stdout ?? '') + (logs.stderr ?? ''));
  throw error;
} finally {
  if (!(passed && process.env.OPENCRAFT_CONTAINER_SMOKE_KEEP === '1')) {
    try { compose(['down', '--remove-orphans']); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
}
