// Root policy changes waiting time only. It never selects or authorizes a release.
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { rootOwned } from '../full-upgrade/service-config.mjs';
import { parseStrictJson } from '../full-release/contract.mjs';

export const INITIAL_TARGET_READINESS_TIMEOUT_MS = 1_800_000;
export const INITIAL_TARGET_READINESS_FILE = 'initial-target-readiness.json';
const invariant = value => { if (!value) throw new Error('Invalid initial target readiness policy'); };
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
const locator = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/u.test(value);
function validateTarget(target) {
  invariant(keys(target, ['version', 'buildId', 'manifestSha256', 'releaseSequence'])
    && locator(target.version) && locator(target.buildId) && /^[a-f0-9]{64}$/.test(target.manifestSha256)
    && Number.isSafeInteger(target.releaseSequence) && target.releaseSequence > 0);
  return target;
}
const sameTarget = (a, b) => ['version', 'buildId', 'manifestSha256', 'releaseSequence'].every(k => a[k] === b[k]);
export function verifiedInitialTarget(release) {
  if (release.fullRelease?.authorization !== 'verified-installation') return null;
  return validateTarget({ version: release.version, buildId: release.buildId,
    manifestSha256: release.fullRelease.manifestSha256, releaseSequence: release.fullRelease.releaseSequence });
}
export function initialReadinessPolicy(target) {
  return { schemaVersion: 1, kind: 'opencraft.initial-target-readiness',
    timeoutMs: INITIAL_TARGET_READINESS_TIMEOUT_MS, target: validateTarget(target) };
}
export function validateInitialReadinessPolicy(policy) {
  invariant(keys(policy, ['schemaVersion', 'kind', 'timeoutMs', 'target']) && policy.schemaVersion === 1
    && policy.kind === 'opencraft.initial-target-readiness' && policy.timeoutMs === INITIAL_TARGET_READINESS_TIMEOUT_MS);
  validateTarget(policy.target); return policy;
}
export async function readInitialReadinessPolicy(path, { validateRoot = rootOwned } = {}) {
  try { await validateRoot(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    invariant(info.isFile() && info.nlink === 1 && info.uid === 0 && !(info.mode & 0o077) && info.size <= 16_384);
    const bytes = await handle.readFile(); invariant(bytes.length === info.size);
    return { policy: validateInitialReadinessPolicy(parseStrictJson(bytes, 16_384)),
      policySha256: createHash('sha256').update(bytes).digest('hex') };
  } finally { await handle.close(); }
}
export function validateInitialReadinessAttempt(attempt, release = null, jobId = null) {
  invariant(keys(attempt, ['schemaVersion', 'reason', 'jobId', 'target', 'policySha256', 'selectedAt', 'deadlineAt'])
    && attempt.schemaVersion === 1 && attempt.reason === 'root-owned-exact-target'
    && locator(attempt.jobId) && /^[a-f0-9]{64}$/.test(attempt.policySha256)
    && Number.isSafeInteger(attempt.selectedAt) && attempt.selectedAt >= 0
    && attempt.deadlineAt === attempt.selectedAt + INITIAL_TARGET_READINESS_TIMEOUT_MS);
  validateTarget(attempt.target);
  if (release) { const target = verifiedInitialTarget(release); invariant(target && sameTarget(target, attempt.target)); }
  if (jobId !== null) invariant(attempt.jobId === jobId);
  return attempt;
}
export async function selectInitialReadinessBudget(path, release, jobId, existing = null,
  { readPolicy = readInitialReadinessPolicy, now = Date.now() } = {}) {
  const record = await readPolicy(path);
  if (existing !== null) {
    validateInitialReadinessAttempt(existing, release, jobId);
    invariant(record && record.policySha256 === existing.policySha256);
    validateInitialReadinessPolicy(record.policy); invariant(sameTarget(record.policy.target, existing.target));
    return existing; // Reentry never renews even an exhausted deadline.
  }
  if (!record) return null;
  validateInitialReadinessPolicy(record.policy);
  const target = verifiedInitialTarget(release);
  if (!target || !sameTarget(target, record.policy.target)) return null;
  return validateInitialReadinessAttempt({ schemaVersion: 1, reason: 'root-owned-exact-target', jobId, target,
    policySha256: record.policySha256, selectedAt: now, deadlineAt: now + INITIAL_TARGET_READINESS_TIMEOUT_MS }, release, jobId);
}
