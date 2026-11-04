// Continue one original failed Web installation. No caller-selected source/path,
// retained rollback exception, data restore or replay watermark mutation.
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { readReplayState } from '../full-release/archive.mjs';
import { verifyRecoveryTarget } from '../full-release/retained.mjs';
import { inspectRelease } from './releases.mjs';

export function targetRecoveryInput(persisted, input) {
  return input && Object.keys(input).length === 4
    && Object.keys(input).every(k => ['jobId', 'version', 'buildId', 'manifestSha256'].includes(k))
    && /^[a-f0-9-]{36}$/.test(input.jobId ?? '')
    && /^[a-f0-9]{64}$/.test(input.manifestSha256 ?? '')
    && persisted.job?.id === input.jobId && persisted.job.phase === 'failed'
    && input.version === persisted.job.version;
}

export async function verifyFailedTarget({ directory, persisted, trust, input, upgrade, active }) {
  if (!trust || !upgrade || !targetRecoveryInput(persisted, input)) throw new Error('target-recovery-identity-mismatch');
  const statePath = join(directory, 'deployment.json');
  const childPath = join(directory, 'upgrade-children', input.jobId + '.json');
  const child = JSON.parse(await readFile(childPath, 'utf8'));
  const root = join(directory, 'releases', input.jobId, 'package');
  const releases = await realpath(join(directory, 'releases'));
  if (child.schemaVersion !== 1 || child.id !== input.jobId || child.phase !== 'recovery-required'
    || child.version !== input.version || child.buildId !== input.buildId
    || child.manifestSha256 !== input.manifestSha256 || child.retainedRoot !== root
    || await realpath(root) !== join(releases, input.jobId, 'package')) throw new Error('target-recovery-child-mismatch');
  const admission = await upgrade({ action: 'web-resume-admission', operationId: input.jobId });
  if (!admission.allowed) throw new Error('target-recovery-owner-conflict');
  const stateFile = join(directory, 'full-release-state.json');
  const state = await readReplayState(stateFile);
  const identity = await verifyRecoveryTarget(root, trust, state);
  const release = await inspectRelease(root);
  if (identity.manifestSha256 !== child.manifestSha256 || identity.releaseId !== child.releaseId
    || release.version !== child.version || release.buildId !== child.buildId)
    throw new Error('target-recovery-retained-identity-mismatch');
  async function unchanged() {
    if (JSON.stringify(JSON.parse(await readFile(statePath, 'utf8'))) !== JSON.stringify(persisted)
      || JSON.stringify(JSON.parse(await readFile(childPath, 'utf8'))) !== JSON.stringify(child)
      || JSON.stringify(await readReplayState(stateFile)) !== JSON.stringify(state) || !active())
      throw new Error('target-recovery-owner-changed');
  }
  await unchanged();
  return { release: { ...release, fullRelease: identity }, child, unchanged };
}
