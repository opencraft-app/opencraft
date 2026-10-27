import { readFile, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseManifest, parseStrictJson, verifyBytes, enforcePolicy, acceptManifest, sha256, HARD_LIMITS } from './contract.mjs';
import { readReplayState, writeReplayState } from './archive.mjs';

async function authenticateRetained(root, trust) {
  const raw = await readFile(join(root, 'release/full-release.json'));
  const sig = parseStrictJson(await readFile(join(root, 'release/full-release.sig')), HARD_LIMITS.metadataBytes);
  verifyBytes(raw, sig, trust);
  const record = parseManifest(raw);
  for (const component of record.components) for (const [path, digest, size, mode] of component.fileList) {
    const absolute = join(root, path), info = await lstat(absolute);
    if (!info.isFile() || info.size !== size || (info.mode & 0o7777) !== parseInt(mode, 8)) throw new Error('Retained full release content changed');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(absolute)) hash.update(chunk);
    if (hash.digest('hex') !== digest) throw new Error('Retained full release content changed');
  }
  return { raw, sig, record };
}

// Only the administrator-selected persisted previous release can use this
// exception. Current authenticated revocations still apply to the old payload.
export async function verifyRetainedRelease(root, trust, state) {
  const { raw, sig, record } = await authenticateRetained(root, trust);
  enforcePolicy(record, sig.keyId, trust, state, Date.now(), { retainedRollback: true });
  return { manifestSha256: sha256(raw), releaseId: record.release.releaseId,
    releaseSequence: record.release.releaseSequence, highestSequence: state.highestSequence || 0,
    authorization: 'administrator-retained-payload' };
}

// The caller holds the deployment lock, before starting any worker/execution.
// Official first installation and fixed-bootstrap maintenance use the same path.
export async function initializeReplayState(root, trust, stateFile, activatedIdentity = null) {
  const state = await readReplayState(stateFile);
  const { raw, sig, record } = await authenticateRetained(root, trust);
  const digest = sha256(raw), sequence = record.release.releaseSequence;
  const identity = { manifestSha256: digest, releaseId: record.release.releaseId, releaseSequence: sequence, authorization: 'verified-installation' };
  if (activatedIdentity && Object.keys(identity).some(key => activatedIdentity[key] !== identity[key])) throw new Error('Installed full release activation identity changed');
  if (!state.highestSequence || sequence > state.highestSequence) {
    const accepted = acceptManifest(raw, sig, trust, state);
    await writeReplayState(stateFile, accepted.state);
    return { state: accepted.state, identity };
  }
  if (sequence === state.highestSequence && digest !== state.manifestSha256) throw new Error('Full release sequence collision');
  if (sequence < state.highestSequence && !activatedIdentity) throw new Error('Installed full release lacks its committed activation identity');
  // Reopening a previously authenticated current/rollback payload is not a new
  // installation. Its expiry cannot lower a watermark or stop a healthy owner.
  return { state, identity };
}
