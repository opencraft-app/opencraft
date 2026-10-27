import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseStrictJson, sha256 } from '../full-release/contract.mjs';
import { invariant } from './durable.mjs';
// These bytes are a member of the P1a signed manifest, so expiry, sequence and
// revocation authority is exactly the release authority, with no second key.
export function acceptReleasePolicy(manifest, bytes) {
  const entry = manifest.components.flatMap(c => c.fileList).find(f => f[0] === 'release/upgrade-policy.json');
  invariant(entry && entry[1] === sha256(bytes) && entry[2] === bytes.length, 'unsigned-upgrade-policy');
  const policy = parseStrictJson(bytes, 65536);
  invariant(policy.schemaVersion === 1 && policy.kind === 'opencraft.upgrade-policy'
    && policy.releaseId === manifest.release.releaseId && policy.releaseSequence === manifest.release.releaseSequence
    && Array.isArray(policy.compatibility) && Array.isArray(policy.recipes)
    && policy.compatibility.length <= 128 && policy.recipes.length <= 128, 'invalid-upgrade-policy');
  return policy;
}
export async function readReleasePolicy(root, manifest) {
  return acceptReleasePolicy(manifest, await readFile(join(root, 'release/upgrade-policy.json')));
}
