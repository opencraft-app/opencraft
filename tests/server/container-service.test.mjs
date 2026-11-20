import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import test from 'node:test';
import { build } from 'esbuild';
import { createServiceLog, runLoggedService } from '../../scripts/container-deployment/service.mjs';
import { hostLayout, inspectWorkspaceDirectory, legacyLayoutValues, prepareLayout } from '../../scripts/container-deployment/layout.mjs';
import { deploymentPaths } from '../../scripts/container-deployment/paths.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'opencraft-layout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const collect = stream => { let value = ''; stream.on('data', chunk => { value += chunk; }); return () => value; };

test('canonical paths share projectless cwd across Brain and Hands and separate state from user files', () => {
  const paths = deploymentPaths({ OPENCRAFT_DATA_DIR: '/var/lib/opencraft', OPENCRAFT_WORKSPACE_DIR: '/workspace' });
  assert.equal(paths.executionDirectory, '/var/lib/opencraft/execution');
  assert.equal(paths.browserDirectory, '/var/lib/opencraft/execution/browser');
  assert.equal(paths.threadCliDirectory, '/var/lib/opencraft/execution/cli');
  assert.equal(paths.codexProjectlessDirectory, '/workspace/sessions/codex');
  assert.equal(paths.dshProjectlessDirectory, '/workspace/sessions/dsh');
  assert.equal(paths.logDirectory, '/var/log/opencraft');
  const legacy = { OPENCRAFT_HOST_DATA_DIR: '/home/demo/.opencraft', OPENCRAFT_DATA_DIR: '/data/.opencraft', OPENCRAFT_WORKSPACE_DIR: '/data' };
  const adopted = deploymentPaths({ ...legacy, ...legacyLayoutValues(legacy) });
  assert.equal(adopted.codexProjectlessDirectory, '/data/.opencraft/hands/projectless-workspaces');
  assert.equal(adopted.browserDirectory, '/data/.opencraft/hands');
  assert.equal(adopted.handsExecutionEndpoint, '/data/.opencraft/hands/exec-owner.sock');
  assert.equal(adopted.dshProjectlessDirectory, '/data/.opencraft/workspaces');
});

test('layout preparation is idempotent, private and refuses to abandon existing browser state', async t => {
  const directory = await fixture(t);
  const env = { OPENCRAFT_HOST_DATA_DIR: join(directory, 'state'), OPENCRAFT_HOST_WORKSPACE_DIR: join(directory, 'workspaces'), OPENCRAFT_HOST_LOG_DIR: join(directory, 'logs') };
  const identity = { uid: process.getuid(), gid: process.getgid() };
  const layout = await prepareLayout(env, identity);
  await prepareLayout(env, identity);
  for (const service of ['brain', 'gateway', 'hands']) assert.equal((await stat(join(layout.logs, service))).mode & 0o777, 0o700);
  const legacy = join(layout.state, 'hands');
  await symlink(layout.execution, legacy);
  await assert.rejects(prepareLayout(env, identity), /adopt-legacy/);
  await assert.rejects(prepareLayout({ ...env, OPENCRAFT_HOST_EXECUTION_DIR: legacy }, identity), /symlink/);
  for (const logs of [layout.state, layout.execution, layout.workspace, directory])
    assert.throws(() => hostLayout({ ...env, OPENCRAFT_HOST_LOG_DIR: logs }), /Logs/);
});

test('service output remains on Docker stdout/stderr and persists with time and channel until a nonzero exit', async t => {
  const directory = await fixture(t), stdout = new PassThrough(), stderr = new PassThrough();
  const out = collect(stdout), err = collect(stderr);
  const result = await runLoggedService({ command: process.execPath,
    args: ['-e', 'process.stdout.write("服务就绪\\n");process.stderr.write("archive rejected\\n");process.exitCode=7'],
    directory, stdout, stderr });
  assert.equal(result.code, 7);
  assert.equal(out(), '服务就绪\n'); assert.equal(err(), 'archive rejected\n');
  const records = (await readFile(join(directory, 'service.log'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(records.every(entry => Number.isFinite(Date.parse(entry.time))));
  assert.equal(records.filter(entry => entry.stream === 'stdout').map(entry => entry.message).join(''), out());
  assert.equal(records.filter(entry => entry.stream === 'stderr').map(entry => entry.message).join(''), err());
  assert.equal((await stat(join(directory, 'service.log'))).mode & 0o777, 0o600);
});

test('service supervisor forwards SIGTERM and drains the child shutdown log', async t => {
  const directory = await fixture(t), stdout = new PassThrough(), stderr = new PassThrough(), signals = new EventEmitter();
  const out = collect(stdout); collect(stderr);
  const ready = once(stdout, 'data');
  const result = runLoggedService({ command: process.execPath, args: ['-e',
    'process.on("SIGTERM",()=>{console.log("shutdown complete");process.exitCode=0;clearInterval(timer)});const timer=setInterval(()=>{},1000);console.log("ready")'],
    directory, stdout, stderr, signals });
  await ready; signals.emit('SIGTERM');
  assert.equal((await result).code, 0);
  assert.match(out(), /shutdown complete/);
  assert.match(await readFile(join(directory, 'service.log'), 'utf8'), /shutdown complete/);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('rotation retains a bounded history across writer restarts', async t => {
  const directory = await fixture(t), options = { maxBytes: 256, archives: 2 };
  for (let run = 0; run < 2; run++) {
    const log = await createServiceLog(directory, options);
    for (let line = 0; line < 8; line++) await new Promise((accept, reject) => log.write(`${run}:${line}:${'x'.repeat(110)}\n`, error => error ? reject(error) : accept()));
    log.end(); await finished(log);
  }
  assert.deepEqual((await readdir(directory)).sort(), ['service.log', 'service.log.1', 'service.log.2']);
  for (const file of await readdir(directory)) assert.ok((await stat(join(directory, file))).size <= 256);
  assert.match(await readFile(join(directory, 'service.log'), 'utf8'), /1:7:/);
});

test('legacy adoption keeps existing session files in place without creating a second state tree', async t => {
  const directory = await fixture(t);
  const environment = { OPENCRAFT_HOST_DATA_DIR: join(directory, 'state'), OPENCRAFT_DATA_DIR: '/old/state', OPENCRAFT_HOST_WORKSPACE_DIR: join(directory, 'workspace'), OPENCRAFT_WORKSPACE_DIR: '/old/workspace' };
  const legacy = join(environment.OPENCRAFT_HOST_DATA_DIR, 'hands');
  await mkdir(join(legacy, 'projectless-workspaces', 'thread-existing'), { recursive: true, mode: 0o700 });
  const marker = join(legacy, 'projectless-workspaces', 'thread-existing', 'work.txt');
  await writeFile(marker, 'existing user work');
  const layout = await prepareLayout({ ...environment, ...legacyLayoutValues(environment) }, { uid: process.getuid(), gid: process.getgid() });
  assert.equal(layout.execution, legacy);
  assert.equal(await readFile(marker, 'utf8'), 'existing user work');
  assert.deepEqual((await readdir(layout.state)).sort(), ['hands', 'logs']);
});

test('shared workspace adoption does not loosen ownership rules for new deployments or accept writable roots', async t => {
  const directory = await fixture(t), identity = { uid: process.getuid(), gid: process.getgid() };
  await chmod(directory, 0o755);
  await assert.rejects(inspectWorkspaceDirectory(directory, identity, {}), /group or others/);
  await inspectWorkspaceDirectory(directory, identity, { OPENCRAFT_LEGACY_SHARED_WORKSPACE: '1' });
  assert.equal((await stat(directory)).mode & 0o777, 0o755);
  await chmod(directory, 0o777);
  await assert.rejects(inspectWorkspaceDirectory(directory, identity, { OPENCRAFT_LEGACY_SHARED_WORKSPACE: '1' }), /write access/);
});

test('the bundled service entry launches the packaged owner and records startup and fatal output', async t => {
  const directory = await fixture(t), runtime = join(directory, 'runtime');
  await mkdir(runtime); await mkdir(join(directory, 'bin'));
  await symlink(process.execPath, join(directory, 'bin', 'node'));
  await build({ entryPoints: [new URL('../../scripts/container-deployment/service.mjs', import.meta.url).pathname],
    outfile: join(runtime, 'container-service.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node26' });
  await writeFile(join(runtime, 'native-host.mjs'), 'console.log("Brain started");console.error("startup failed");process.exitCode=9');
  const child = spawn(process.execPath, [join(runtime, 'container-service.mjs'), 'brain'], {
    env: { ...process.env, OPENCRAFT_LOG_DIR: join(directory, 'logs') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = collect(child.stdout), err = collect(child.stderr);
  const [code] = await once(child, 'close');
  assert.equal(code, 9); assert.match(out(), /Brain started/); assert.match(err(), /startup failed/);
  assert.match(await readFile(join(directory, 'logs', 'brain', 'service.log'), 'utf8'), /startup failed/);
});

test('logging refuses symlink targets before launching a service and reports spawn errors', async t => {
  const directory = await fixture(t), target = join(directory, 'private.txt');
  await writeFile(target, 'unchanged', { mode: 0o600 });
  await symlink(target, join(directory, 'service.log'));
  await assert.rejects(createServiceLog(directory), /ELOOP/);
  assert.equal(await readFile(target, 'utf8'), 'unchanged');
  await assert.rejects(runLoggedService({ command: join(directory, 'missing-executable'), args: [], directory: join(directory, 'missing') }), /ENOENT/);
});
