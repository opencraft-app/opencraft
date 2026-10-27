import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { signBytes, sha256, fileListDigest, LEGACY_LIMITS, HARD_LIMITS } from '../../scripts/full-release/contract.mjs';
// Synthetic release authority and an empty owner profile. Never copies a real
// account, trust key, descriptor, environment, HOME or deployment journal.
export async function signedInspectionFixture(config) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const now = Date.now(), source = 'a'.repeat(40);
  const policy = { schemaVersion: 1, kind: 'opencraft.upgrade-policy', releaseId: 'fixture-release', releaseSequence: 1, compatibility: [], recipes: [] };
  const policyBytes = Buffer.from(JSON.stringify(policy));
  const files = [['LICENSE', sha256('license'), 7, '0644'], ['release/upgrade-policy.json', sha256(policyBytes), policyBytes.length, '0644']];
  const trust = { product: 'fixture', channel: 'fixture', registry: 'https://registry.example/', packageName: '@example/app', keys: { fixture: publicKey.export({ type: 'spki', format: 'pem' }) } };
  const manifest = { schemaVersion: 1, kind: 'opencraft.full-release',
    release: { releaseId: policy.releaseId, releaseSequence: 1, createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 86400000).toISOString(), product: 'fixture', channel: 'fixture', source: { revision: source, upstreamRevision: source, patchSetSha256: 'a'.repeat(64) } },
    transport: { kind: 'npm', registry: trust.registry, packageName: trust.packageName, exactVersion: '2.0.0' },
    targets: [{ profile: 'headless', platform: process.platform, arch: process.arch, nodeAbi: Number(process.versions.modules) }],
    updater: { minBootstrap: 1, minAgent: 1, helperProtocol: 1, bridge: true, legacy: { ...LEGACY_LIMITS } }, revocations: { sequence: 1, keyIds: [], releaseIds: [] },
    components: [{ componentId: 'web', role: 'web', version: '2.0.0', buildId: 'fixture2', sourceRevision: source, required: true, enabledPolicy: 'preserve', content: { kind: 'tree', root: '.', fileListSha256: fileListDigest(files), unpackedBytes: 7 + policyBytes.length, entries: 2 }, fileList: files, provides: [], requires: [], activation: { strategy: 'web-transaction', unitRole: 'web', authority: 'unsupported', retainedHistory: true }, licenses: ['LICENSE'] }],
    stores: [], rollback: { policy: 'compatible-retained-only', automaticSnapshotRestore: false, proof: 'fixture' },
    budgets: { npmJsonBytes: HARD_LIMITS.npmJsonBytes, metadataBytes: HARD_LIMITS.metadataBytes, manifestBytes: HARD_LIMITS.manifestBytes, outer: { ...LEGACY_LIMITS }, recursive: { unpackedBytes: LEGACY_LIMITS.unpackedBytes, entries: LEGACY_LIMITS.entries, depth: 1, diskBytes: 8 * 1024 ** 3, memoryBytes: HARD_LIMITS.memoryBytes } }, proofs: [{ name: 'fixture', status: 'verified', evidence: 'fixture' }] };
  const bytes = Buffer.from(JSON.stringify(manifest));
  await mkdir(join(config.targetRoot, 'release'), { recursive: true });
  await mkdir(config.webState, { recursive: true });
  await writeFile(join(config.targetRoot, 'release/full-release.json'), bytes);
  await writeFile(join(config.targetRoot, 'release/full-release.sig'), JSON.stringify(signBytes(bytes, privateKey, 'fixture')));
  await writeFile(join(config.targetRoot, 'release/upgrade-policy.json'), policyBytes);
  await writeFile(config.trustFile, JSON.stringify(trust), { mode: 0o600 });
  await writeFile(config.profilePath, JSON.stringify({ schemaVersion: 1, product: 'fixture', channel: 'fixture', profile: 'headless', owners: [], storeRoots: [], discoveryPatterns: [] }));
  await writeFile(join(config.webState, 'full-release-state.json'), JSON.stringify({ highestSequence: 1, manifestSha256: sha256(bytes), revocationSequence: 1, revokedKeyIds: [], revokedReleaseIds: [] }));
}
