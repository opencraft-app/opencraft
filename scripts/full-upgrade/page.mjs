// Authorized, bounded projection. Raw inventory paths/processes never cross HTTP.
import { request } from './ipc.mjs';
import { socketPath } from './service-config.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { webChildControl } from './web-child.mjs';
import { inspect } from './inspect.mjs';
import { readAuthority } from './service-config.mjs';
import { acceptManifest, parseStrictJson } from '../full-release/contract.mjs';
import { atomicJson, identifier, invariant } from './durable.mjs';

const terminal = new Set(['blocked', 'completed', 'failed', 'rolled-back', 'deferred', 'recovery-required']);
export function projectJob(job, config = null) {
  const owners = new Map();
  for (const step of job.steps) owners.set(step.ownerId, [...(owners.get(step.ownerId) ?? []), step]);
  const components = [...owners].map(([componentId, steps]) => {
    const forward = steps.filter(s => !['compensate', 'cleanup'].includes(s.action));
    const done = forward.length > 0 && forward.every(s => s.receipt?.outcome === 'applied');
    let state = done ? 'completed' : steps.some(s => s.intent) ? job.state : job.state === 'blocked' ? 'blocked' : job.state === 'deferred' ? 'deferred' : 'queued';
    if (steps.some(s => s.receipt?.outcome === 'failed')) state = 'failed';
    if (steps.some(s => s.receipt?.outcome === 'draining') || done && job.state === 'active-draining' && steps.some(s => s.action === 'activate')) state = 'active-draining';
    if (job.state === 'rolled-back' && steps.some(s => s.action === 'compensate' && s.receipt?.outcome === 'applied')) state = 'rolled-back';
    if (job.state === 'recovery-required' && steps.some(s => s.intent && !s.receipt)) state = 'recovery-required';
    const childJobId = steps.map(s => s.intent?.childJobId ?? s.receipt?.childJobId ?? (s.action === 'official-web-transaction' ? s.fence : null)).find(Boolean) ?? null;
    const receipts = steps.flatMap(s => s.receipt ? [s.receipt] : []);
    return { componentId, state, childJobId, affectedCount: receipts.find(r => r.affectedCount !== undefined)?.affectedCount ?? null,
      healthy: receipts.findLast(r => r.healthy !== undefined)?.healthy ?? null };
  });
  return { jobId: job.operationId, planDigest: job.planDigest, state: job.state,
    releaseId: job.releaseId ?? null, targetVersion: job.targetVersion ?? null, targetBuildId: job.targetBuildId ?? null,
    startedAt: job.startedAt ?? null, finishedAt: job.finishedAt ?? null,
    stopRequested: job.stopRequested ?? false,
    reason: job.reason ?? (job.state === 'recovery-required' ? 'unknown-result' : null),
    recoveryCommand: job.state === 'recovery-required'
      ? `${config?.node ?? 'node'} /opt/opencraft-upgrade/current-agent/upgrade-control.mjs --config /etc/opencraft-upgrade/config.json reconcile ${job.operationId}` : null,
    components };
}
export function projectPlan(plan) {
  return { planId: plan.planId, planDigest: plan.planDigest, status: 'blocked', executable: false,
    releaseId: plan.target.releaseId, sourceRevision: plan.target.source.revision,
    channel: plan.target.channel, manifestSha256: plan.target.manifestSha256,
    downloadBytes: null, // The signed manifest's unpacked size is not download progress.
    blockedReasons: [...new Set(['real-owner-adapters-unavailable', ...plan.blockedReasons])],
    components: plan.components.map(c => ({ componentId: c.componentId, role: c.role,
      targetVersion: c.target.version, runningVersion: null, installedVersion: null, nextStartVersion: null,
      state: c.status, impact: c.interruption, blockedReasons: c.blockedReasons })) };
}
export async function pageControl(config, input, journal, bootId) {
  const planPath = join(config.stateRoot, 'page-plan.json');
  const readPlan = async () => { try { return parseStrictJson(await readFile(planPath)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  if (config.fullRecipePath && ['page-check', 'page-start', 'page-reconcile'].includes(input.action)) {
    const operationId = input.operationId ?? 'full-' + Date.now();
    if (input.action === 'page-reconcile') return request(socketPath(config, 'helper'), { action: 'full-recover', operationId }, 120000);
    const checked = await request(socketPath(config, 'helper'), { action: 'full-inspect', operationId }, 120000);
    await atomicJson(planPath, checked.plan);
    if (input.action === 'page-check') return { ...checked, job: null };
    invariant(checked.plan.planDigest === input.planDigest && checked.plan.executable, 'parent-plan-changed');
    const result = await request(socketPath(config, 'helper'), { action: 'full-start', operationId, planDigest: checked.plan.planDigest }, 120000);
    return { plan: checked.plan, job: result, fullStackExecutable: true };
  }
  if (input.action === 'page-status') {
    const all = [...await journal.list(), ...(config.fullRecipePath ? (await request(socketPath(config, 'helper'), { action: 'full-status' })).jobs : [])].sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
    const ongoing = job => !['blocked', 'completed', 'failed', 'deferred', 'rolled-back'].includes(job.state);
    const jobs = [...all.filter(ongoing), ...all.filter(job => !ongoing(job)).slice(0, 100)];
    return { schemaVersion: 1, plan: await readPlan(), jobs: jobs.map(job => projectJob(job, config)), fullStackExecutable: !!config.fullRecipePath };
  }
  if (input.action === 'page-reconcile') {
    const job = await journal.load(input.operationId);
    if (job.steps[0]?.action === 'official-web-transaction')
      return webChildControl(config, { operationId: job.steps[0].intent?.childJobId ?? job.steps[0].fence }, journal, bootId);
    return projectJob(job, config); // No P3 owner-specific recovery command yet.
  }
  if (input.action === 'page-stop' && config.fullRecipePath) {
    try { return projectJob(await request(socketPath(config, 'helper'), { action: 'full-stop', operationId: input.operationId }), config); } catch {}
  }
  if (input.action === 'page-stop') {
    invariant(identifier(input.operationId), 'invalid-operation');
    const job = await journal.load(input.operationId);
    // Stop is an intent consumed between committed owner steps; it never kills
    // an in-flight migration or clears an unknown result.
    if (!terminal.has(job.state)) {
      await journal.requestStop(job.operationId);
    }
    return projectJob(await journal.load(job.operationId), config);
  }
  invariant(['page-check', 'page-start'].includes(input.action), 'unsupported-page-action');
  const priorPlan = await readPlan();
  if (input.action === 'page-start') invariant(priorPlan?.planDigest === input.planDigest, 'stale-plan');
  let plan, inventoryFingerprint;
  try {
    const { trust, state } = await readAuthority(config);
    const bytes = await readFile(join(config.targetRoot, 'release/full-release.json'));
    acceptManifest(bytes, parseStrictJson(await readFile(join(config.targetRoot, 'release/full-release.sig'))), trust, state);
    const result = await inspect({ profile: parseStrictJson(await readFile(config.profilePath)), targetRoot: config.targetRoot, trust });
    plan = projectPlan(result.plan); inventoryFingerprint = result.inventory.fingerprint;
  } catch {
    // Missing/invalid authority is a visible blocked plan, never a fallback key.
    plan = { planId: null, planDigest: null, status: 'blocked', executable: false,
      releaseId: null, sourceRevision: null, channel: null, manifestSha256: null,
      downloadBytes: null, components: [], blockedReasons: ['signed-plan-unavailable'] };
  }
  await atomicJson(planPath, plan);
  if (!plan.planDigest) return { plan, job: null, fullStackExecutable: false };
  const id = 'full-' + plan.planDigest;
  let job;
  try { job = await journal.load(id); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!job) {
    job = await journal.create({ operationId: id, planDigest: plan.planDigest, manifestSha256: plan.manifestSha256,
      inventoryFingerprint, bootId, steps: [] });
    job.state = 'blocked'; job.releaseId = plan.releaseId; job.startedAt = new Date().toISOString(); job.finishedAt = job.startedAt;
    job.reason = 'real-owner-adapters-unavailable'; job.revision++; await journal.save(job);
  }
  // A changed plan is displayed but never implicitly accepted by page-start.
  return { plan, job: projectJob(job, config), replanRequired: input.action === 'page-start' && plan.planDigest !== input.planDigest, fullStackExecutable: false };
}

export async function reconcileWebChildren(config, journal, bootId) {
  for (const job of await journal.list()) {
    const step = job.steps[0];
    if (step?.action !== 'official-web-transaction' || ['completed', 'failed', 'deferred'].includes(job.state)) continue;
    try { await webChildControl(config, { operationId: step.intent?.childJobId ?? step.fence }, journal, bootId); }
    catch { if (job.state !== 'recovery-required') { job.state = 'recovery-required'; job.revision++; await journal.save(job); } }
  }
}
