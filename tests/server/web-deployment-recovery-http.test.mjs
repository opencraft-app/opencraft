import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { signedInspectionFixture } from '../support/full-upgrade-fixture.mjs';
import { sha256 } from '../../scripts/full-release/contract.mjs';

test('recovery HTTP authenticates exact identity, respects maintenance and excludes concurrent updates', async t => {
  const root = await mkdtemp(join(tmpdir(), 'web-recovery-http-'));
  let app, releaseVerification = () => {};
  t.after(async () => { releaseVerification(); await app?.close(); await rm(root, { recursive: true, force: true }); });
  const config = { targetRoot: join(root, 'release'), webState: join(root, 'state'), trustFile: join(root, 'trust'), profilePath: join(root, 'profile') };
  await signedInspectionFixture(config);
  process.env.OPENCRAFT_FULL_RELEASE_TRUST_JSON = await readFile(config.trustFile, 'utf8');
  const { createManagedWebServer } = await import('../../scripts/web-deployment/server.mjs');
  delete process.env.OPENCRAFT_FULL_RELEASE_TRUST_JSON;
  await writeFile(join(config.targetRoot, 'LICENSE'), 'license'); await chmod(join(config.targetRoot, 'LICENSE'), 0o644);
  await chmod(join(config.targetRoot, 'release/upgrade-policy.json'), 0o644);
  await mkdir(join(config.targetRoot, 'web')); await mkdir(join(config.targetRoot, 'runtime'));
  await writeFile(join(config.targetRoot, 'package.json'), JSON.stringify({ name: '@opencraft-app/opencraft', version: '2.0.0', opencraftWeb: { schemaVersion: 1, workerProtocol: 1, buildId: 'fixture2' } }));
  // Lightweight synthetic worker; no real service, accounts or model requests.
  await writeFile(join(config.targetRoot, 'runtime/worker.mjs'), `import {createServer} from 'node:http'; const s=createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify(q.url==='/version.json'?{buildId:'fixture2'}:{ok:true}));});s.listen(0,'127.0.0.1',()=>process.send({protocol:1,version:'2.0.0',buildId:'fixture2',port:s.address().port}));`);
  await writeFile(join(config.targetRoot, 'web/version.json'), JSON.stringify({ buildId: 'fixture2' }));
  await writeFile(join(config.targetRoot, 'web/index.html'), '<meta content="fixture2">');
  const current = { releaseRoot: config.targetRoot, version: '2.0.0', buildId: 'fixture2', fullRelease: {
    manifestSha256: sha256(await readFile(join(config.targetRoot, 'release/full-release.json'))), releaseId: 'fixture-release', releaseSequence: 1, authorization: 'verified-installation' } };
  const id = '89eed8a6-6d26-49c8-a11c-3bf9d89a98e1';
  await mkdir(join(config.webState, 'upgrade-children'));
  await writeFile(join(config.webState, 'upgrade-children', id + '.json'), JSON.stringify({ schemaVersion: 1, id, version: '3.0.0', buildId: 'fixture3', phase: 'recovery-required' }));
  await writeFile(join(config.webState, 'deployment.json'), JSON.stringify({ schemaVersion: 1, current, previous: null, job: { id, version: '3.0.0', phase: 'failed', error: 'original failure' } }));
  let verificationStarted;
  const entered = new Promise(done => verificationStarted = done), held = new Promise(done => releaseVerification = done);
  const marker = join(root, 'maintenance'); await writeFile(marker, 'synthetic-controller');
  const execution = { apply: async () => {}, inspect: async () => {}, status: async () => ({ ready: true, version: '2.0.0', buildId: 'fixture2' }),
    verifyRecovery: async () => { verificationStarted(); await held; return { process: { pid: 11, bootId: 'boot', startTicks: '1' }, core: { pid: 12, codexPid: 13 } }; } };
  app = await createManagedWebServer({ initialRelease: config.targetRoot, stateDirectory: config.webState, execution,
    reconcileExecutionOnStartup: false, recoveryMarker: marker, source: { latest: async () => null } });
  const address = await app.listen({ port: 0 }); const base = `http://127.0.0.1:${address.port}`;
  let cookie = '';
  const post = (action, input, extra = {}) => fetch(base + '/__opencraft_updates/' + action, { method: 'POST', headers: { origin: base, cookie, 'content-type': 'application/json', ...extra }, body: JSON.stringify(input) });
  const input = { jobId: id, version: '2.0.0', buildId: 'fixture2' };
  assert.equal((await post('recover-current', input)).status, 401);
  cookie = (await post('login', { key: (await readFile(app.adminKeyPath, 'utf8')).trim() })).headers.get('set-cookie').split(';')[0];
  assert.equal((await post('recover-current', { ...input, buildId: 'other' })).status, 409);
  assert.equal((await post('recover-current', input, { origin: 'http://invalid.example' })).status, 403);
  assert.equal((await post('recover-current', input)).status, 409, 'maintenance controller must match');
  assert.equal((await post('recover-current', input, { 'x-opencraft-recovery-id': 'synthetic-controller' })).status, 202);
  await entered;
  assert.equal((await post('recover-current', input, { 'x-opencraft-recovery-id': 'synthetic-controller' })).status, 409);
  assert.equal((await post('check', {})).status, 409);
  releaseVerification();
  for (let n = 0; n < 100; n++) {
    const status = await (await fetch(base + '/__opencraft_updates')).json();
    if (status.job.phase === 'failed') {
      assert.equal(status.job.recoveryError, null); assert.equal(status.job.error, 'original failure');
      assert.equal(status.job.recovery.outcome, 'rolled-back'); return;
    }
    await new Promise(done => setTimeout(done, 10));
  }
  assert.fail('recovery did not finish');
});
