// P2c generation-only transaction. The full-stack plan remains blocked until
// every other owner has its own adapter. No task/data migration is performed.
import { verifyBytes, sha256 } from '../full-release/contract.mjs';
import { fingerprint } from './inventory.mjs';
import { acquireLock, invariant, identifier } from './durable.mjs';
import { receiptProjection } from './journal.mjs';

export function acceptGenerationPlan({ manifestSha256, inventoryFingerprint, policy, matrixBytes, signature, trust, combination, now = Date.now() }) {
  verifyBytes(matrixBytes, signature, trust);
  const matrix = JSON.parse(matrixBytes);
  invariant(matrix.schemaVersion === 1 && matrix.kind === 'opencraft.generation-compatibility'
    && matrix.manifestSha256 === manifestSha256 && Number.isSafeInteger(matrix.expiresAt) && now < matrix.expiresAt
    && !trust.revokedKeyIds?.includes(signature.keyId), 'compatibility-matrix-unavailable');
  invariant(matrix.combinations.some(row => row.status === 'verified' && fingerprint(row.combination) === fingerprint(combination)
    && row.forward === true && row.rollback === true && row.retainBindings === true), 'combination-blocked');
  const body = { kind: 'opencraft.generation-plan', manifestSha256, inventoryFingerprint,
    policySha256: fingerprint(policy), matrixSha256: sha256(matrixBytes), combination };
  return { ...body, planDigest: fingerprint(body) };
}
const identity = state => fingerprint({ owner: state.owner, host: state.host, epoch: state.epoch, current: state.current, generations: state.generations });
const receipt = (job, step, outcome, evidenceId, disposition) => receiptProjection({ operationId: job.operationId, epoch: step.epoch, fence: step.fence, outcome, evidenceId, ...(disposition ? { disposition } : {}) });

/** owner: snapshot(), prepare(), preparation(id), activate(id, expected, proof),
 * cleanup(id, expected, proof). All mutations use existing private owner APIs.
 * validate re-verifies signature, revocation, policy and inventory under lock.
 * An uncertain intent is retained; restart cannot replay a native mutation. */
export async function switchGeneration({ plan, operationId, bootId, journal, lockPath, owner, targetId, validate }) {
  invariant(identifier(targetId) && plan.combination.targetId === targetId && plan.combination.ownerId === owner.id, 'invalid-generation');
  const unlock = await acquireLock(lockPath);
  try {
    let job;
    try { job = await journal.load(operationId); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (job) {
      invariant(job.planDigest === plan.planDigest, 'idempotency-conflict');
      if (!['completed', 'blocked', 'recovery-required', 'active-draining', 'rolled-back'].includes(job.state)) {
        job.state = 'recovery-required'; job.revision++; await journal.save(job);
      }
      return job;
    }
    const before = await owner.snapshot();
    job = await journal.create({ operationId, planDigest: plan.planDigest, manifestSha256: plan.manifestSha256,
      inventoryFingerprint: plan.inventoryFingerprint, bootId,
      steps: ['prepare', 'activate', 'compensate', 'cleanup'].map(action => ({ stepId: action, ownerId: owner.id, action, epoch: before.epoch, fence: before.owner })) });
    const save = async state => { job.state = state; job.revision++; return journal.save(job); };
    const perform = async (index, fn) => {
      const step = job.steps[index]; step.intent = { stepId: step.stepId, action: step.action, epoch: step.epoch, fence: step.fence };
      await save('switching');
      const evidence = await fn();
      step.receipt = receipt(job, step, 'applied', fingerprint(evidence ?? null), evidence?.disposition);
      await save('switching');
      return evidence;
    };
    if (fingerprint(before) !== plan.combination.from || !await validate(plan, 'before-prepare') || before.current === targetId || before.generations.some(g => g.id === targetId)) return await save('blocked');
    try {
      await perform(0, () => owner.prepare(targetId, before));
      const prepared = await owner.snapshot();
      // Preparation may add only this candidate. Every original identity,
      // incarnation and default must still match the accepted plan.
      invariant(identity({ ...prepared, generations: prepared.generations.filter(g => g.id !== targetId) }) === identity(before), 'owner-drift');
      invariant(await validate(plan, 'before-activate'), 'plan-drift');
      const proof = await owner.preparation(targetId, before);
      await perform(1, () => owner.activate(targetId, before, proof, fingerprint({ operationId, stepId: 'activate' })));
      const active = await owner.snapshot();
      invariant(active.owner === before.owner && active.host === before.host && active.current === targetId && active.epoch === before.epoch + 1
        && active.lastActivation?.operationId === fingerprint({ operationId, stepId: 'activate' }), 'activation-unconfirmed');
      return await save('active-draining');
    } catch {
      if (journal.poisoned) throw new Error('journal-unavailable');
      // A persisted intent may have succeeded. Compensate only this exact
      // activation epoch, never a later writer's default or a restarted owner.
      try {
        invariant(job.steps[0].receipt, 'preparation-unconfirmed');
        const actual = await owner.snapshot();
        invariant(actual.owner === before.owner && actual.host === before.host, 'owner-restarted');
        if (actual.current === targetId && actual.epoch === before.epoch + 1) {
          invariant(job.steps[1].intent && actual.lastActivation?.operationId === fingerprint({ operationId, stepId: 'activate' })
            && actual.lastActivation.owner === before.owner && actual.lastActivation.generationId === targetId && actual.lastActivation.epoch === actual.epoch, 'foreign-activation');
          const proof = await owner.preparation(before.current, actual);
          await perform(2, () => owner.activate(before.current, actual, proof, fingerprint({ operationId, stepId: 'compensate' })));
        } else {
          invariant(!job.steps[1].intent, 'activation-unconfirmed');
          invariant(actual.current === before.current && actual.epoch === before.epoch, 'cas-conflict');
        }
        const restored = await owner.snapshot();
        invariant(restored.owner === before.owner && restored.current === before.current, 'rollback-unconfirmed');
        // Only a confirmed completed preparation reaches cleanup. An uncertain
        // prepare/add stays recovery-required even when the candidate is absent.
        if (restored.generations.some(g => g.id === targetId)) await perform(3, () => owner.cleanup(targetId, restored));
        const final = await owner.snapshot();
        invariant(final.owner === restored.owner && final.current === restored.current && final.epoch === restored.epoch, 'cleanup-drift');
        return await save('rolled-back');
      } catch { if (journal.poisoned) throw new Error('journal-unavailable'); return await save('recovery-required'); }
    }
  } finally { await unlock(); }
}
