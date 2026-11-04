// The official Web transaction owns installation, previous and rollback. This
// adapter only journals its durable receipt; it cannot submit/replay an install.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseStrictJson, sha256 } from '../full-release/contract.mjs';
import { invariant, identifier } from './durable.mjs';
import { projectJob } from './page.mjs';
export async function webChildControl(config, input, journal, bootId) {
  invariant(identifier(input.operationId), 'invalid-child-id');
  const child = parseStrictJson(await readFile(join(config.webState, 'upgrade-children', input.operationId + '.json')));
  invariant(child.schemaVersion === 1 && child.id === input.operationId && typeof child.version === 'string'
    && typeof child.buildId === 'string' && ['downloading', 'verifying', 'prepared', 'starting', 'completed', 'failed', 'deferred', 'recovery-required'].includes(child.phase), 'invalid-web-receipt');
  const deployment = parseStrictJson(await readFile(join(config.webState, 'deployment.json')));
  // A committed pointer can precede final worker/rollback checks. Only the
  // separate terminal owner receipt proves success; a lost receipt stays
  // unknown rather than promoting a healthy-looking pointer to completion.
  if (deployment.job?.id === child.id && deployment.job.phase === 'completed'
    && !['completed', 'failed', 'deferred'].includes(child.phase)) child.phase = 'recovery-required';
  if (deployment.job?.id === child.id && deployment.job.phase === 'failed' && !['deferred', 'recovery-required'].includes(child.phase)) {
    // The separate owner receipt may still be deferred or uncertain.
    if (!['completed', 'failed'].includes(child.phase)) child.phase = 'recovery-required';
  }
  if (deployment.job?.id !== child.id && !['completed', 'failed', 'deferred'].includes(child.phase)) child.phase = 'recovery-required';
  const digest = sha256(JSON.stringify({ id: child.id, version: child.version, buildId: child.buildId }));
  const id = 'web-' + child.id;
  let job;
  try { job = await journal.load(id); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!job) job = await journal.create({ operationId: id, planDigest: digest, manifestSha256: child.manifestSha256 ?? null,
    inventoryFingerprint: digest, bootId, steps: [{ stepId: 'web', ownerId: 'web-execution', action: 'official-web-transaction', epoch: 0, fence: child.id }] });
  invariant(job.planDigest === digest, 'child-identity-conflict');
  if (job.state === 'completed' && child.phase === 'completed' && job.steps[0].receipt?.outcome === 'applied') return projectJob(job, config);
  const recovery = child.recovery;
  const recoveryDigest = recovery ? sha256(JSON.stringify(recovery)) : null;
  if (child.phase === 'failed' && job.state === 'rolled-back'
    && job.steps[0].receipt?.evidenceId === recoveryDigest) return projectJob(job, config);
  const recovered = child.phase === 'failed' && recovery?.schemaVersion === 1
    && recovery.jobId === child.id && recovery.outcome === 'rolled-back'
    && typeof recovery.verifiedAt === 'string' && Number.isFinite(Date.parse(recovery.verifiedAt))
    && deployment.job?.id === child.id && deployment.job.phase === 'failed'
    && JSON.stringify(deployment.job.recovery) === JSON.stringify(recovery)
    && recovery.current?.version === deployment.current?.version
    && recovery.current?.buildId === deployment.current?.buildId
    && /^[a-f0-9]{64}$/.test(recovery.current?.manifestSha256 ?? '')
    && recovery.current.manifestSha256 === deployment.current?.fullRelease?.manifestSha256
    && recovery.current.releaseId === deployment.current?.fullRelease?.releaseId;
  // A recovery claim without matching durable owner evidence stays unknown.
  if (recovery && !recovered) child.phase = 'recovery-required';
  const before = JSON.stringify(job);
  job.releaseId = child.releaseId ?? null; job.targetVersion = child.version; job.targetBuildId = child.buildId;
  const step = job.steps[0];
  if (!['completed', 'failed'].includes(child.phase)) step.receipt = null;
  if (child.manifestSha256) job.manifestSha256 = child.manifestSha256;
  step.intent = { stepId: step.stepId, action: step.action, epoch: step.epoch, fence: step.fence, childJobId: child.id };
  job.state = ({ verifying: 'checking', starting: 'switching' })[child.phase] ?? child.phase;
  job.startedAt ??= child.startedAt;
  if (child.phase === 'completed') {
    // Both the official transaction's durable terminal receipt and exact target
    // pointer must agree. File installation alone never proves full completion.
    if (deployment.current?.version !== child.version || deployment.current?.buildId !== child.buildId) job.state = 'recovery-required';
    else step.receipt = { outcome: 'applied', operationId: id, epoch: 0, fence: child.id, childJobId: child.id, healthy: true };
  }
  if (child.phase === 'failed') step.receipt = { outcome: 'failed', operationId: id, epoch: 0, fence: child.id, childJobId: child.id };
  if (recovered) {
    job.state = 'rolled-back';
    step.receipt = { outcome: 'not-applied', operationId: id, epoch: 0, fence: child.id,
      childJobId: child.id, evidenceId: recoveryDigest, healthy: true };
  }
  job.finishedAt = ['completed', 'failed', 'deferred', 'rolled-back'].includes(job.state) ? child.finishedAt : null;
  if (JSON.stringify(job) !== before) { job.revision++; await journal.save(job); }
  return projectJob(job, config);
}
