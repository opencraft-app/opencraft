import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { atomicJson, privateDirectory, readPrivateJson, acquireLock, identifier, invariant } from './durable.mjs';

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const states = new Set(['queued', 'checking', 'downloading', 'prepared', 'failed', 'rolling-back', 'blocked', 'switching', 'active-draining', 'completed', 'rolled-back', 'deferred', 'recovery-required']);
// Only this explicit, bounded receipt projection is persistent. Never serialize
// owner responses, HTTP bodies, commands, credentials or raw exception messages.
export function receiptProjection(value) {
  invariant(value && ['applied', 'not-applied', 'unknown', 'draining', 'conflict', 'failed'].includes(value.outcome), 'invalid-receipt');
  const result = { outcome: value.outcome };
  for (const field of ['operationId', 'identity', 'childJobId', 'evidenceId', 'bootId', 'fence']) {
    if (value[field] !== undefined) { invariant(identifier(value[field]), 'invalid-receipt-field'); result[field] = value[field]; }
  }
  for (const field of ['epoch', 'affectedCount']) {
    if (value[field] !== undefined) { invariant(Number.isSafeInteger(value[field]) && value[field] >= 0, 'invalid-receipt-count'); result[field] = value[field]; }
  }
  if (value.disposition !== undefined) { invariant(['activated', 'discarded', 'dormant', 'retired', 'retained'].includes(value.disposition), 'invalid-disposition'); result.disposition = value.disposition; }
  if (value.healthy !== undefined) { invariant(typeof value.healthy === 'boolean', 'invalid-health'); result.healthy = value.healthy; }
  return result;
}
export class Journal {
  constructor(directory, persist = atomicJson) { this.directory = directory; this.persist = persist; this.release = null; this.poisoned = false; }
  async open() {
    await privateDirectory(this.directory);
    await privateDirectory(join(this.directory, 'stop-requests'));
    this.release = await acquireLock(join(this.directory, 'writer.lock'));
    return this;
  }
  async close() { await this.release?.(); this.release = null; }
  path(id) { invariant(identifier(id), 'invalid-operation-id'); return join(this.directory, id + '.json'); }
  async stopRequested(id) {
    invariant(identifier(id) && this.release && !this.poisoned, 'journal-unavailable');
    try { return (await readPrivateJson(join(this.directory, 'stop-requests', id + '.json'))).operationId === id; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async requestStop(id) {
    await this.load(id);
    try { await atomicJson(join(this.directory, 'stop-requests', id + '.json'), { operationId: id }); }
    catch (error) { this.poisoned = true; throw error; }
  }
  async load(id) {
    invariant(this.release && !this.poisoned, 'journal-unavailable');
    const job = await readPrivateJson(this.path(id));
    if (await this.stopRequested(id)) job.stopRequested = true;
    return job;
  }
  async list() {
    invariant(this.release && !this.poisoned, 'journal-unavailable');
    return Promise.all((await readdir(this.directory)).filter(n => /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(n)).map(n => this.load(n.slice(0, -5))));
  }
  async save(job) {
    invariant(this.release && !this.poisoned && states.has(job.state), 'journal-unavailable');
    invariant(Object.keys(job).every(k => ['schemaVersion', 'operationId', 'planDigest', 'manifestSha256', 'inventoryFingerprint',
      'bootId', 'revision', 'state', 'steps', 'automaticSnapshotRestore', 'oldArtifactId', 'newArtifactId', 'rollbackIntent', 'rollbackReceipt', 'startedAt', 'finishedAt', 'stopRequested', 'reason', 'releaseId', 'targetVersion', 'targetBuildId'].includes(k)), 'unknown-journal-field');
    for (const step of job.steps) {
      invariant(Object.keys(step).every(k => ['stepId', 'ownerId', 'action', 'epoch', 'fence', 'intent', 'receipt'].includes(k)), 'unknown-step-field');
      if (step.intent) invariant(Object.keys(step.intent).every(k => ['stepId', 'action', 'epoch', 'fence', 'childJobId'].includes(k)), 'unknown-intent-field');
      if (step.receipt) invariant(Object.keys(step.receipt).length === Object.keys(receiptProjection(step.receipt)).length, 'unprojected-receipt');
    }

    // A cancellation arriving during an owner await is monotonic. A later
    // receipt must not erase that intent with its older in-memory job copy.
    try { if ((await readPrivateJson(this.path(job.operationId))).stopRequested) job.stopRequested = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (await this.stopRequested(job.operationId)) job.stopRequested = true;
    try { await this.persist(this.path(job.operationId), job); }
    catch (error) { this.poisoned = true; throw error; }
    return job;
  }
  async create({ operationId, planDigest, manifestSha256, inventoryFingerprint, bootId, steps }) {
    invariant(identifier(operationId) && digest(planDigest) && (digest(manifestSha256) || manifestSha256 === null && steps?.every(s => s.action === 'official-web-transaction') && steps.length === 1) && digest(inventoryFingerprint) && identifier(bootId), 'invalid-plan-identity');
    invariant(Array.isArray(steps) && steps.length <= 128 && new Set(steps.map(s => s.stepId)).size === steps.length, 'invalid-steps');
    const projected = steps.map(step => {
      invariant(identifier(step.stepId) && identifier(step.ownerId) && identifier(step.action) && identifier(step.fence)
        && Number.isSafeInteger(step.epoch) && step.epoch >= 0, 'invalid-step');
      return { stepId: step.stepId, ownerId: step.ownerId, action: step.action, epoch: step.epoch, fence: step.fence,
        intent: null, receipt: null };
    });
    let existing;
    try { existing = await this.load(operationId); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) {
      invariant(existing.planDigest === planDigest && existing.manifestSha256 === manifestSha256
        && existing.inventoryFingerprint === inventoryFingerprint
        && JSON.stringify(existing.steps.map(({ intent, receipt, ...s }) => s)) === JSON.stringify(projected.map(({ intent, receipt, ...s }) => s)), 'idempotency-conflict');
      return existing;
    }
    return this.save({ schemaVersion: 1, operationId, planDigest, manifestSha256, inventoryFingerprint, bootId,
      revision: 0, state: 'queued', steps: projected, automaticSnapshotRestore: false });
  }
}

// Internal adapter contract: validate() re-verifies fixed signed target, current
// revocations, resources, all mixed pairs, storage/backup proofs and inventory.
// observe() is authoritative and side-effect-free. apply() must use owner CAS.
// A persisted intent with no receipt is NEVER resubmitted, even if observe says
// not-applied: the owner must provide an explicit future recovery operation.
export async function advance(job, journal, adapters, validate, lockPath) {
  if (['completed', 'blocked', 'recovery-required', 'failed', 'rolled-back', 'deferred'].includes(job.state)) return job;
  const unlock = await acquireLock(lockPath);
  try {
    if (!await validate(job)) { job.state = 'blocked'; job.revision++; return await journal.save(job); }
    job.state = 'switching';
    for (const step of job.steps) {
      if ((await journal.load(job.operationId)).stopRequested) {
        job.stopRequested = true; job.state = 'deferred'; job.revision++; return await journal.save(job);
      }
      const owner = adapters[step.ownerId];
      if (!owner) { job.state = 'blocked'; job.revision++; return await journal.save(job); }
      if (step.receipt?.outcome === 'applied') continue;
      if (step.intent) {
        const observed = receiptProjection(await owner.observe({ operationId: job.operationId, ...step.intent }));
        // Matching operation, epoch and fence must come from the owner, not a
        // generic healthy/unit-active observation or a package pointer.
        if (observed.outcome === 'applied' && observed.operationId === job.operationId && observed.epoch === step.epoch && observed.fence === step.fence) {
          step.receipt = observed; job.revision++; await journal.save(job); continue;
        }
        job.state = 'recovery-required'; job.revision++; return await journal.save(job);
      }
      const before = receiptProjection(await owner.observe({ operationId: job.operationId, stepId: step.stepId, action: step.action, epoch: step.epoch, fence: step.fence }));
      if (before.outcome !== 'not-applied' || before.operationId !== job.operationId || before.epoch !== step.epoch || before.fence !== step.fence) {
        job.state = 'recovery-required'; job.revision++; return await journal.save(job);
      }
      step.intent = { stepId: step.stepId, action: step.action, epoch: step.epoch, fence: step.fence };
      job.revision++; await journal.save(job);
      const receipt = receiptProjection(await owner.apply({ operationId: job.operationId, ...step.intent }));
      if (receipt.operationId !== job.operationId || receipt.epoch !== step.epoch || receipt.fence !== step.fence || !['applied', 'draining'].includes(receipt.outcome)) {
        job.state = 'recovery-required'; job.revision++; return await journal.save(job);
      }
      step.receipt = receipt;
      if (receipt.outcome === 'draining') { job.state = 'active-draining'; job.revision++; return await journal.save(job); }
      job.revision++; await journal.save(job);
    }
    job.state = 'completed'; job.revision++; return await journal.save(job);
  } finally { await unlock(); }
}
