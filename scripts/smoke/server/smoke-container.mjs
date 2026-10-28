import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const image = process.env.OPENCRAFT_IMAGE ?? 'opencraft:local';
const name = `opencraft-smoke-${randomBytes(5).toString('hex')}`;
const directory = await mkdtemp(join(tmpdir(), name));
const architecture = execFileSync('docker', ['image', 'inspect', image, '--format', '{{.Architecture}}'], {encoding: 'utf8'}).trim();
const platform = `linux/${architecture}`;
const native = process.platform === 'linux' && ({x64:'amd64',arm64:'arm64'})[process.arch] === architecture;
const data = native ? join(directory, 'data') : '/var/lib/opencraft';
const workspace = native ? join(directory, 'workspaces') : '/workspaces';
let host, hostExit, passed = false;
let hostOutput = '', hostFailure, hostStopping = false;
let gatewayArgs;
let gateway = `${name}-gateway`;
const volume = `${name}-data`, projects = `${name}-projects`, fixture = `${name}-host`;
const env = { ...process.env, OPENCRAFT_IMAGE: image, OPENCRAFT_DATA_DIR: data,
  OPENCRAFT_WORKSPACE_DIR: workspace, OPENCRAFT_UID: String(process.getuid()), OPENCRAFT_GID: String(process.getgid()), OPENCRAFT_PLATFORM: platform };
function docker(args, options = {}) {
  return (execFileSync('docker', args, { cwd: root, env, encoding: 'utf8', timeout: 600_000,
    stdio: ['ignore', 'pipe', 'pipe'], ...options }) ?? '').trim();
}
const compose = args => docker(['compose', '-f', join(root, 'docker/compose.yaml'), '-p', name, ...args]);
let origin;
async function waitFor(read, predicate, description) {
  let last;
  for (let i = 0; i < 180; i++) {
    if (hostFailure) throw new Error('Native Host exited: ' + hostOutput.slice(-4000));
    const state = spawnSync('docker', ['inspect', '--format', '{{.State.Status}}', gateway], { encoding: 'utf8' }).stdout?.trim();
    if (state === 'exited') throw new Error('Gateway exited before ' + description);
    try { const value = await read(); if (predicate(value)) return value; }
    catch (error) { last = error; }
    await new Promise(accept => setTimeout(accept, 500));
  }
  throw new Error(`Timed out: ${description}`, { cause: last });
}
async function health() {
  const response = await fetch(origin + '/health', { signal: AbortSignal.timeout(12_000) });
  return { status: response.status, body: await response.json() };
}
const ready = () => waitFor(health, r => r.status === 200 && r.body.ok === true && r.body.hosts?.['local-codex']?.state === 'ready', 'external execution readiness');
function startHost() {
  hostStopping = false; hostFailure = false; hostOutput = '';
  if (native) {
    const hostEnv = { PATH: process.env.PATH, HOME: join(directory, 'home'),
      OPENCRAFT_DATA_DIR: data, OPENCRAFT_WORKSPACE_DIR: workspace };
    host = spawn(join(directory, 'payload/bin/opencraft-host'), [], { cwd: directory, env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  } else host = spawn('docker', ['exec', fixture, '/bin/sh', '-c',
    'umask 077; echo $$ > /tmp/opencraft-native-host.pid; exec /opt/opencraft/bin/opencraft-host'],
  { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  hostExit = once(host, 'exit');
  host.once('exit', () => { if (!hostStopping) hostFailure = true; });
  for (const stream of [host.stdout, host.stderr]) stream.on('data', chunk => { hostOutput = (hostOutput + chunk).slice(-8000); });
}
async function stopHost() {
  hostStopping = true;
  if (native && host && host.exitCode === null) { host.kill('SIGTERM'); await hostExit; }
  else if (!native) {
    docker(['exec', fixture, '/opt/opencraft/bin/node', '-e',
      "process.kill(Number(require('node:fs').readFileSync('/tmp/opencraft-native-host.pid','utf8')),'SIGTERM')"]);
    await waitFor(() => docker(['exec', fixture, '/opt/opencraft/bin/node', '-e',
      `if(require('node:fs').existsSync(${JSON.stringify(join(data, 'run/engine-host.json'))}) || require('node:fs').existsSync(${JSON.stringify(join(data, 'run/codex-core.sock'))}) || require('node:fs').existsSync(${JSON.stringify(join(data, 'run/dsh-host.json'))}) || require('node:fs').existsSync(${JSON.stringify(join(data, 'run/codex-app-server.sock'))}))process.exit(1)`]),
    () => true, 'fixture native owners stop');
    await hostExit;
  }
}
function readState(file) {
  return docker(['exec', gateway, '/opt/opencraft/bin/node', '-e',
    `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(join(data, file))},'utf8'))`]);
}
try {
  if (native) {
    await mkdir(join(directory, 'home'), { mode: 0o700 });
    docker(['buildx', 'build', '-f', 'docker/Dockerfile', '--platform', platform, '--target', 'host-artifact',
      '--output', `type=local,dest=${join(directory, 'payload')}`, '.'], { stdio: 'inherit' });
    const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    env.OPENCRAFT_PORT = String(listener.address().port); await new Promise(accept => listener.close(accept));
    origin = `http://127.0.0.1:${env.OPENCRAFT_PORT}`;
    startHost();
    await waitFor(() => readFile(join(data, 'run/engine-host.json'), 'utf8'), Boolean, 'native Host descriptor');
    await waitFor(() => hostOutput, value => value.includes('native execution Hosts ready'), 'native Host readiness');
    compose(['up', '-d', '--no-build']);
    gateway = compose(['ps', '-q', 'opencraft']);
  } else {
    docker(['volume', 'create', volume]); docker(['volume', 'create', projects]);
    docker(['run', '--rm', '--platform', platform, '--user', '0',
      '-v', `${volume}:${data}`, '-v', `${projects}:${workspace}`, '--entrypoint', '/bin/sh', image,
      '-c', `chown ${env.OPENCRAFT_UID}:${env.OPENCRAFT_GID} /var/lib/opencraft /workspaces && chmod 700 /var/lib/opencraft /workspaces`]);
    docker(['create', '--platform', platform, '--user', `${env.OPENCRAFT_UID}:${env.OPENCRAFT_GID}`, '--name', fixture,
      '-p', '127.0.0.1::10000', '-v', `${volume}:${data}`, '-v', `${projects}:${workspace}`,
      '-e', `OPENCRAFT_DATA_DIR=${data}`, '-e', `OPENCRAFT_WORKSPACE_DIR=${workspace}`,
      '--entrypoint', '/bin/sleep', image, 'infinity']);
    docker(['start', fixture]);
    startHost();
    origin = 'http://' + docker(['port', fixture, '10000/tcp']);
    await waitFor(() => docker(['exec', fixture, 'test', '-f', join(data, 'run/engine-host.json')]), () => true, 'fixture Host descriptor');
    await waitFor(() => hostOutput, value => value.includes('native execution Hosts ready'), 'fixture Host readiness');
    gatewayArgs = ['run', '-d', '--platform', platform, '--user', `${env.OPENCRAFT_UID}:${env.OPENCRAFT_GID}`, '--name', gateway,
      '--network', `container:${fixture}`, '--pid', `container:${fixture}`, '-v', `${volume}:${data}`, '-v', `${projects}:${workspace}`,
      '-e', `OPENCRAFT_DATA_DIR=${data}`, '-e', `OPENCRAFT_WORKSPACE_DIR=${workspace}`, image,
      '--host', '0.0.0.0', '--allow-unauthenticated-public', '--data-dir', data, '--engines', 'dsh,pi', '--default-engine', 'pi'];
    docker(['exec', fixture, 'test', '!', '-e', join(data, 'server.lock')]);
    docker(gatewayArgs);
  }
  const first = await ready();
  assert.equal(first.body.dependencies.core, 'ready');
  assert.equal(first.body.dependencies.engineHost, 'ready');
  assert.equal(first.body.dependencies.dsh, 'ready');
  const processEvidence = docker(['exec', gateway, '/opt/opencraft/bin/node', '-e',
    `const fs=require('node:fs');const pid=${first.body.engineHost.pid};if(fs.statSync('/proc/'+pid).uid!==process.getuid())throw Error('Host UID mismatch');process.stdout.write(fs.readFileSync('/proc/'+pid+'/cmdline','utf8'))`]);
  assert.match(processEvidence, /runtime\/engine-host\.mjs/);
  const socketType = docker(['exec', gateway, '/opt/opencraft/bin/node', '-e',
    `const fs=require('node:fs');const s=fs.lstatSync(${JSON.stringify(join(data, 'run/native.sock'))});if(!s.isSocket()||s.isSymbolicLink())throw Error('A real shared native socket is required');process.stdout.write('socket')`]);
  assert.equal(socketType, 'socket');
  const html = await fetch(origin).then(r => r.text());
  assert.match(html, /<html|<!doctype html/i);
  assert.match(html, /assets\/.*\.js/);
  const marker = randomBytes(12).toString('hex');
  docker(['exec', gateway, '/opt/opencraft/bin/node', '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(join(data, 'docker-smoke-marker'))},${JSON.stringify(marker)})`]);
  if (native) {
    const engineArgs = await readFile(`/proc/${first.body.engineHost.pid}/cmdline`, 'utf8');
    assert.match(engineArgs, /runtime\/engine-host\.mjs/);
    compose(['up', '-d', '--force-recreate', '--no-build']);
    gateway = compose(['ps', '-q', 'opencraft']);
  } else {
    docker(['stop', '--time', '30', gateway]);
    docker(['rm', gateway]);
    docker(gatewayArgs);
  }
  const second = await ready();
  assert.equal(second.body.core.pid, first.body.core.pid);
  assert.equal(second.body.core.codexPid, first.body.core.codexPid);
  assert.equal(second.body.engineHost.pid, first.body.engineHost.pid);
  assert.equal(second.body.dsh.enginePid, first.body.dsh.enginePid);
  assert.equal(readState('docker-smoke-marker'), marker);
  await stopHost();
  await waitFor(health, r => r.status === 503 && r.body.ok === false, 'unavailable external owner is reported without fallback');
  // A fresh descriptor is read on subsequent requests; the gateway stays alive.
  startHost();
  const recovered = await ready();
  assert.equal(readState('docker-smoke-marker'), marker);
  assert.notEqual(recovered.body.core.pid, first.body.core.pid);
  assert.notEqual(recovered.body.engineHost.pid, first.body.engineHost.pid);
  assert.notEqual(recovered.body.dsh.enginePid, first.body.dsh.enginePid);
  passed = true;
  console.log(JSON.stringify({ ok: true, mode: native ? 'native-linux-host' : 'separate-linux-owner-fixture',
    origin, gateway, ...(native ? {} : { fixture, volumes: [volume, projects] }),
    persistence: true, gatewayRestartKeepsOwners: true, hostUnavailable: '503', hostRecovery: true }));
} catch (error) {
  process.stderr.write(hostOutput + '\n');
  for (const id of [gateway, fixture]) {
    const logs = spawnSync('docker', ['logs', '--tail', '60', id], { encoding: 'utf8' });
    process.stderr.write((logs.stdout ?? '') + (logs.stderr ?? ''));
  }
  throw error;
} finally {
  if (!(passed && process.env.OPENCRAFT_CONTAINER_SMOKE_KEEP === '1')) {
    if (native) { try { compose(['down']); } catch {} await stopHost(); }
    else {
      for (const id of [gateway, fixture]) { try { docker(['rm', '-f', id]); } catch {} }
      for (const v of [volume, projects]) { try { docker(['volume', 'rm', v]); } catch {} }
    }
    await rm(directory, { recursive: true, force: true });
  }
}
