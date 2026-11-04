import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { recoverLocalServer } from '../../scripts/recover-server-local.mjs';
import { targetRecoveryFixture as fixture } from '../support/target-recovery-fixture.mjs';
test('HTTP resumes the original owner once, retains failure, and refuses concurrent/duplicate activation', { skip: process.getuid?.() !== 0 }, async t => {
  const f = await fixture({ after() {} }, { parent: (await import('node:os')).homedir() });
  let app, agent, release = () => {};
  t.after(async () => { release(); await app?.close(); if (agent) { await new Promise(r => agent.server.close(r)); await agent.journal.close(); } await rm(f.root, { recursive: true, force: true }); });
  process.env.OPENCRAFT_FULL_RELEASE_TRUST_JSON = JSON.stringify(f.trust);
  const { createManagedWebServer } = await import('../../scripts/web-deployment/server.mjs');
  delete process.env.OPENCRAFT_FULL_RELEASE_TRUST_JSON;
  const { startAgent } = await import('../../scripts/full-upgrade/agent.mjs');
  const { webChildControl } = await import('../../scripts/full-upgrade/web-child.mjs');
  const cfg = { protocol: 1, mode: 'local', ...f.config, stateRoot: join(f.root, 'agent-state'), controlStateRoot: join(f.root, 'control'), runtimeRoot: join(f.root, 'rt'), artifactRoot: join(f.root, 'artifacts'), deployLock: join(f.root, 'shared.lock') };
  await mkdir(cfg.runtimeRoot + '-agent');
  const configPath = join(f.root, 'config.json'); await writeFile(configPath, JSON.stringify(cfg));
  agent = await startAgent(cfg, configPath);
  await webChildControl(cfg, { operationId: f.input.jobId }, agent.journal, 'boot');
  const { request } = await import('../../scripts/full-upgrade/ipc.mjs');
  const { socketPath } = await import('../../scripts/full-upgrade/service-config.mjs');
  const admission = () => request(socketPath(cfg, 'agent'), { action: 'web-resume-admission', operationId: f.input.jobId });
  assert.equal((await admission()).allowed, true);
  const originalJob = await agent.journal.load('web-' + f.input.jobId);
  for (const field of ['manifestSha256', 'targetBuildId', 'targetVersion', 'releaseId']) {
    await agent.journal.save({ ...originalJob, [field]: field === 'manifestSha256' ? 'a'.repeat(64) : 'wrong' });
    assert.equal((await admission()).allowed, false, field + ' must stay bound to original journal');
  }
  await agent.journal.save(originalJob);

  let enter;
  const entered = new Promise(r => enter = r), held = new Promise(r => release = r);
  let calls = 0, fail = true;
  const execution = { inspect: async () => {}, status: async () => ({ ready: true, version: '1.0.0', buildId: 'fixture1' }), apply: async (target, options) => {
    if (target.version === '2.0.0') assert.deepEqual(options, { recoverTarget: true });
    else assert.equal(options, undefined);
    if (target.version === '2.0.0') { calls++; enter(); await held; if (fail) throw new Error('synthetic target failed'); }
    else if (calls) throw new Error('strict old writer cannot read new database');
  } };
  const marker = join(f.root, 'maintenance'); await writeFile(marker, 'own-maintenance');
  app = await createManagedWebServer({ initialRelease: f.persisted.current.releaseRoot, stateDirectory: cfg.webState, execution, reconcileExecutionOnStartup: false, upgradeConfigPath: configPath, recoveryMarker: marker, source: { latest: async () => null } });
  const base = 'http://127.0.0.1:' + (await app.listen({ port: 0 })).port;
  let cookie = '';
  const post = (action, input, extra = {}) => fetch(base + '/__opencraft_updates/' + action, { method: 'POST', headers: { origin: base, cookie, 'content-type': 'application/json', ...extra }, body: JSON.stringify(input) });
  const wait = async predicate => { for (let i = 0; i < 200; i++) { const value = await (await fetch(base + '/__opencraft_updates')).json(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 10)); } assert.fail('owner timed out'); };
  assert.equal((await post('recover-target', f.input)).status, 401);
  cookie = (await post('login', { key: (await readFile(app.adminKeyPath, 'utf8')).trim() })).headers.get('set-cookie').split(';')[0];
  assert.equal((await post('recover-target', f.input, { origin: 'http://other.invalid' })).status, 403);
  assert.equal((await post('recover-target', f.input)).status, 409);
  const headers = { 'x-opencraft-recovery-id': 'own-maintenance' };
  assert.equal((await post('recover-target', {...f.input, readinessTimeoutMs: 1_800_000}, headers)).status, 409);
  assert.equal(calls, 0, 'HTTP cannot select or inject a readiness budget');
  const { acquireLock } = await import('../../scripts/full-upgrade/durable.mjs');
  const unlock = await acquireLock(cfg.deployLock);
  try {
    assert.equal((await post('recover-target', f.input, headers)).status, 202);
    await wait(s => s.job.phase === 'failed' && s.job.targetRecoveryError);
    assert.equal(calls, 0, 'a held shared lifecycle lock forbids execution activation');
  } finally { await unlock(); }

  assert.equal((await post('recover-target', f.input, headers)).status, 202);
  await entered;
  assert.equal((await post('recover-target', f.input, headers)).status, 409);
  assert.equal((await post('install-local', {}, headers)).status, 409);
  release();
  const failed = await wait(s => s.job.phase === 'failed' && s.job.targetRecoveryError);
  assert.equal(failed.current.version, '1.0.0'); assert.equal(failed.job.error, f.persisted.job.error);
  assert.equal((await agent.journal.load('web-' + f.input.jobId)).state, 'recovery-required');
  fail = false;
  const cli = recoverLocalServer({ url: base, stateDirectory: cfg.webState, ...f.input, targetManifestSha256: f.input.manifestSha256, recoveryId: 'own-maintenance' });
  const done = await wait(s => s.job.phase === 'completed');
  assert.equal((await cli).outcome, 'same-target-completed');
  assert.equal(done.current.version, '2.0.0'); assert.equal(calls, 2);
  const disk = JSON.parse(await readFile(join(cfg.webState, 'deployment.json'), 'utf8'));
  assert.equal(disk.job.failure.job.error, f.persisted.job.error);
  assert.equal((await agent.journal.load('web-' + f.input.jobId)).state, 'completed');
  assert.equal((await post('recover-target', f.input, headers)).status, 409); assert.equal(calls, 2);
});
