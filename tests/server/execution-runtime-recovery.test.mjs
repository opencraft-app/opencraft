import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readlink, cp, rm, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutionDeployment } from '../../scripts/server-deployment/execution.mjs';
import { linuxProcessIdentity } from '../../scripts/server-deployment/runtime-equivalence.mjs';

test('interrupted rollback reconciles the actual runtime, while equivalent web releases retain their process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-runtime-recovery-'));
  const link = join(root, 'current'), tokenPath = join(root, 'token'), endpoint = join(root, 'core.sock');
  const identity = { protocolVersion: 1, pid: 11, codexPid: 12 };
  const core = createServer((_req, res) => res.end(JSON.stringify(identity)));
  let gateway, runningRoot, restarts = 0, failRestart = false, reportRuntime = true, healthDelay = 0, healthOk = true;
  try {
    await writeFile(tokenPath, 'synthetic-recovery-token');
    await new Promise(resolve => core.listen(endpoint, resolve));
    const releases = [];
    for (let i = 0; i < 3; i++) {
      const releaseRoot = join(root, 'release-' + i); releases.push(releaseRoot);
      await mkdir(join(releaseRoot, 'execution/native'), { recursive: true });
      await cp(new URL('../../node_modules/node-pty', import.meta.url), join(releaseRoot, 'execution/native/node-pty'), { recursive: true });
      for (const file of ['gateway.mjs', 'daemon.cjs', 'dsh-capability-plugin.mjs', 'dsh-thread-persistence-plugin.mjs', 'dsh-thread-projection-plugin.mjs'])
        await writeFile(join(releaseRoot, 'execution', file), '// identical backend');
      await mkdir(join(releaseRoot, 'runtime/browser'), { recursive: true });
      await writeFile(join(releaseRoot, 'runtime/browser/worker.cjs'), i === 1 ? '// different worker' : '// original worker');
      await writeFile(join(releaseRoot, 'package.json'), JSON.stringify({ version: '1.0.' + i, opencraftWeb: { buildId: 'web-' + i },
        opencraftExecution: { protocolVersion: 1, profile: 'headless', platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules } }));
    }
    gateway = createServer(async (_req, res) => {
      if (healthDelay) await new Promise(done => setTimeout(done, healthDelay));
      const selected = JSON.parse(await readFile(join(await readlink(link), 'package.json'), 'utf8'));
      res.end(JSON.stringify({ ok: healthOk, profile: 'headless', version: selected.version, buildId: selected.opencraftWeb.buildId,
        core: identity, ...(reportRuntime ? { runtimeReleaseRoot: runningRoot } : {}) }));
    });
    await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
    const execution = createExecutionDeployment({ link, unit: 'execution.service', coreUnit: 'core.service', coreEndpoint: endpoint, tokenPath,
      profile: 'headless', healthUrl: `http://127.0.0.1:${gateway.address().port}/health`, timeout: 150, statusTimeoutMs: 2500, runtimeProcess: () => linuxProcessIdentity(process.pid),
      validate: async () => {}, prepareAccess: async () => {}, restart: async () => {
        restarts++; if (failRestart) throw new Error('Synthetic restart failed'); runningRoot = await readlink(link);
      } });
    const release = i => ({ releaseRoot: releases[i], version: '1.0.' + i, buildId: 'web-' + i });
    await execution.apply(release(0)); await execution.apply(release(1));
    failRestart = true; await assert.rejects(execution.apply(release(0)), /Synthetic restart failed/);
    assert.equal(await readlink(link), releases[0]); assert.equal(runningRoot, releases[1]);
    const beforeRecovery = restarts;
    await assert.rejects(execution.verifyRecovery(release(0)), error => error.reason === 'runtime-payload-mismatch');
    assert.equal(restarts, beforeRecovery, 'verification cannot repair a mismatched process by restarting');
    const mismatch = await execution.status(); assert.equal(mismatch.ready, false); assert.equal(mismatch.observation.reason, 'release-mismatch');
    failRestart = false; await execution.apply(release(0));
    healthDelay = 1700;
    assert.equal((await execution.verifyRecovery(release(0))).core.pid, identity.pid, 'readiness shares the configured health request budget instead of a hardcoded 1500ms');
    healthDelay = 0; healthOk = false;
    await assert.rejects(execution.verifyRecovery(release(0)), error => error.reason === 'dependency-unavailable');
    healthOk = true;
    assert.equal(restarts, 4); assert.equal(runningRoot, releases[0]); assert.equal((await execution.status()).ready, true);
    await execution.apply(release(2)); assert.equal(restarts, 4, 'identical execution plus browser payload needs no restart');
    assert.equal(runningRoot, releases[0]); assert.equal((await execution.status()).ready, true);
    assert.deepEqual(await execution.referencedRoots(), [releases[0], releases[2]]);
    reportRuntime = false;
    await assert.rejects(execution.verifyRecovery(release(2)), error => error.code === 'EXECUTION_READINESS_FAILED' && error.reason === 'runtime-payload-mismatch' && error.attempts > 0);
    assert.equal((await execution.status()).ready, false, 'pointer-derived versions alone cannot prove execution');
    const currentManifest = JSON.parse(await readFile(join(releases[2], 'package.json'), 'utf8'));
    currentManifest.opencraftExecution.storageWriterProtocol = 2;
    await writeFile(join(releases[2], 'package.json'), JSON.stringify(currentManifest));
    await assert.rejects(execution.apply(release(0)), /kernel-owned Headless writer locks/);
    assert.equal(await readlink(link), releases[2], 'an incompatible rollback is rejected before changing the pointer');
    assert.equal(restarts, 4);
  } finally {
    for (const server of [gateway, core]) if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await rm(root, { recursive: true, force: true });
  }
});

test('entry restart reuses completed equivalence only for the same process and installed metadata', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-equivalence-reopen-'));
  const link = join(root, 'current'), tokenPath = join(root, 'token'), endpoint = join(root, 'core.sock');
  const identity = { protocolVersion: 1, pid: 11, codexPid: 12 };
  const core = createServer((_req, res) => res.end(JSON.stringify(identity)));
  let gateway, runningRoot, restarts = 0;
  let processIdentity = await linuxProcessIdentity(process.pid);
  assert.ok(processIdentity, 'this Linux deployment regression needs kernel process identity');
  const originalProcess = processIdentity;
  try {
    await writeFile(tokenPath, 'synthetic-equivalence-token');
    await new Promise(resolve => core.listen(endpoint, resolve));
    const releases = [];
    for (let i = 0; i < 2; i++) {
      const releaseRoot = join(root, 'release-' + i); releases.push(releaseRoot);
      await mkdir(join(releaseRoot, 'execution/native'), { recursive: true });
      await cp(new URL('../../node_modules/node-pty', import.meta.url), join(releaseRoot, 'execution/native/node-pty'), { recursive: true });
      for (const file of ['gateway.mjs', 'daemon.cjs', 'dsh-capability-plugin.mjs', 'dsh-thread-persistence-plugin.mjs', 'dsh-thread-projection-plugin.mjs'])
        await writeFile(join(releaseRoot, 'execution', file), '// identical backend');
      await mkdir(join(releaseRoot, 'runtime/browser'), { recursive: true });
      await writeFile(join(releaseRoot, 'runtime/browser/worker.cjs'), '// immutable worker');
      await mkdir(join(releaseRoot, 'web')); await mkdir(join(releaseRoot, 'release'));
      await writeFile(join(releaseRoot, 'web/version.json'), JSON.stringify({ buildId: 'web-' + i }));
      // This lower-level fixture fingerprints metadata bytes. Signature and
      // installation authentication remain covered by full-release tests.
      await writeFile(join(releaseRoot, 'release/full-release.json'), 'fixture-manifest-' + i);
      await writeFile(join(releaseRoot, 'release/full-release.sig'), 'fixture-signature-' + i);
      await writeFile(join(releaseRoot, 'package.json'), JSON.stringify({ version: '1.0.' + i, opencraftWeb: { buildId: 'web-' + i },
        opencraftExecution: { protocolVersion: 1, profile: 'headless', platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules } }));
    }
    gateway = createServer(async (_req, res) => {
      const selected = JSON.parse(await readFile(join(await readlink(link), 'package.json'), 'utf8'));
      res.end(JSON.stringify({ ok: true, profile: 'headless', version: selected.version, buildId: selected.opencraftWeb.buildId,
        core: identity, runtimeReleaseRoot: runningRoot }));
    });
    await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
    const options = { link, unit: 'execution.service', coreUnit: 'core.service', coreEndpoint: endpoint, tokenPath,
      profile: 'headless', healthUrl: `http://127.0.0.1:${gateway.address().port}/health`, timeout: 150,
      validate: async () => {}, prepareAccess: async () => {}, runtimeProcess: async () => processIdentity,
      restart: async () => { restarts++; runningRoot = await readlink(link); } };
    const release = i => ({ releaseRoot: releases[i], version: '1.0.' + i, buildId: 'web-' + i });
    const execution = createExecutionDeployment(options);
    await execution.apply(release(0)); await execution.apply(release(1));
    assert.equal(restarts, 1); assert.equal(runningRoot, releases[0]);
    const receiptPath = link + '.runtime-equivalence.json';
    const receipt = await readFile(receiptPath, 'utf8');
    assert.equal((await stat(receiptPath)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(receipt).process, originalProcess);

    // Only a fixture is removed. A fresh controller can reopen the completed
    // installation without reading browser payload bytes again.
    const browserFile = join(releases[0], 'runtime/browser/worker.cjs');
    await rm(browserFile);
    assert.equal((await createExecutionDeployment(options).status()).ready, true);
    const refused = async () => assert.equal((await createExecutionDeployment(options).status()).ready, false);
    processIdentity = { ...originalProcess, startTicks: String(BigInt(originalProcess.startTicks) + 1n) };
    await refused(); // PID reuse or a real successor cannot reuse the receipt.
    processIdentity = null; await refused(); processIdentity = originalProcess;
    await writeFile(receiptPath, '{'); await refused(); await writeFile(receiptPath, receipt);
    await chmod(receiptPath, 0o666); await refused(); await chmod(receiptPath, 0o600);
    const signature = join(releases[1], 'release/full-release.sig');
    await writeFile(signature, 'changed-envelope'); await refused();
    await writeFile(signature, 'fixture-signature-1');
    assert.equal((await createExecutionDeployment(options).status()).ready, true);
    const manifest = join(releases[1], 'release/full-release.json');
    await rm(manifest); await refused();
    await writeFile(manifest, 'fixture-manifest-1');
    assert.equal((await createExecutionDeployment({ ...options, unit: 'other.service' }).status()).ready, false);
    assert.equal((await createExecutionDeployment(options).status()).ready, true);

    await writeFile(browserFile, '// immutable worker');
    processIdentity = { ...originalProcess, startTicks: String(BigInt(originalProcess.startTicks) + 1n) };
    assert.equal((await createExecutionDeployment(options).status()).ready, true, 'a successor can pass a fresh full comparison');
    assert.deepEqual(JSON.parse(await readFile(receiptPath, 'utf8')).process, processIdentity);
    assert.equal(restarts, 1, 'observation never restarts the gateway');
  } finally {
    for (const server of [gateway, core]) if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await rm(root, { recursive: true, force: true });
  }
});
