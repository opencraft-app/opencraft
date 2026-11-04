// Only the Web transaction owner can attest recovery. A health observation
// alone cannot retire an uncertain installation, and this path never installs.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyRetainedRelease } from '../full-release/retained.mjs';
import { readReplayState } from '../full-release/archive.mjs';

export async function verifyCurrentRecovery({ directory, persisted, execution, trust, input, active }) {
  if (!trust || !execution?.verifyRecovery) throw new Error('recovery-verifier-unavailable');
  if (!input || Object.keys(input).some(k => !['jobId', 'version', 'buildId'].includes(k))
    || !/^[a-f0-9-]{36}$/.test(input.jobId ?? '')
    || persisted.job?.id !== input.jobId || persisted.job.phase !== 'failed'
    || input.version !== persisted.current.version || input.buildId !== persisted.current.buildId)
    throw new Error('recovery-identity-mismatch');
  const statePath = join(directory, 'deployment.json');
  const childPath = join(directory, 'upgrade-children', input.jobId + '.json');
  const original = JSON.stringify(persisted);
  const child = JSON.parse(await readFile(childPath, 'utf8'));
  if (child.schemaVersion !== 1 || child.id !== input.jobId || child.version !== persisted.job.version
    || !['recovery-required', 'failed'].includes(child.phase)
    || child.phase === 'failed' && !child.recovery
    || child.version === input.version && child.buildId === input.buildId)
    throw new Error('recovery-child-mismatch');
  // Verify every signed file, mode, size, signature, current revocations and
  // replay watermark. Never restore a database snapshot or lower a watermark.
  let retained;
  try { retained = await verifyRetainedRelease(persisted.current.releaseRoot, trust,
    await readReplayState(join(directory, 'full-release-state.json'))); }
  catch { throw new Error('recovery-retained-verification-failed'); }
  if (retained.manifestSha256 !== persisted.current.fullRelease?.manifestSha256
    || retained.releaseId !== persisted.current.fullRelease?.releaseId)
    throw new Error('recovery-retained-identity-mismatch');
  let evidence;
  try { evidence = await execution.verifyRecovery(persisted.current); }
  catch { throw new Error('recovery-execution-verification-failed'); }
  if (JSON.stringify(JSON.parse(await readFile(statePath, 'utf8'))) !== original
    || JSON.stringify(JSON.parse(await readFile(childPath, 'utf8'))) !== JSON.stringify(child)
    || !active()) throw new Error('recovery-owner-changed');
  const recovery = { schemaVersion: 1, jobId: child.id, outcome: 'rolled-back',
    verifiedAt: new Date().toISOString(), current: { version: input.version, buildId: input.buildId,
      manifestSha256: retained.manifestSha256, releaseId: retained.releaseId }, execution: evidence };
  return { next: { ...persisted, job: { ...persisted.job, recovery, recoveryError: null } },
    child: { ...child, phase: 'failed', finishedAt: new Date().toISOString(), recovery } };
}
