import { readFile, lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { invariant, sha256 } from './durable.mjs';
import { verifyBytes, parseManifest, parseStrictJson, enforcePolicy } from '../full-release/contract.mjs';
export const PROTOCOL = { protocol: 1, accepts: [1], kind: 'opencraft.upgrade-control' };
export async function rootOwned(path) {
  let current = path;
  while (true) {
    const s = await lstat(current);
    invariant(!s.isSymbolicLink() && s.uid === 0 && !(s.mode & 0o022), 'root-owned-path-required');
    if (current === '/') return;
    current = dirname(current);
  }
}
export async function readConfig(path) {
  await rootOwned(path);
  const config = JSON.parse(await readFile(path, 'utf8'));
  invariant(config.protocol === 1 && ['ci', 'local'].includes(config.mode), 'unsupported-config');
  for (const key of ['stateRoot', 'controlStateRoot', 'runtimeRoot', 'artifactRoot', 'deployLock', 'profilePath', 'targetRoot', 'webState', 'trustFile']) {
    invariant(typeof config[key] === 'string' && isAbsolute(config[key]), 'absolute-config-path-required');
  }
  return config;
}
export const socketPath = (config, role) => join(config.runtimeRoot + '-' + role, 'control.sock');
export async function entryIdentity(entry) { return sha256(await readFile(await realpath(entry))); }
export async function readAuthority(config, validateRoot = rootOwned) {
  await validateRoot(config.trustFile);
  return { trust: parseStrictJson(await readFile(config.trustFile)),
    state: parseStrictJson(await readFile(join(config.webState, 'full-release-state.json'))) };
}
export async function artifactEntry(config, artifactId, role) {
  invariant(/^[a-f0-9]{64}$/.test(artifactId) && ['agent', 'helper'].includes(role), 'invalid-artifact');
  const directory = join(config.artifactRoot, artifactId);
  await rootOwned(directory);
  await rootOwned(join(directory, 'installation.json'));
  const proof = JSON.parse(await readFile(join(directory, 'installation.json'), 'utf8'));
  invariant(proof.artifactId === artifactId && proof.protocol === 1 && /^[a-f0-9]{64}$/.test(proof.manifestSha256), 'unapproved-artifact');
  const bytes = await readFile(join(directory, 'release/full-release.json'));
  const signature = parseStrictJson(await readFile(join(directory, 'release/full-release.sig')));
  const { trust, state } = await readAuthority(config);
  verifyBytes(bytes, signature, trust);
  const manifest = parseManifest(bytes);
  enforcePolicy(manifest, signature.keyId, trust, state, Date.now(), { retainedRollback: true });
  invariant(sha256(bytes) === proof.manifestSha256 && manifest.release.releaseId === proof.releaseId, 'artifact-provenance-mismatch');
  const path = join(directory, 'upgrade-' + role + '.mjs');
  await rootOwned(path);
  invariant(sha256(await readFile(path)) === proof[role + 'Sha256'], 'artifact-content-mismatch');
  return { path, proof };
}
