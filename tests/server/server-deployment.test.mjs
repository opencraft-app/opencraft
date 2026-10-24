import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readlink, writeFile, rm, symlink, rename, cp } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { once } from 'node:events';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createManagedWebServer } from "../../scripts/web-deployment/server.mjs";
import { computeExecutionHash, createExecutionDeployment, coreHealth } from "../../scripts/server-deployment/execution.mjs";
import { parseWebUpdateStatus } from "../../packages/web-update-protocol/src/index.mjs";
import { releaseFixture } from "../support/web-deployment-fixture.mjs";
import { packageWebServer } from "../../scripts/package-web-server.mjs";

async function until(read, condition) {
  for (let i = 0; i < 500; i++) { const value = await read(); if (condition(value)) return value; await delay(20); }
  throw new Error('Update did not finish');
}
test('independent DSH rejects legacy candidates and rollback baselines before changing a pointer or service', { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rollback-boundary-'));
  try {
    const webRoot = join(root, 'web'); await mkdir(webRoot);
    await writeFile(join(webRoot, 'index.html'), '<html><head></head><body>fixture</body></html>');
    await writeFile(join(webRoot, 'version.json'), JSON.stringify({ schemaVersion: 1, buildId: 'fixture', headlessServer: true, headlessHostId: 'opencraft-server' }));
    const packed = await packageWebServer({ version: '1.0.0', webRoot, output: join(root, 'packed'), execution: true, executionProfile: 'headless' });
    // Query the required member instead of buffering the entire execution payload listing.
    const files = execFileSync('tar', ['-tzf', packed.archive, 'package/opencraft-dsh-host.service', 'package/opencraft-engine-host.service'], { encoding: 'utf8' }).split('\n');
    assert.ok(files.includes('package/opencraft-dsh-host.service'), 'npm archive must carry the independent Host unit');
    assert.ok(files.includes('package/opencraft-engine-host.service'), 'npm archive must carry the independent Pi owner unit');
    const users = ['web', 'execution', 'dsh-host', 'engine-host'].map(name => {
      const unit = execFileSync('tar', ['-xOf', packed.archive, `package/opencraft-${name}.service`], { encoding: 'utf8' });
      return /^User=(.+)$/m.exec(unit)?.[1] ?? 'root';
    });
    assert.deepEqual(users, ['opencraft', 'opencraft', 'opencraft', 'opencraft'], 'packaged services must share the descriptor owner');
    const legacyRoot = join(root, 'legacy'); await cp(packed.packageRoot, legacyRoot, { recursive: true });
    const manifestPath = join(legacyRoot, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    delete manifest.opencraftExecution.independentDshHost;
    await writeFile(manifestPath, JSON.stringify(manifest));
    assert.throws(() => execFileSync(process.execPath, [join(legacyRoot, 'execution/gateway.mjs')], {
      env: { PATH: process.env.PATH, OPENCRAFT_DSH_HOST_DESCRIPTOR: join(root, 'descriptor') }, stdio: 'pipe',
    }), error => error.stderr.toString().includes('independent DSH Host'), 'direct gateway startup must reject incompatible metadata before reading runtime state');
    const link = join(root, 'current'); await symlink(legacyRoot, link);
    let restarts = 0;
    const settings = { link, unit: 'execution.service', coreUnit: 'core.service', coreEndpoint: join(root, 'core.sock'), tokenPath: join(root, 'token'),
      healthUrl: 'http://127.0.0.1:1/health', profile: 'headless', validate: async () => {}, prepareAccess: async () => {}, restart: async () => { restarts++; } };
    const independent = createExecutionDeployment({ ...settings, dshDescriptor: join(root, 'descriptor'), dshUnit: 'dsh.service' });
    await assert.rejects(independent.inspect({ releaseRoot: legacyRoot }), /independent DSH Host/);
    await assert.rejects(independent.apply({ releaseRoot: legacyRoot }), /independent DSH Host/);
    await assert.rejects(independent.apply({ releaseRoot: packed.packageRoot }), /independent DSH Host/);
    assert.equal(await readlink(link), legacyRoot);
    assert.equal(restarts, 0);
    await assert.rejects(readFile(`${link}.pins.json`), { code: 'ENOENT' });
    // Embedded deployments can still inspect existing profile-v1 packages.
    await createExecutionDeployment(settings).inspect({ releaseRoot: legacyRoot });
    manifest.opencraftExecution.independentDshHost = 1;
    delete manifest.opencraftExecution.independentEngineHost;
    await writeFile(manifestPath, JSON.stringify(manifest));
    const piOwner = createExecutionDeployment({ ...settings, engineDescriptor: join(root, 'pi-descriptor'), engineUnit: 'pi.service' });
    await assert.rejects(piOwner.inspect({ releaseRoot: legacyRoot }), /independent execution Host/);
    await assert.rejects(piOwner.apply({ releaseRoot: packed.packageRoot }), /independent execution Host/);
    assert.equal(await readlink(link), legacyRoot);
    assert.equal(restarts, 0, 'an incompatible Pi rollback baseline cannot restart the gateway');
  } finally { await rm(root, { recursive: true, force: true }); }
});
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
    // This legacy scenario owns restart and rollback behavior. Make the installed
    // backend hash differ from every candidate so those paths remain exercised;
    // same-digest pointer switches have their own focused regression test.
    const initialRoot = resolve(state, await readlink(link));
    await writeFile(join(initialRoot, 'execution/daemon.cjs'),
      `${await readFile(join(initialRoot, 'execution/daemon.cjs'), 'utf8')}\n// synthetic backend boundary\n`);
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
    health.protocolVersion = 999; // Web/execution can advance while the independent Core protocol differs.
    const { updateLocalServer } = await import("../../scripts/update-server-local.mjs");
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
  const { assertIndependentUnits } = await import("../../scripts/server-deployment/execution.mjs");
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
  const { grantExecutionAccess } = await import("../../scripts/server-deployment/execution.mjs");
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


test('deployment observes Core identity independently of protocol compatibility', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oc-core-identity-'));
  let core;
  try {
    const token = join(root, 'token'); await writeFile(token, 'synthetic');
    const endpoint = join(root, 'control.sock');
    let value = { protocolVersion: 999, pid: 123, codexPid: 456 };
    core = createServer((req, res) => { assert.equal(req.headers.authorization, 'Bearer synthetic'); res.end(JSON.stringify(value)); });
    await new Promise(done => core.listen(endpoint, done));
    assert.deepEqual(await coreHealth(endpoint, token), value, 'future protocol does not veto gateway delivery');
    for (const invalid of [{ ...value, pid: 0 }, { ...value, protocolVersion: 'future' }]) {
      value = invalid; await assert.rejects(coreHealth(endpoint, token), /identity is unavailable/);
    }
  } finally { if (core) await new Promise(done => core.close(done)); await rm(root, { recursive: true, force: true }); }
});

test('execution health retains identity, budgets dependent checks and fences pointer changes', {timeout:20_000}, async()=>{
  const {observeExecutionHealth}=await import('../../scripts/server-deployment/headless-gateway-application.mjs');
  const root=await mkdtemp(join(tmpdir(),'execution-observation-'));let mode='slow',requests=0;
  const release=join(root,'release'),next=join(root,'next'),link=join(root,'current');
  await mkdir(release);await mkdir(next);
  for(const path of [release,next])await writeFile(join(path,'package.json'),JSON.stringify({version:path===release?'1':'2',opencraftWeb:{buildId:path===release?'one':'two'}}));
  await symlink(release,link);
  const server=createServer(async(_request,response)=>{
    requests++;
    if(mode==='slow')await delay(1100); // Reproduces the former 1s outer/5s inner budget mismatch.
    if(mode==='switch'){await rm(link);await symlink(next,link);}
    if(mode==='hang')await delay(200);
    if(mode==='invalid'){response.end('{');return;}
    const health=await observeExecutionHealth({version:'1',buildId:'one',core:async()=>{if(mode==='core-failed')throw Error('synthetic private path');return {pid:11,codexPid:12};},
      dsh:async()=>{if(mode==='dsh-failed')throw Error('synthetic private token');return {pid:21,enginePid:22};}});
    response.writeHead(health.ok?200:503);response.end(JSON.stringify(health));
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const settings={link,unit:'execution.service',coreUnit:'core.service',coreEndpoint:join(root,'core.sock'),tokenPath:join(root,'token'),
    profile:'headless',healthUrl:`http://127.0.0.1:${server.address().port}/health`};
  const execution=createExecutionDeployment(settings);
  try{
    const [a,b]=await Promise.all([execution.status(),execution.status()]);assert.deepEqual(a,b);assert.equal(requests,1);assert.equal(a.ready,true);assert.equal(a.observation.reason,'ready');
    for(const failure of ['core-failed','dsh-failed']){mode=failure;const s=await execution.status();assert.equal(s.ready,false);assert.equal(s.version,'1');assert.equal(s.buildId,'one');assert.equal(s.observation.reason,'dependency-unavailable');assert.doesNotMatch(JSON.stringify(s),/private/);}
    mode='invalid';assert.equal((await execution.status()).observation.reason,'health-invalid');
    mode='switch';assert.equal((await execution.status()).observation.reason,'release-mismatch');
    mode='hang';const impatient=createExecutionDeployment({...settings,statusTimeoutMs:30});assert.equal((await impatient.status()).observation.reason,'health-timeout');
    mode='normal';const current=await execution.status();assert.equal(current.ready,false);assert.equal(current.observation.reason,'release-mismatch','healthy old process cannot authorize a new pointer');
    let started=0,releaseDependency;const both=new Promise(resolve=>releaseDependency=resolve);
    const observing=observeExecutionHealth({version:'1',buildId:'one',core:async()=>{started++;await both;return{};},dsh:async()=>{started++;await both;return{};}});
    assert.equal(started,2,'dependency observations start concurrently');releaseDependency();assert.equal((await observing).ok,true);
  }finally{server.closeAllConnections();await new Promise(done=>server.close(done));await rm(root,{recursive:true,force:true});}
});

test('execution runtime hash ignores web metadata and changes with backend payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencraft-execution-hash-'));
  try {
    await mkdir(join(root, 'execution/nested'), { recursive: true });
    await mkdir(join(root, 'web'));
    const buildOne = '20261022040000-aaaaaaaaaaaa', buildTwo = '20261022050000-bbbbbbbbbbbb';
    const revisionOne = '1'.repeat(40), revisionTwo = '2'.repeat(40);
    await writeFile(join(root, 'execution/gateway.mjs'), `gateway-one build=${buildOne} revision=${revisionOne}`);
    await writeFile(join(root, 'execution/nested/daemon.cjs'), `daemon-one build=${buildOne} revision=${revisionOne}`);
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.0.0', opencraftWeb: { buildId: buildOne } }));
    await writeFile(join(root, 'web/version.json'), JSON.stringify({ buildId: buildOne, sourceRevision: revisionOne }));
    const first = await computeExecutionHash(root);
    assert.match(first, /^[a-f0-9]{64}$/);
    // A web-only rebuild rewrites the embedded release identity in every bundle.
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.1.0', opencraftWeb: { buildId: buildTwo } }));
    await writeFile(join(root, 'web/version.json'), JSON.stringify({ buildId: buildTwo, sourceRevision: revisionTwo }));
    await writeFile(join(root, 'execution/gateway.mjs'), `gateway-one build=${buildTwo} revision=${revisionTwo}`);
    await writeFile(join(root, 'execution/nested/daemon.cjs'), `daemon-one build=${buildTwo} revision=${revisionTwo}`);
    assert.equal(await computeExecutionHash(root), first, 'web-only manifests and embedded identities do not force a backend restart');
    await writeFile(join(root, 'execution/nested/daemon.cjs'), 'daemon-two');
    assert.notEqual(await computeExecutionHash(root), first, 'backend payload changes alter the digest');
    await rm(join(root, 'execution'), { recursive: true, force: true });
    assert.equal(await computeExecutionHash(root), null, 'a legacy release without an execution payload cannot match');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('web-only execution updates switch the pointer without restarting an unchanged backend', { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencraft-execution-hash-apply-'));
  const core = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer synthetic-hash-token');
    response.end(JSON.stringify({ protocolVersion: 1, pid: 11, codexPid: 12 }));
  });
  let health;
  try {
    const webRoot = join(root, 'web'); await mkdir(webRoot);
    await writeFile(join(webRoot, 'index.html'), '<html><head></head><body>fixture</body></html>');
    await writeFile(join(webRoot, 'version.json'), JSON.stringify({ buildId: 'web-one' }));
    const packed = await packageWebServer({ version: '1.0.0', webRoot, output: join(root, 'packed'), execution: true });
    const firstRoot = packed.packageRoot;
    const secondRoot = join(root, 'release-two'); await cp(firstRoot, secondRoot, { recursive: true });
    const thirdRoot = join(root, 'release-three'); await cp(firstRoot, thirdRoot, { recursive: true });
    for (const [target, version, buildId] of [[secondRoot, '1.1.0', 'web-two'], [thirdRoot, '1.2.0', 'web-three']]) {
      const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
      manifest.version = version; manifest.opencraftWeb = { ...manifest.opencraftWeb, buildId };
      await writeFile(join(target, 'package.json'), JSON.stringify(manifest));
      // Simulate the web build embedding its new identity into the gateway bundle.
      const gateway = join(target, 'execution/gateway.mjs');
      await writeFile(gateway, (await readFile(gateway, 'utf8')).replaceAll('web-one', buildId));
    }
    const changedGateway = join(thirdRoot, 'execution/gateway.mjs');
    await writeFile(changedGateway, `${await readFile(changedGateway, 'utf8')}\n// synthetic backend change\n`);
    assert.notEqual(await computeExecutionHash(thirdRoot), await computeExecutionHash(firstRoot));

    const state = join(root, 'state'); await mkdir(state);
    const link = join(state, 'execution-current');
    const tokenPath = join(root, 'token'); await writeFile(tokenPath, 'synthetic-hash-token');
    const endpoint = join(root, 'core.sock'); await new Promise(done => core.listen(endpoint, done));
    let runningRoot, reportRuntimeRoot = false;
    health = createServer(async (_request, response) => {
      const manifest = JSON.parse(await readFile(join(await readlink(link), 'package.json'), 'utf8'));
      response.end(JSON.stringify({ ok: true, version: manifest.version, buildId: manifest.opencraftWeb.buildId,
        core: { pid: 11, codexPid: 12 }, ...(reportRuntimeRoot ? { runtimeReleaseRoot: runningRoot } : {}) }));
    });
    await new Promise(done => health.listen(0, '127.0.0.1', done));
    let restarts = 0;
    const execution = createExecutionDeployment({ link, unit: 'execution.service', coreUnit: 'core.service', coreEndpoint: endpoint, tokenPath,
      healthUrl: `http://127.0.0.1:${health.address().port}/health`, timeout: 500,
      validate: async () => {}, prepareAccess: async () => {}, restart: async () => { restarts += 1; runningRoot = await readlink(link); } });

    await execution.apply({ releaseRoot: firstRoot, version: '1.0.0', buildId: 'web-one' });
    assert.equal(restarts, 1, 'first deployment still starts the backend');
    assert.equal(await readlink(link), firstRoot);

    await execution.apply({ releaseRoot: secondRoot, version: '1.1.0', buildId: 'web-two' });
    assert.equal(restarts, 1, 'identical backend payload does not restart the gateway');
    assert.equal(await readlink(link), secondRoot, 'the web pointer still advances');
    assert.ok((await execution.referencedRoots()).includes(firstRoot), 'unchanged process retains its startup files even when health has no runtime identity');
    await execution.apply({ releaseRoot: secondRoot, version: '1.1.0', buildId: 'web-two' });
    assert.ok((await execution.referencedRoots()).includes(firstRoot), 'same-pointer reconciliation cannot drop a still-running runtime');

    await execution.apply({ releaseRoot: thirdRoot, version: '1.2.0', buildId: 'web-three' });
    assert.equal(restarts, 2, 'a changed backend payload restarts the gateway');
    assert.deepEqual(await execution.referencedRoots(), [thirdRoot], 'successful restart ends the old process file lifetime');

    await execution.apply({ releaseRoot: secondRoot, version: '1.1.0', buildId: 'web-two' });
    assert.equal(restarts, 3, 'cross-runtime rollback restarts as well');

    reportRuntimeRoot = true;
    await execution.apply({ releaseRoot: firstRoot, version: '1.0.0', buildId: 'web-one' });
    assert.equal(restarts, 3);
    assert.deepEqual(await execution.referencedRoots(), [secondRoot, firstRoot], 'health identifies the actual running root independently of the selected pointer');
    await execution.apply({ releaseRoot: firstRoot, version: '1.0.0', buildId: 'web-one' });
    assert.deepEqual(await execution.referencedRoots(), [secondRoot, firstRoot], 'repeat reconciliation keeps the runtime root');
    const retained = await execution.referencedRoots();
    for (const candidate of [firstRoot, secondRoot, thirdRoot]) {
      if (!retained.includes(candidate)) await rm(candidate, { recursive: true, force: true });
    }
    assert.ok((await readFile(join(runningRoot, 'execution/gateway.mjs'))).length > 0, 'release cleanup leaves running gateway files readable');
  } finally {
    if (health) { health.closeAllConnections(); await new Promise(done => health.close(done)); }
    core.closeAllConnections(); await new Promise(done => core.close(done));
    await rm(root, { recursive: true, force: true });
  }
});

test('browser-only worker and native upgrades restart the gateway while web-only rebuilds reuse it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencraft-browser-payload-'));
  const link = join(root, 'current'), tokenPath = join(root, 'token'), endpoint = join(root, 'core.sock');
  const identity = { protocolVersion: 1, pid: 11, codexPid: 12 };
  const core = createServer((_request, response) => response.end(JSON.stringify(identity)));
  let gateway, runningRoot, restarts = 0;
  try {
    await writeFile(tokenPath, 'synthetic-browser-payload-token');
    await new Promise(done => core.listen(endpoint, done));
    const releases = [];
    for (let i = 0; i < 4; i++) {
      const releaseRoot = join(root, 'release-' + i); releases.push(releaseRoot);
      await mkdir(join(releaseRoot, 'execution/native'), { recursive: true });
      await cp(new URL('../../node_modules/node-pty', import.meta.url), join(releaseRoot, 'execution/native/node-pty'), { recursive: true });
      for (const file of ['gateway.mjs', 'daemon.cjs', 'dsh-capability-plugin.mjs', 'dsh-thread-persistence-plugin.mjs', 'dsh-thread-projection-plugin.mjs'])
        await writeFile(join(releaseRoot, 'execution', file), '// unchanged execution bundle');
      await mkdir(join(releaseRoot, 'runtime/browser/electron'), { recursive: true });
      await writeFile(join(releaseRoot, 'runtime/browser/worker.cjs'), i === 0 ? 'worker-before' : 'worker-after');
      await writeFile(join(releaseRoot, 'runtime/browser/electron/electron'), i < 2 ? 'native-before' : 'native-after');
      await writeFile(join(releaseRoot, 'package.json'), JSON.stringify({ version: '1.0.' + i, opencraftWeb: { buildId: 'browser-build-' + i },
        opencraftExecution: { protocolVersion: 1, platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules, profile: 'headless' } }));
    }
    gateway = createServer(async (_request, response) => {
      const manifest = JSON.parse(await readFile(join(await readlink(link), 'package.json'), 'utf8'));
      response.end(JSON.stringify({ ok: true, profile: 'headless', version: manifest.version, buildId: manifest.opencraftWeb.buildId,
        core: identity, runtimeReleaseRoot: runningRoot }));
    });
    await new Promise(done => gateway.listen(0, '127.0.0.1', done));
    const execution = createExecutionDeployment({ link, unit: 'execution.service', coreUnit: 'core.service', coreEndpoint: endpoint, tokenPath,
      profile: 'headless', healthUrl: `http://127.0.0.1:${gateway.address().port}/health`, validate: async () => {}, prepareAccess: async () => {},
      restart: async () => { restarts++; runningRoot = await readlink(link); } });
    for (let i = 0; i < releases.length; i++) {
      await execution.apply({ releaseRoot: releases[i], version: '1.0.' + i, buildId: 'browser-build-' + i });
      assert.equal(restarts, Math.min(i + 1, 3), 'worker and native changes activate; a web-only rebuild does not restart');
    }
    assert.equal(runningRoot, releases[2]);
    assert.deepEqual(await execution.referencedRoots(), [releases[2], releases[3]]);
  } finally {
    for (const server of [gateway, core]) if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    await rm(root, { recursive: true, force: true });
  }
});

test('headless execution identity follows the current release pointer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencraft-release-pointer-'));
  try {
    const { readCurrentReleaseManifest } = await import('../../scripts/server-deployment/headless-gateway-application.mjs');
    const first = join(root, 'release-one'), second = join(root, 'release-two');
    await mkdir(first); await mkdir(second);
    await writeFile(join(first, 'package.json'), JSON.stringify({ version: '1.0.0', opencraftWeb: { buildId: 'one' } }));
    await writeFile(join(second, 'package.json'), JSON.stringify({ version: '1.1.0', opencraftWeb: { buildId: 'two' } }));
    const link = join(root, 'execution-current'); await symlink(first, link);
    assert.deepEqual(await readCurrentReleaseManifest(first, join(link, 'execution/gateway.mjs')), { version: '1.0.0', opencraftWeb: { buildId: 'one' } });
    await rm(link); await symlink(second, link);
    assert.deepEqual(await readCurrentReleaseManifest(first, join(link, 'execution/gateway.mjs')), { version: '1.1.0', opencraftWeb: { buildId: 'two' } });
    assert.deepEqual(await readCurrentReleaseManifest(first, '/tmp/unrelated-runner.mjs'), { version: '1.0.0', opencraftWeb: { buildId: 'one' } });
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('daemon gateway health tracks IPC lifetime, shares recovery and fences shutdown', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'daemon-gateway-health-'));
  const state = join(root, 'state'), release = join(root, 'release');
  const token = 'synthetic-daemon-health-token-not-a-real-secret';
  const connections = new Set(), heldReady = [];
  let generation = 1, holdReady = false, hellos = 0, appMessages = 0, gateway;
  let releaseCore, coreEntered;
  const core = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (coreEntered) { const entered = coreEntered; coreEntered = null; entered(); await new Promise(done => { releaseCore = done; }); }
    response.end(JSON.stringify({ protocolVersion: 1, pid: process.pid, codexPid: process.pid, nativeSocket: join(state, 'native.sock') }));
  });
  const daemon = createNetServer(socket => {
    connections.add(socket); socket.on('close', () => connections.delete(socket));
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n');
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (message.type === 'daemon/hello') {
          assert.equal(message.authToken, token); hellos++;
          const ready = () => {
            if (!socket.destroyed) socket.write(JSON.stringify({ type: 'daemon/ready', protocolVersion: 1,
              buildId: 'opencraft-daemon-v2', pid: process.pid,
              storage: [{ name: 'synthetic-owner', status: 'up-to-date', appliedVersion: generation, movedAside: false }] }) + '\n');
          };
          if (holdReady && message.role === 'app-host') heldReady.push(ready); else ready();
        } else if (message.type === 'daemon/shutdown') {
          socket.end(JSON.stringify({ type: 'daemon/shutting-down' }) + '\n');
        } else appMessages++;
      }
    });
  });
  let output = '';
  try {
    await mkdir(join(release, 'execution'), { recursive: true }); await mkdir(state);
    await writeFile(join(state, 'daemon.token'), token, { mode: 0o600 });
    await writeFile(join(release, 'package.json'), JSON.stringify({ version: 'fixture', opencraftWeb: { buildId: 'fixture' } }));
    await build({ entryPoints: [resolve('scripts/server-deployment/gateway.mjs')], outfile: join(release, 'execution/gateway.mjs'),
      bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['node-pty'],
      banner: { js: "import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);" } });
    await new Promise(done => core.listen(join(state, 'core.sock'), done));
    await new Promise(done => daemon.listen(join(state, 'daemon.sock'), done));
    const reserved = createNetServer(); await new Promise(done => reserved.listen(0, '127.0.0.1', done));
    const port = reserved.address().port; await new Promise(done => reserved.close(done));
    gateway = spawn(process.execPath, [join(release, 'execution/gateway.mjs')], { env: {
      PATH: process.env.PATH, OPENCRAFT_EXECUTION_CWD: root, OPENCRAFT_EXECUTION_STATE: state,
      OPENCRAFT_CODEX_CORE_ENDPOINT: join(state, 'core.sock'), OPENCRAFT_DSH_EXECUTABLE: join(root, 'unused-dsh'), OPENCRAFT_GATEWAY_PORT: String(port),
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    gateway.stdout.on('data', chunk => { output += chunk; }); gateway.stderr.on('data', chunk => { output += chunk; });
    const read = async () => {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) });
      return { status: response.status, body: await response.json() };
    };
    await until(async () => { if (gateway.exitCode !== null) throw Error(output); try { return await read(); } catch { return null; } }, value => value?.status === 200);
    const initialHellos = hellos;
    assert.equal(initialHellos, 2, 'one control probe and one persistent readiness connection');
    for (const value of await Promise.all(Array.from({ length: 6 }, read))) assert.equal(value.status, 200);
    assert.equal(hellos, initialHellos, 'routine health does not allocate new IPC connections');
    // Loss while Core is awaited must invalidate that same observation.
    const entered = new Promise(done => { coreEntered = done; });
    const racingHealth = read(); await entered;
    holdReady = true; generation = 2; for (const socket of connections) socket.destroy();
    await until(async () => connections.size, count => count === 0); await delay(30); releaseCore();
    const lost = await racingHealth; assert.equal(lost.status, 503); assert.equal(lost.body.ok, false);
    for (const value of await Promise.all(Array.from({ length: 8 }, read))) assert.equal(value.status, 503);
    await until(async () => heldReady.length, count => count === 1);
    assert.equal(hellos, initialHellos + 2, 'concurrent failed probes share a single recovery operation');
    heldReady.shift()();
    const recovered = await until(read, value => value.status === 200);
    assert.equal(recovered.body.storage[0].appliedVersion, 2, 'recovery uses the new daemon storage summary');
    for (const value of await Promise.all(Array.from({ length: 6 }, read))) assert.equal(value.status, 200);
    assert.equal(hellos, initialHellos + 2);
    assert.equal(appMessages, 0, 'health does not initialize an execution engine');
    // A late successful readiness result cannot revive the gateway during shutdown.
    for (const socket of connections) socket.destroy(); await delay(30);
    assert.equal((await read()).status, 503);
    await until(async () => heldReady.length, count => count === 1);
    const exited = once(gateway, 'exit'); gateway.kill('SIGTERM'); await delay(30); heldReady.shift()();
    const [code] = await exited; assert.equal(code, 0, output);
    await until(async () => connections.size, count => count === 0);
  } finally {
    releaseCore?.();
    if (gateway && gateway.exitCode === null) { const exited = once(gateway, 'exit'); gateway.kill('SIGKILL'); await exited; }
    for (const socket of connections) socket.destroy();
    if (daemon.listening) await new Promise(done => daemon.close(done));
    core.closeAllConnections(); if (core.listening) await new Promise(done => core.close(done));
    await rm(root, { recursive: true, force: true });
  }
});

test('independent Pi owner contributes readiness without exposing dependency errors', async () => {
  const {observeExecutionHealth}=await import('../../scripts/server-deployment/headless-gateway-application.mjs');
  const options={version:'fixture',buildId:'fixture-build',core:async()=>({pid:11,codexPid:12}),dsh:async()=>({pid:21,enginePid:22})};
  const ready=await observeExecutionHealth({...options,engineHost:async()=>({pid:31})});
  assert.equal(ready.ok,true);assert.deepEqual(ready.engineHost,{pid:31});assert.equal(ready.dependencies.engineHost,'ready');
  const missing=await observeExecutionHealth({...options,engineHost:async()=>{throw new Error('private descriptor details');}});
  assert.equal(missing.ok,false);assert.deepEqual(missing.engineHost,{state:'unavailable'});
  assert.equal(missing.dependencies.engineHost,'unavailable');assert.doesNotMatch(JSON.stringify(missing),/private descriptor/);
});
