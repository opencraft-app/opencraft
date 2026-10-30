import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readlink, cp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createExecutionDeployment } from '../../scripts/server-deployment/execution.mjs';
import { linuxProcessIdentity } from '../../scripts/server-deployment/runtime-equivalence.mjs';

test('recovery observes actual payload and process, shares health budget, and never restarts to pass', async t => {
  const root = await mkdtemp(join(tmpdir(), 'execution-verify-only-'));
  const releaseRoot = join(root, 'retained'), link = join(root, 'current'), endpoint = join(root, 'core.sock'), tokenPath = join(root, 'token');
  let gateway, core, restarts = 0, runtime, healthy = true, wait = 0, reads = 0, changed = false;
  t.after(async () => { for (const s of [gateway, core]) if (s) { s.closeAllConnections(); await new Promise(done => s.close(done)); } await rm(root, { recursive: true, force: true }); });
  await mkdir(join(releaseRoot, 'execution/native'), { recursive: true });
  await cp(new URL('../../node_modules/node-pty', import.meta.url), join(releaseRoot, 'execution/native/node-pty'), { recursive: true });
  for (const file of ['gateway.mjs', 'daemon.cjs', 'dsh-capability-plugin.mjs', 'dsh-thread-persistence-plugin.mjs', 'dsh-thread-projection-plugin.mjs']) await writeFile(join(releaseRoot, 'execution', file), '// fixture');
  await writeFile(join(releaseRoot, 'package.json'), JSON.stringify({ version: '1.0.0', opencraftWeb: { buildId: 'b1' }, opencraftExecution: {
    protocolVersion: 1, profile: 'headless', platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules } }));
  await symlink(releaseRoot, link); await writeFile(tokenPath, 'synthetic-token');
  const identity = { protocolVersion: 1, pid: 11, codexPid: 12 };
  core = createServer((_q, r) => r.end(JSON.stringify(identity))); await new Promise(done => core.listen(endpoint, done));
  runtime = releaseRoot;
  gateway = createServer(async (_q, r) => { if (wait) await new Promise(done => setTimeout(done, wait)); r.end(JSON.stringify({ ok: healthy, profile: 'headless', version: '1.0.0', buildId: 'b1', core: identity, runtimeReleaseRoot: runtime })); });
  await new Promise(done => gateway.listen(0, '127.0.0.1', done));
  const originalProcess = await linuxProcessIdentity(process.pid);
  const execution = createExecutionDeployment({ link, unit: 'execution.service', coreUnit: 'core.service', coreEndpoint: endpoint, tokenPath,
    profile: 'headless', healthUrl: `http://127.0.0.1:${gateway.address().port}/health`, timeout: 180, statusTimeoutMs: 2500,
    runtimeProcess: async () => ({ ...originalProcess, startTicks: changed && ++reads > 1 ? String(Number(originalProcess.startTicks) + 1) : originalProcess.startTicks }),
    validate: async () => {}, prepareAccess: async () => {}, restart: async () => { restarts++; } });
  const release = { releaseRoot, version: '1.0.0', buildId: 'b1' };
  wait = 1700; assert.equal((await execution.verifyRecovery(release)).core.pid, 11); wait = 0;
  healthy = false; await assert.rejects(execution.verifyRecovery(release), e => e.reason === 'dependency-unavailable'); healthy = true;
  runtime = undefined; await assert.rejects(execution.verifyRecovery(release), e => e.reason === 'runtime-payload-mismatch'); runtime = releaseRoot;
  changed = true; reads = 0; await assert.rejects(execution.verifyRecovery(release), /changed during verification/);
  assert.equal(await readlink(link), releaseRoot); assert.equal(restarts, 0);
});
