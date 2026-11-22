import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export const roles = ['gateway', 'brain', 'hands', 'proxy'];
export function imageReferences(snapshot) {
  const source = snapshot.images ?? snapshot;
  return Object.fromEntries(roles.map(role => {
    const value = source[role];
    const ref = typeof value === 'string' ? value : value?.ref;
    assert.match(ref ?? '', /^[a-z0-9][a-z0-9.:-]*\/[a-zA-Z0-9._/-]+@sha256:[a-f0-9]{64}$/, 'Missing immutable registry digest: ' + role);
    if (value?.platform) assert.deepEqual(value.platform, { Os: 'linux', Architecture: 'amd64' }, 'Unsupported platform: ' + role);
    return [role, ref];
  }));
}
export function exportDeployment(snapshot, output) {
  const refs = imageReferences(snapshot);
  // Exclusive directory creation: never overwrite an operator's site.env/data.
  mkdirSync(output, { mode: 0o700 });
  const template = resolve(dirname(fileURLToPath(import.meta.url)), '../../deploy/docker/deploy');
  for (const file of ['compose.yaml', 'compose.root-hands.yaml', 'compose.personal-git.yaml', 'deploy.py', 'files-smoke.mjs', 'workspace-preflight.mjs', 'site.env.example', 'README.md']) cpSync(join(template, file), join(output, file));
  writeFileSync(join(output, 'images.env'), roles.map(role => `OPENCRAFT_${role.toUpperCase()}_IMAGE=${refs[role]}`).join('\n') + '\n', { mode: 0o600 });
  writeFileSync(join(output, 'release.json'), JSON.stringify({ schemaVersion: 1, images: refs,
    sourceRevision: snapshot.sourceRevision ?? null, sourceReleaseId: snapshot.releaseId ?? null }, null, 2) + '\n', { mode: 0o600 });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv.length, 4, 'Usage: node scripts/ci/export-deployment.mjs SNAPSHOT_OR_ROLE_DIGESTS_JSON NEW_OUTPUT_DIR');
  exportDeployment(JSON.parse(readFileSync(process.argv[2], 'utf8')), resolve(process.argv[3]));
}
