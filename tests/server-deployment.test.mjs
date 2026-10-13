import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readlink, writeFile, rm, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createManagedWebServer } from '../scripts/web-deployment/server.mjs';
import { createExecutionDeployment } from '../scripts/server-deployment/execution.mjs';
import { parseWebUpdateStatus } from '../packages/web-update-protocol/src/index.mjs';
import { releaseFixture } from './web-deployment-fixture.mjs';

async function until(read, condition) {
  for (let i = 0; i < 500; i++) { const value = await read(); if (condition(value)) return value; await delay(20); }
  throw new Error('Update did not finish');
}
test('server update commits both versions, restores execution after failure and reconciles interrupted pointers', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencraft-server-update-'));
  let app, fixture, gatewayIdentity; let cookie = ''; let base; let failReadiness = false; let failRestart = false; let failCommit = false; let failRollbackRestart = false;
  const state = join(root, 'state'); await mkdir(state);
  const link = join(state, 'execution-current'); const tokenPath = join(root, 'token'); await writeFile(tokenPath, 'synthetic-token');
  const health = { protocolVersion: 1, pid: 123, codexPid: 456 };
  const core = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer synthetic-token');
    response.end(JSON.stringify(health));
  });
  const endpoint = join(root, 'core.sock'); await new Promise(done => core.listen(endpoint, done));
  const gateway = createServer((request, response) => {
    if (gatewayIdentity === null) { response.destroy(); return; }
    response.end(JSON.stringify({ ok: true, ...gatewayIdentity, core: health }));
  });
  await new Promise(done => gateway.listen(0, '127.0.0.1', done));
  let restarts = [];
  const execution = createExecutionDeployment({ link, unit: 'execution.service', coreUnit: 'core.service', coreEndpoint: endpoint, tokenPath,
    healthUrl: `http://127.0.0.1:${gateway.address().port}/health`, timeout: 300,
    validate: async () => {}, prepareAccess: async () => {}, restart: async () => {
      const manifest = JSON.parse(await readFile(join(await readlink(link), 'package.json'), 'utf8'));
      restarts.push(manifest.version);
      if (failRollbackRestart && manifest.version === '1.0.0') throw new Error('Synthetic rollback restart denied');
      if (failRestart && manifest.version === '1.1.0') throw new Error('Synthetic execution startup failure');
      if (failReadiness && manifest.version === '1.1.0') { gatewayIdentity = null; return; }
      gatewayIdentity = { version: manifest.version, buildId: manifest.opencraftWeb.buildId };
    } });
  const status = async () => parseWebUpdateStatus(await (await fetch(base + '/__opencraft_updates', { headers: { cookie } })).json());
  const post = (action, input = {}) => fetch(base + '/__opencraft_updates/' + action, { method: 'POST', headers: { origin: base, cookie, 'content-type': 'application/json' }, body: JSON.stringify(input) });
  async function open() {
    app = await createManagedWebServer({ initialRelease: fixture.releases.get('1.0.0').packageRoot, stateDirectory: state, source: fixture.source, execution,
      stateWriter: async (path, value) => {
        if (failCommit && value.current.version === '1.1.0') { failCommit = false; throw new Error('Synthetic disk failure'); }
        await writeFile(path, JSON.stringify(value));
      } });
    base = `http://127.0.0.1:${(await app.listen({ port: 0 })).port}`;
    const login = await post('login', { key: (await readFile(app.adminKeyPath, 'utf8')).trim() });
    cookie = login.headers.get('set-cookie').split(';')[0];
  }
  async function install(version) {
    fixture.select(version); await post('check'); await until(status, s => !s.checking && s.latest?.version === version);
    assert.equal((await post('install', { version })).status, 202);
    return until(status, s => ['completed', 'failed'].includes(s.job?.phase));
  }
  try {
    fixture = await releaseFixture(root, { execution: true });
    const { pathToFileURL } = await import('node:url');
    const plugin = await import(pathToFileURL(join(fixture.releases.get('1.0.0').packageRoot, 'execution/dsh-capability-plugin.mjs')).href);
    assert.equal(typeof plugin.apply, 'function');
    await open();
    assert.equal((await status()).execution.version, '1.0.0');
    failReadiness = true;
    const readinessFailure = await install('1.1.0');
    assert.equal(readinessFailure.job.phase, 'failed');
    assert.match(readinessFailure.job.error, /Execution release failed readiness/);
    assert.equal(readinessFailure.current.version, '1.0.0');
    assert.equal(gatewayIdentity.version, '1.0.0');
    assert.deepEqual(restarts.slice(-2), ['1.1.0', '1.0.0']);
    failReadiness = false;
    failRestart = true;
    const startup = await install('1.1.0');
    assert.equal(startup.job.phase, 'failed'); assert.match(startup.job.error, /startup failure/);
    assert.equal(startup.current.version, '1.0.0'); assert.equal(gatewayIdentity.version, '1.0.0');
    assert.deepEqual(restarts.slice(-2), ['1.1.0', '1.0.0']);
    failRestart = false; failCommit = true;
    const disk = await install('1.1.0'); assert.equal(disk.job.phase, 'failed');
    assert.equal(gatewayIdentity.version, '1.0.0'); assert.equal(disk.current.version, '1.0.0');
    const archive = fixture.releases.get('1.1.0');
    const restartsBeforeCorruption = restarts.length;
    await post('install-local', { archive: archive.archive, version: '1.1.0', buildId: archive.buildId, integrity: 'sha512-' + Buffer.alloc(64).toString('base64') });
    const invalidLocal = await until(status, s => s.job.phase === 'failed');
    assert.match(invalidLocal.job.error, /integrity mismatch/); assert.equal(restarts.length, restartsBeforeCorruption);
    const { updateLocalServer } = await import('../scripts/update-server-local.mjs');
    const local = await updateLocalServer({ version: '1.1.0', archive: archive.archive, buildId: archive.buildId, url: base, stateDirectory: state });
    assert.equal(local.execution.version, '1.1.0');
    const installed = await status();
    assert.equal(installed.job.phase, 'completed'); assert.equal(installed.execution.version, '1.1.0');
    assert.equal(gatewayIdentity.buildId, installed.current.buildId);
    await post('rollback'); await until(status, s => s.current.version === '1.0.0' && s.job.phase === 'completed');
    assert.equal(gatewayIdentity.version, '1.0.0');
    const before = restarts.length;
    const worker = await install('1.2.0'); assert.equal(worker.job.phase, 'failed'); assert.equal(restarts.length, before);
    failCommit = true; failRollbackRestart = true;
    const uncertain = await install('1.1.0');
    assert.equal(uncertain.job.phase, 'failed'); assert.match(uncertain.job.error, /rollback failed/);
    assert.equal(uncertain.current.version, '1.0.0');
    assert.equal(uncertain.execution.version, '1.1.0'); assert.equal(uncertain.execution.ready, false);
    assert.equal(gatewayIdentity.version, '1.1.0');
    const pins = await execution.referencedRoots();
    const oldRoot = JSON.parse(await readFile(join(state, 'deployment.json'), 'utf8')).current.releaseRoot;
    const candidateRoot = pins.find(root => root !== oldRoot);
    assert.ok(candidateRoot); await readFile(join(candidateRoot, 'execution/daemon.cjs'));
    // The uncertain pin survives controller recreation, not only in-memory cleanup.
    const recreated = createExecutionDeployment({ link, unit: 'execution.service', coreUnit: 'core.service', coreEndpoint: endpoint, tokenPath,
      healthUrl: `http://127.0.0.1:${gateway.address().port}/health`, validate: async () => {}, prepareAccess: async () => {} });
    assert.ok((await recreated.referencedRoots()).includes(candidateRoot));
    failRollbackRestart = false;
    await app.close(); app = null; cookie = ''; await open();
    assert.equal(gatewayIdentity.version, '1.0.0'); assert.equal((await status()).execution.ready, true);
    // A process can die after changing execution-current but before committing deployment.json.
    await app.close(); app = null;
    const wrong = join(state, 'wrong'); await symlink(fixture.releases.get('1.1.0').packageRoot, wrong); await rename(wrong, link);
    cookie = ''; await open(); assert.equal(gatewayIdentity.version, '1.0.0');
    assert.equal(await readlink(link), JSON.parse(await readFile(join(state, 'deployment.json'), 'utf8')).current.releaseRoot);
    // Incompatible/native payload is rejected before stopping any service.
    const incompatible = fixture.releases.get('1.1.0').packageRoot;
    const manifest = JSON.parse(await readFile(join(incompatible, 'package.json'), 'utf8'));
    manifest.opencraftExecution.arch = 'wrong'; await writeFile(join(incompatible, 'package.json'), JSON.stringify(manifest));
    await assert.rejects(execution.inspect({ releaseRoot: incompatible }), /compatible execution/);
  } finally {
    await app?.close(); await fixture?.close();
    core.closeAllConnections(); gateway.closeAllConnections();
    await Promise.all([new Promise(done => core.close(done)), new Promise(done => gateway.close(done))]);
    await rm(root, { recursive: true, force: true });
  }
});

test('service topology permits Wants/After but rejects core stop propagation and shared cgroups', async () => {
  const { assertIndependentUnits } = await import('../scripts/server-deployment/execution.mjs');
  const execution = { Id: 'execution.service', ControlGroup: '/system.slice/execution.service', KillMode: 'control-group', ExecStart: '/usr/bin/node /srv/current/execution/gateway.mjs' };
  const core = { Id: 'core.service', ControlGroup: '/system.slice/core.service', StopWhenUnneeded: 'no', MainPID: '123' };
  const validate = (e, c) => assertIndependentUnits('execution.service', 'core.service', '/srv/current', async unit => unit === 'execution.service' ? e : c);
  await validate(execution, core);
  await validate({ ...execution, ControlGroup: '' }, core); // First installation starts an inactive unit after creating its release pointer.
  for (const broken of [{ ...core, PartOf: 'execution.service' }, { ...core, BindsTo: 'other.service' }, { ...core, StopWhenUnneeded: 'yes' }, { ...core, ControlGroup: execution.ControlGroup }])
    await assert.rejects(validate(execution, broken), /independent Codex core/);
  await assert.rejects(validate({ ...execution, Conflicts: 'core.service' }, core), /independent Codex core/);
  await assert.rejects(validate(execution, { ...core, Conflicts: 'execution.service' }), /independent Codex core/);
  await assert.rejects(validate({ ...execution, PropagatesStopTo: 'other.service' }, core), /independent Codex core/);
  await assert.rejects(validate({ ...execution, KillMode: 'process' }, core), /independent Codex core/);
  await assert.rejects(assertIndependentUnits('execution.service', 'core.service', '/srv/current', async unit => unit === 'execution.service' ? execution : core, { pid: 999 }), /independent Codex core/);
});

test('fresh private release becomes readable to a separate execution user without exposing the admin key', { skip: process.platform !== 'linux' || process.getuid?.() !== 0 }, async () => {
  const { execFileSync } = await import('node:child_process');
  const { chmod } = await import('node:fs/promises');
  const { grantExecutionAccess } = await import('../scripts/server-deployment/execution.mjs');
  const root = await mkdtemp(join('/var/tmp', 'opencraft-reader-'));
  try {
    await chmod(root, 0o755); // Site-provisioned ancestors, outside updater ownership.
    const state = join(root, 'state'); const release = join(state, 'releases/id/package');
    await mkdir(join(release, 'execution/native'), { recursive: true, mode: 0o700 });
    const gateway = join(release, 'execution/gateway.mjs'); await writeFile(gateway, 'code', { mode: 0o600 });
    const key = join(state, 'admin-key'); await writeFile(key, 'synthetic', { mode: 0o600 });
    assert.throws(() => execFileSync('runuser', ['-u', 'nobody', '--', 'test', '-r', gateway]));
    await grantExecutionAccess(release, 'nobody', state);
    execFileSync('runuser', ['-u', 'nobody', '--', 'test', '-r', gateway]);
    assert.throws(() => execFileSync('runuser', ['-u', 'nobody', '--', 'test', '-r', key]));
  } finally { await rm(root, { recursive: true, force: true }); }
});
