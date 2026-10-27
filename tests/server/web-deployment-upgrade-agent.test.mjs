import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, open, stat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { Journal, advance, receiptProjection } from '../../scripts/full-upgrade/journal.mjs';
import { acquireLock, atomicJson, readPrivateJson, sha256 } from '../../scripts/full-upgrade/durable.mjs';
import { startWatchdog } from '../../scripts/full-upgrade/watchdog.mjs';
import { startHelper } from '../../scripts/full-upgrade/helper.mjs';
import { request } from '../../scripts/full-upgrade/ipc.mjs';
const hash = 'a'.repeat(64);
const plan = (operationId = 'op1') => ({ operationId, planDigest: hash, manifestSha256: hash, inventoryFingerprint: hash,
  bootId: 'boot-one', steps: [{ stepId: 'replace', ownerId: 'synthetic', action: 'replace', epoch: 9, fence: 'fence-nine' }] });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'upgrade-p2b-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = await new Journal(join(root, 'journal')).open();
  t.after(() => journal.close());
  return { root, journal, lock: join(root, 'deployment.lock') };
}
const receipt = outcome => ({ outcome, operationId: 'op1', epoch: 9, fence: 'fence-nine', identity: 'target', healthy: true });

test('kernel lock excludes CI and concurrent button, then releases on close', async t => {
  const { lock } = await fixture(t);
  const release = await acquireLock(lock);
  await assert.rejects(acquireLock(lock));
  await release();
  const next = await acquireLock(lock); await next();
});
test('journal is private, operation idempotency cannot retarget, receipt drops raw payload', async t => {
  const { journal } = await fixture(t);
  await journal.create(plan());
  assert.equal((await stat(journal.path('op1'))).mode & 0o777, 0o600);
  assert.equal((await journal.create(plan())).operationId, 'op1');
  await assert.rejects(journal.create({ ...plan(), manifestSha256: 'b'.repeat(64) }));
  assert.deepEqual(receiptProjection({ ...receipt('applied'), token: 'secret-fixture', command: 'no-command' }), receipt('applied'));
});
test('intent durability failure prevents any owner mutation and poisons writer', async t => {
  const { journal, lock } = await fixture(t); let count = 0;
  const job = await journal.create(plan());
  journal.persist = async () => { throw Object.assign(new Error('fault'), { code: 'ENOSPC' }); };
  await assert.rejects(advance(job, journal, { synthetic: { observe: async () => receipt('not-applied'), apply: async () => { count++; return receipt('applied'); } } }, async () => true, lock));
  assert.equal(count, 0); await assert.rejects(journal.load('op1'), /journal-unavailable/);
});
for (const code of ['EACCES', 'EIO', 'ENOSPC']) test(`atomic write ${code} leaves old durable state`, async t => {
  const { root } = await fixture(t), path = join(root, 'state.json');
  await atomicJson(path, { before: true });
  await assert.rejects(atomicJson(path, { after: true }, { rename: async () => { throw Object.assign(new Error('fault'), { code }); } }));
  assert.deepEqual(await readPrivateJson(path), { before: true });
});
test('directory fsync failure after rename is uncertain and never followed by mutation', async t => {
  const { journal, lock } = await fixture(t); let mutations = 0;
  const job = await journal.create(plan());
  journal.persist = (path, value) => atomicJson(path, value, { open: async (path, flags, mode) => {
    const file = await open(path, flags, mode);
    if (path === journal.directory) file.sync = async () => { throw Object.assign(new Error('power-cut-model'), { code: 'EIO' }); };
    return file;
  } });
  await assert.rejects(advance(job, journal, { synthetic: { observe: async () => receipt('not-applied'), apply: async () => { mutations++; } } }, async () => true, lock));
  assert.equal(mutations, 0); assert.ok((await readPrivateJson(journal.path('op1'))).steps[0].intent);
});
test('epoch or fence conflict prevents mutation', async t => {
  const { journal, lock } = await fixture(t); let mutations = 0;
  const job = await journal.create(plan());
  const result = await advance(job, journal, { synthetic: { observe: async () => ({ ...receipt('not-applied'), epoch: 10 }), apply: async () => { mutations++; } } }, async () => true, lock);
  assert.equal(result.state, 'recovery-required'); assert.equal(mutations, 0);
});
test('validation drift blocks before any side effect', async t => {
  const { journal, lock } = await fixture(t); let observations = 0;
  const result = await advance(await journal.create(plan()), journal, { synthetic: { observe: async () => { observations++; } } }, async () => false, lock);
  assert.equal(result.state, 'blocked'); assert.equal(observations, 0);
});
test('child success with lost parent receipt reconciles without resubmitting', async t => {
  const { journal, lock } = await fixture(t); let mutations = 0, ownerApplied = false, writes = 0;
  const job = await journal.create(plan()), persist = journal.persist;
  journal.persist = async (...args) => { if (++writes === 2) throw new Error('receipt-persistence-failure'); return persist(...args); };
  const owner = { observe: async () => receipt(ownerApplied ? 'applied' : 'not-applied'), apply: async () => { mutations++; ownerApplied = true; return { ...receipt('applied'), childJobId: 'official-job1' }; } };
  await assert.rejects(advance(job, journal, { synthetic: owner }, async () => true, lock));
  await journal.close();
  const recovered = await new Journal(journal.directory).open(); t.after(() => recovered.close());
  const result = await advance(await recovered.load('op1'), recovered, { synthetic: owner }, async () => true, lock);
  assert.equal(result.state, 'completed'); assert.equal(mutations, 1);
});
test('unknown or not-applied after persisted intent is never blindly resubmitted', async t => {
  const { journal, lock } = await fixture(t); let mutations = 0;
  const job = await journal.create(plan()); job.steps[0].intent = { action: 'replace', stepId: 'replace', epoch: 9, fence: 'fence-nine' }; await journal.save(job);
  const result = await advance(job, journal, { synthetic: { observe: async () => receipt('not-applied'), apply: async () => { mutations++; } } }, async () => true, lock);
  assert.equal(result.state, 'recovery-required'); assert.equal(mutations, 0);
});
test('active draining releases write lease and retains intent for later authoritative observation', async t => {
  const { journal, lock } = await fixture(t); let applies = 0, drained = false;
  const owner = { observe: async () => receipt(drained ? 'applied' : 'not-applied'), apply: async () => { applies++; return receipt('draining'); } };
  const job = await advance(await journal.create(plan()), journal, { synthetic: owner }, async () => true, lock);
  assert.equal(job.state, 'active-draining'); const release = await acquireLock(lock); await release();
  drained = true;
  assert.equal((await advance(job, journal, { synthetic: owner }, async () => true, lock)).state, 'completed'); assert.equal(applies, 1);
});
test('SIGKILL after child success releases kernel lock; fresh process reconciles durable intent', async t => {
  const { root, journal, lock } = await fixture(t); await journal.close();
  const journalModule = new URL('../../scripts/full-upgrade/journal.mjs', import.meta.url).href;
  const durableModule = new URL('../../scripts/full-upgrade/durable.mjs', import.meta.url).href;
  const childState = join(root, 'child.json');
  const script = `import { Journal, advance } from ${JSON.stringify(journalModule)}; import { atomicJson } from ${JSON.stringify(durableModule)};
    const j = await new Journal(${JSON.stringify(journal.directory)}).open(); const job = await j.create(${JSON.stringify(plan())});
    await advance(job, j, { synthetic: { observe: async () => (${JSON.stringify(receipt('not-applied'))}), apply: async () => {
      await atomicJson(${JSON.stringify(childState)}, ${JSON.stringify(receipt('applied'))}); process.kill(process.pid, 'SIGKILL');
    } } }, async () => true, ${JSON.stringify(lock)});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
  const ended = await new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  assert.equal(ended.signal, 'SIGKILL');
  const recovered = await new Journal(journal.directory).open(); t.after(() => recovered.close());
  const result = await advance(await recovered.load('op1'), recovered, { synthetic: { observe: () => readPrivateJson(childState), apply: () => assert.fail('duplicate child') } }, async () => true, lock);
  assert.equal(result.state, 'completed');
});

async function supervisor(t, nextReady = true) {
  const { root } = await fixture(t), config = { controlStateRoot: join(root, 'control'), runtimeRoot: join(root, 'run'), deployLock: join(root, 'host.lock') };
  await mkdir(config.controlStateRoot, { mode: 0o700 }); await mkdir(config.runtimeRoot + '-watchdog');
  const old = 'a'.repeat(64), next = 'b'.repeat(64), current = { helper: old, agent: old }, running = { ...current }, events = [];
  const service = await startWatchdog(config, new URL('../../scripts/full-upgrade/watchdog.mjs', import.meta.url).pathname, {
    artifact: async (id, role) => ({ path: role, proof: { [role + 'Sha256']: id, manifestSha256: hash } }),
    probe: async () => ({ protocol: 1, accepts: [1] }), pointer: async role => current[role],
    switch: async (role, id) => { current[role] = id; events.push(['switch', role, id]); },
    restart: async role => { running[role] = current[role]; events.push(['restart', role]); },
    ready: async (role, id) => running[role] === id && (id !== next || nextReady),
    wait: async (role, id) => running[role] === id && (id !== next || nextReady),
  });
  t.after(async () => { await new Promise(resolve => service.server.close(resolve)); await service.journal.close(); });
  return { service, config, old, next, current, running, events };
}
test('independent watchdog completes helper self-upgrade with durable old/new identities', async t => {
  const f = await supervisor(t);
  const job = await request(join(f.config.runtimeRoot + '-watchdog', 'control.sock'), { action: 'handoff', operationId: 'upgrade-helper1', role: 'helper', artifactId: f.next });
  assert.equal(job.state, 'completed'); assert.equal(job.oldArtifactId, f.old); assert.equal(job.newArtifactId, f.next);
  assert.ok(job.steps[0].intent); assert.equal(job.steps[0].receipt.identity, f.next);
});
test('helper readiness failure is rolled back by independent watchdog', async t => {
  const f = await supervisor(t, false);
  const job = await request(join(f.config.runtimeRoot + '-watchdog', 'control.sock'), { action: 'handoff', operationId: 'upgrade-helper2', role: 'helper', artifactId: f.next });
  assert.equal(job.state, 'recovery-required'); assert.equal(f.current.helper, f.old); assert.equal(job.rollbackReceipt.healthy, true);
});
test('watchdog restart reconciles candidate success without another systemctl restart', async t => {
  const f = await supervisor(t); const job = await f.service.journal.create({ ...plan('interrupted'), steps: [{ stepId: 'handoff', ownerId: 'helper', action: 'handoff', epoch: 0, fence: 'interrupted' }] });
  Object.assign(job, { oldArtifactId: f.old, newArtifactId: f.next, state: 'switching' }); job.steps[0].intent = { action: 'handoff' };
  await f.service.journal.save(job); f.current.helper = f.next; f.running.helper = f.next;
  const recovered = await f.service.recover(await f.service.journal.load('interrupted'));
  assert.equal(recovered.state, 'completed'); assert.deepEqual(f.events, []);
});
test('helper rejects arbitrary units, commands, paths and environment', async t => {
  const { root } = await fixture(t), config = { controlStateRoot: join(root, 'control'), runtimeRoot: join(root, 'run'), mode: 'local' };
  await mkdir(config.controlStateRoot, { mode: 0o700 }); await mkdir(config.runtimeRoot + '-helper');
  const helper = await startHelper(config, new URL('../../scripts/full-upgrade/helper.mjs', import.meta.url).pathname);
  t.after(async () => { await new Promise(resolve => helper.server.close(resolve)); await helper.journal.close(); });
  const path = join(config.runtimeRoot + '-helper', 'control.sock');
  for (const input of [{ action: 'restart', unit: 'other.service' }, { action: 'request-ci', operationId: 'x' }, { action: 'handoff', operationId: 'x', role: 'helper', artifactId: '../evil' }, { action: 'status', command: 'echo unsafe' }, { action: 'status', env: {} }]) await assert.rejects(request(path, input));
});

test('a different operation receipt cannot complete a persisted intent', async t => {
  const { journal, lock } = await fixture(t);
  const job = await journal.create(plan()); job.steps[0].intent = { action: 'replace', epoch: 9, fence: 'fence-nine' }; await journal.save(job);
  const result = await advance(job, journal, { synthetic: { observe: async () => ({ ...receipt('applied'), operationId: 'someone-else' }), apply: () => assert.fail('must not apply') } }, async () => true, lock);
  assert.equal(result.state, 'recovery-required');
});
test('CI wakeup acknowledgement lost on disk is not replayed after helper restart', async t => {
  const { root } = await fixture(t), config = { controlStateRoot: join(root, 'control'), runtimeRoot: join(root, 'run'), mode: 'ci',
    ciObserve: [process.execPath, '-e', 'console.log(JSON.stringify({admission:{status: "current"},manualPending:false}))'],
    ciRequest: [process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(join(root, 'ci-wakeup'))}, ${JSON.stringify('request\n')})`] };
  await mkdir(config.controlStateRoot, { mode: 0o700 }); await mkdir(config.runtimeRoot + '-helper');
  const entry = new URL('../../scripts/full-upgrade/helper.mjs', import.meta.url).pathname;
  let helper = await startHelper(config, entry), writes = 0;
  const persist = helper.journal.persist;
  helper.journal.persist = async (...args) => { if (++writes === 3) throw Object.assign(new Error('receipt-full'), { code: 'ENOSPC' }); return persist(...args); };
  const socket = join(config.runtimeRoot + '-helper', 'control.sock');
  await assert.rejects(request(socket, { action: 'request-ci', operationId: 'ci-button' }));
  await new Promise(resolve => helper.server.close(resolve)); await helper.journal.close();
  helper = await startHelper(config, entry);
  t.after(async () => { await new Promise(resolve => helper.server.close(resolve)); await helper.journal.close(); });
  const job = await request(socket, { action: 'request-ci', operationId: 'ci-button' });
  assert.equal(job.state, 'recovery-required'); assert.match(job.steps[0].receipt.evidenceId, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(join(root, 'ci-wakeup'), 'utf8'), 'request\n');
});

test('CI lock contention leaves an unstarted handoff resumable after release', async t => {
  const f = await supervisor(t), release = await acquireLock(f.config.deployLock);
  const input = { action: 'handoff', operationId: 'ci-busy-helper', role: 'helper', artifactId: f.next };
  await assert.rejects(request(join(f.config.runtimeRoot + '-watchdog', 'control.sock'), input));
  const queued = await f.service.journal.load(input.operationId);
  assert.equal(queued.state, 'queued'); assert.equal(queued.steps[0].intent, null); assert.deepEqual(f.events, []);
  await release();
  const job = await f.service.recover(queued);
  assert.equal(job.state, 'completed'); assert.equal(f.current.helper, f.next);
});
test('a cached supervisor configuration reloads the stable trust and revocation files', async t => {
  const { readAuthority } = await import('../../scripts/full-upgrade/service-config.mjs');
  const { root } = await fixture(t), config = { trustFile: join(root, 'trust.json'), webState: root };
  await atomicJson(config.trustFile, { keys: { old: 'old-public-key' } });
  await atomicJson(join(root, 'full-release-state.json'), { revocationSequence: 1 });
  assert.ok((await readAuthority(config, async () => {})).trust.keys.old);
  await atomicJson(config.trustFile, { keys: { next: 'next-public-key' }, revokedKeyIds: ['old'] });
  await atomicJson(join(root, 'full-release-state.json'), { revocationSequence: 2, revokedKeyIds: ['old'] });
  const current = await readAuthority(config, async () => {});
  assert.ok(current.trust.keys.next); assert.equal(current.trust.keys.old, undefined);
  assert.deepEqual(current.trust.revokedKeyIds, ['old']); assert.equal(current.state.revocationSequence, 2);
});
test('shared artifact permissions are explicit under a restrictive umask', async t => {
  const { root } = await fixture(t), module = new URL('../../scripts/full-upgrade/durable.mjs', import.meta.url).href;
  const script = `import {atomicBytes,atomicJson} from ${JSON.stringify(module)};import {stat} from 'node:fs/promises';
    process.umask(0o077);await atomicBytes(${JSON.stringify(join(root, 'profile'))}, 'public', 0o640);
    await atomicJson(${JSON.stringify(join(root, 'private'))}, {});
    if(((await stat(${JSON.stringify(join(root, 'profile'))})).mode&0o777)!==0o640)throw new Error('profile unreadable');
    if(((await stat(${JSON.stringify(join(root, 'private'))})).mode&0o777)!==0o600)throw new Error('journal exposed');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
  assert.equal(await new Promise(resolve => child.once('exit', resolve)), 0);
});
test('local provisioning reads official current only after obtaining the host lock', { skip: process.getuid?.() !== 0 }, async t => {
  const { install } = await import('../../scripts/full-upgrade/install.mjs');
  const { homedir } = await import('node:os');
  const root = await mkdtemp(join(homedir(), '.opencraft-provision-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const n of ['selected', 'moved', 'web']) await mkdir(join(root, n), { mode: 0o755 });
  const { copyFile, chown } = await import('node:fs/promises'); await copyFile(process.execPath, join(root, 'node')); await chown(join(root, 'node'), 0, 0);
  await writeFile(join(root, 'trust.json'), '{}', { mode: 0o600 }); await writeFile(join(root, 'profile.json'), '{}', { mode: 0o600 });
  await writeFile(join(root, 'web/deployment.json'), '{invalid-before-lock');
  const options = { releaseRoot: join(root, 'selected'), webState: join(root, 'web'), trustFile: join(root, 'trust.json'),
    profilePath: join(root, 'profile.json'), deployLock: join(root, 'host.lock'), node: join(root, 'node'), user: 'root', mode: 'local' };
  const release = await acquireLock(options.deployLock);
  await assert.rejects(install(options), /command-failed/);
  // The authoritative pointer can move while this candidate has no lease.
  await atomicJson(join(root, 'web/deployment.json'), { current: { releaseRoot: join(root, 'moved') } });
  await release();
  await assert.rejects(install(options), /only-official-current-can-provision/);
});
