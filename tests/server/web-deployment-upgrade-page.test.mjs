import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Journal, advance } from '../../scripts/full-upgrade/journal.mjs';
import { pageControl, projectJob, projectPlan, reconcileWebChildren } from '../../scripts/full-upgrade/page.mjs';
import { webChildControl } from '../../scripts/full-upgrade/web-child.mjs';
import { acceptReleasePolicy } from '../../scripts/full-upgrade/release-policy.mjs';
import { sha256 } from '../../scripts/full-release/contract.mjs';
import { parseFullUpgradeStatus } from '../../packages/web-update-protocol/src/index.mjs';
const hash = 'a'.repeat(64);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'upgrade-page-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { stateRoot: root, webState: join(root, 'web'), targetRoot: join(root, 'target'), trustFile: join(root, 'missing-trust') };
  await mkdir(join(config.webState, 'upgrade-children'), { recursive: true });
  const journal = await new Journal(join(root, 'journal')).open(); t.after(() => journal.close());
  return { root, config, journal };
}
const create = (journal, id = 'op1') => journal.create({ operationId: id, planDigest: hash, manifestSha256: hash, inventoryFingerprint: hash,
  bootId: 'boot1', steps: [{ ownerId: 'owner', stepId: 'one', action: 'replace', epoch: 1, fence: 'fence1' }, { ownerId: 'other', stepId: 'two', action: 'replace', epoch: 1, fence: 'fence1' }] });
test('missing signature authority persists a blocked view; a fresh page restores it without raw inventory', async t => {
  const { config, journal } = await fixture(t);
  const result = await pageControl(config, { action: 'page-check' }, journal, 'boot1');
  assert.equal(result.plan.executable, false); assert.deepEqual(result.plan.blockedReasons, ['signed-plan-unavailable']);
  const fresh = await pageControl(config, { action: 'page-status' }, journal, 'boot1');
  assert.equal(parseFullUpgradeStatus(fresh).plan.status, 'blocked');
  assert.equal(JSON.stringify(fresh).includes(config.stateRoot), false);
  await assert.rejects(pageControl(config, { action: 'page-start', planDigest: hash }, journal, 'boot1'));
});
test('browser projections distinguish unknown running/installed/next-start; no target pointer masquerades as running', () => {
  const p = projectPlan({ planId: 'p', planDigest: hash, target: { releaseId: 'r', source: { revision: 'a'.repeat(40) }, channel: 'test', manifestSha256: hash }, blockedReasons: [],
    components: [{ componentId: 'one', role: 'core', target: { version: '2' }, status: 'blocked', interruption: 'drain', blockedReasons: [], current: [{ token: 'never-project', path: '/private' }] }] });
  assert.equal(p.components[0].runningVersion, null); assert.equal(p.components[0].installedVersion, null); assert.equal(p.components[0].nextStartVersion, null);
  assert.equal(JSON.stringify(p).includes('never-project'), false); assert.equal(p.downloadBytes, null);
});
test('signed policy must be an exact file-list member and bind the release sequence; empty is not executable', () => {
  const policy = { schemaVersion: 1, kind: 'opencraft.upgrade-policy', releaseId: 'r', releaseSequence: 4, compatibility: [], recipes: [] };
  const bytes = Buffer.from(JSON.stringify(policy));
  const manifest = { release: { releaseId: 'r', releaseSequence: 4 }, components: [{ fileList: [['release/upgrade-policy.json', sha256(bytes), bytes.length, '0644']] }] };
  assert.deepEqual(acceptReleasePolicy(manifest, bytes).recipes, []);
  assert.throws(() => acceptReleasePolicy(manifest, Buffer.from('{}')));
  assert.throws(() => acceptReleasePolicy({ ...manifest, release: { releaseId: 'r', releaseSequence: 5 } }, bytes));
});
test('cancel during an in-flight owner step waits for receipt then stops before the next owner', async t => {
  const { root, config, journal } = await fixture(t); const job = await create(journal);
  let second = 0;
  const receipt = outcome => ({ outcome, operationId: 'op1', epoch: 1, fence: 'fence1' });
  const result = await advance(job, journal, {
    owner: { observe: async () => receipt('not-applied'), apply: async () => {
      await pageControl(config, { action: 'page-stop', operationId: 'op1' }, journal, 'boot1');
      return receipt('applied');
    } }, other: { observe: async () => { second++; return receipt('not-applied'); } },
  }, async () => true, join(root, 'lock'));
  assert.equal(result.state, 'deferred'); assert.equal(second, 0); assert.equal(result.steps[0].receipt.outcome, 'applied');
  assert.equal((await journal.load('op1')).stopRequested, true);
});
test('Web child success with missing parent receipt reconciles exact child/target; repeat keeps original job', async t => {
  const { config, journal } = await fixture(t);
  const child = { schemaVersion: 1, id: 'child1', version: '2.0.0', buildId: 'build2', phase: 'completed', startedAt: '2026-10-28T00:00:00Z', finishedAt: null, manifestSha256: hash };
  await writeFile(join(config.webState, 'upgrade-children/child1.json'), JSON.stringify(child));
  await writeFile(join(config.webState, 'deployment.json'), JSON.stringify({ current: { version: '2.0.0', buildId: 'build2' }, job: { id: 'child1', phase: 'completed' } }));
  const a = await webChildControl(config, { operationId: 'child1' }, journal, 'boot1');
  assert.equal(a.state, 'completed'); assert.equal(a.components[0].childJobId, 'child1');
  assert.equal((await webChildControl(config, { operationId: 'child1' }, journal, 'boot2')).jobId, a.jobId);
  assert.equal((await journal.list()).length, 1);
});
test('Web receipt mismatch requires local reconciliation, never installation replay', async t => {
  const { config, journal } = await fixture(t);
  await writeFile(join(config.webState, 'upgrade-children/c1.json'), JSON.stringify({ schemaVersion: 1, id: 'c1', version: '2', buildId: 'b2', phase: 'completed', startedAt: null, finishedAt: null }));
  await writeFile(join(config.webState, 'deployment.json'), JSON.stringify({ current: { version: '1', buildId: 'b1' }, job: { id: 'c1', phase: 'completed' } }));
  const job = await webChildControl(config, { operationId: 'c1' }, journal, 'boot1');
  assert.equal(job.state, 'recovery-required'); assert.ok(job.recoveryCommand.includes('reconcile web-c1'));
  await pageControl(config, { action: 'page-stop', operationId: 'web-c1' }, journal, 'boot1');
  assert.equal((await journal.load('web-c1')).state, 'recovery-required');
});
test('HTTP parser rejects invented successful full plans and unknown owner states', () => {
  const value = { schemaVersion: 1, fullStackExecutable: false, plan: null, jobs: [] };
  assert.equal(parseFullUpgradeStatus(value), value);
  assert.throws(() => parseFullUpgradeStatus({ ...value, fullStackExecutable: true }));
  assert.throws(() => parseFullUpgradeStatus({ ...value, jobs: [{ state: 'green' }] }));
});

test('a completed pointer without terminal Web owner receipt remains unknown', async t => {
  const { config, journal } = await fixture(t);
  await writeFile(join(config.webState, 'upgrade-children/c2.json'), JSON.stringify({ schemaVersion: 1, id: 'c2', version: '2', buildId: 'b2', phase: 'starting', startedAt: null, finishedAt: null }));
  await writeFile(join(config.webState, 'deployment.json'), JSON.stringify({ current: { version: '2', buildId: 'b2' }, job: { id: 'c2', phase: 'completed' } }));
  assert.equal((await webChildControl(config, { operationId: 'c2' }, journal, 'boot1')).state, 'recovery-required');
});

test('component states do not inherit a different owner pending or unknown result', async t => {
  const { journal } = await fixture(t); const job = await create(journal);
  job.state = 'recovery-required';
  job.steps[0].intent = { action: 'replace', stepId: 'one', epoch: 1, fence: 'fence1' };
  job.steps[0].receipt = { outcome: 'applied', operationId: 'op1', epoch: 1, fence: 'fence1' };
  job.steps[1].intent = { action: 'replace', stepId: 'two', epoch: 1, fence: 'fence1' };
  const components = projectJob(job).components;
  assert.equal(components[0].state, 'completed'); assert.equal(components[1].state, 'recovery-required');
});

for (const terminal of ['deferred', 'recovery-required']) test(`Web intermediate deployment failure cannot override later ${terminal} owner receipt`, async t => {
  const { config, journal } = await fixture(t);
  const path = join(config.webState, 'upgrade-children/gap.json');
  const child = { schemaVersion: 1, id: 'gap', version: '2', buildId: 'b2', phase: 'prepared', startedAt: null, finishedAt: null };
  await writeFile(path, JSON.stringify(child));
  await writeFile(join(config.webState, 'deployment.json'), JSON.stringify({ current: { version: '1', buildId: 'b1' }, job: { id: 'gap', phase: 'failed' } }));
  assert.equal((await webChildControl(config, { operationId: 'gap' }, journal, 'boot1')).state, 'recovery-required');
  child.phase = terminal; await writeFile(path, JSON.stringify(child));
  assert.equal((await webChildControl(config, { operationId: 'gap' }, journal, 'boot1')).state, terminal);
  assert.equal((await journal.load('web-gap')).steps[0].receipt, null);
});
test('crash between first journal save and intent recovers the child from its durable fence', async t => {
  const { config, journal } = await fixture(t);
  const child = { schemaVersion: 1, id: 'first-save', version: '2', buildId: 'b2', phase: 'completed', startedAt: null, finishedAt: null };
  await writeFile(join(config.webState, 'upgrade-children/first-save.json'), JSON.stringify(child));
  await writeFile(join(config.webState, 'deployment.json'), JSON.stringify({ current: { version: '2', buildId: 'b2' }, job: { id: child.id, phase: 'completed' } }));
  const digest = sha256(JSON.stringify({ id: child.id, version: child.version, buildId: child.buildId }));
  const job = await journal.create({ operationId: 'web-' + child.id, planDigest: digest, manifestSha256: null, inventoryFingerprint: digest, bootId: 'boot1',
    steps: [{ stepId: 'web', ownerId: 'web-execution', action: 'official-web-transaction', epoch: 0, fence: child.id }] });
  job.state = 'recovery-required'; await journal.save(job);
  assert.equal(projectJob(job).components[0].childJobId, child.id);
  await reconcileWebChildren(config, journal, 'boot2');
  assert.equal((await journal.load(job.operationId)).state, 'completed');
  assert.equal((await journal.load(job.operationId)).steps[0].receipt.childJobId, child.id);
});
test('settled active-draining stop defers later steps through the live agent without losing receipts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'upgrade-live-stop-'));
  const { startAgent } = await import('../../scripts/full-upgrade/agent.mjs');
  const { request } = await import('../../scripts/full-upgrade/ipc.mjs');
  const config = { stateRoot: join(root, 'state'), runtimeRoot: join(root, 'ipc'), mode: 'local' };
  await mkdir(config.runtimeRoot + '-agent');
  const agent = await startAgent(config, new URL('../../scripts/full-upgrade/agent.mjs', import.meta.url).pathname);
  t.after(async () => { await new Promise(done => agent.server.close(done)); await agent.journal.close(); await rm(root, { recursive: true, force: true }); });
  const job = await create(agent.journal);
  job.state = 'active-draining'; job.steps[0].receipt = { outcome: 'applied', operationId: job.operationId, epoch: 1, fence: 'fence1' };
  await agent.journal.save(job);
  const result = await request(join(config.runtimeRoot + '-agent', 'control.sock'), { action: 'page-stop', operationId: job.operationId });
  assert.equal(result.stopRequested, true);
  await agent.server.enqueue(async () => {});
  const settled = await agent.journal.load(job.operationId);
  assert.equal(settled.state, 'deferred'); assert.deepEqual(settled.steps, job.steps);
});
