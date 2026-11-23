import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, cpSync, existsSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
export const roles = ['gateway', 'brain', 'hands', 'proxy'];
const dockerDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../deploy/docker');
export const defaultTemplate = join(dockerDirectory, 'deploy');
// The deployment model itself: exported byte for byte from deploy/docker, never from a
// template, so a portable bundle and a source deployment cannot drift apart.
export const coreComposeFiles = { 'compose.yaml': join(dockerDirectory, 'compose.yaml'), 'compose.role-images.yaml': join(dockerDirectory, 'compose.role-images.yaml') };
export const templateFiles = ['compose.portable.yaml', 'compose.root-hands.yaml', 'compose.personal-git.yaml', 'deploy.py', 'files-smoke.mjs', 'workspace-preflight.mjs', 'site.env.example', 'README.md'];
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
// A product may supply its own template directory (with every standard template file) and
// copy additional top-level files from it; the generated lock files stay reserved.
export function exportDeployment(snapshot, output, { template = defaultTemplate, include = [] } = {}) {
  const refs = imageReferences(snapshot);
  assert.equal(typeof template, 'string', 'Template directory must be a path');
  for (const file of include) {
    assert.ok(typeof file === 'string' && file && basename(file) === file && file !== '..' && file !== '.', 'Extra deployment file must be a plain file name: ' + file);
    assert.ok(![...templateFiles, ...Object.keys(coreComposeFiles), 'images.env', 'release.json'].includes(file), 'Extra deployment file is already exported: ' + file);
  }
  assert.equal(new Set(include).size, include.length, 'Duplicate extra deployment file');
  for (const file of Object.keys(coreComposeFiles))
    assert.ok(!existsSync(join(template, file)), `${file} comes from core deploy/docker; remove it from the template and put site changes in compose.portable.yaml`);
  // Exclusive directory creation: never overwrite an operator's site.env/data.
  mkdirSync(output, { mode: 0o700 });
  for (const [file, source] of Object.entries(coreComposeFiles)) cpSync(source, join(output, file));
  for (const file of [...templateFiles, ...include]) cpSync(join(template, file), join(output, file));
  writeFileSync(join(output, 'images.env'), roles.map(role => `OPENCRAFT_${role.toUpperCase()}_IMAGE=${refs[role]}`).join('\n') + '\n', { mode: 0o600 });
  writeFileSync(join(output, 'release.json'), JSON.stringify({ schemaVersion: 1, images: refs,
    sourceRevision: snapshot.sourceRevision ?? null, sourceReleaseId: snapshot.releaseId ?? null }, null, 2) + '\n', { mode: 0o600 });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const usage = 'Usage: node scripts/ci/export-deployment.mjs [--template DIR] [--include FILE]... SNAPSHOT_OR_ROLE_DIGESTS_JSON NEW_OUTPUT_DIR';
  const { values, positionals } = parseArgs({ allowPositionals: true,
    options: { template: { type: 'string' }, include: { type: 'string', multiple: true } } });
  assert.equal(positionals.length, 2, usage);
  exportDeployment(JSON.parse(readFileSync(positionals[0], 'utf8')), resolve(positionals[1]), {
    template: values.template === undefined ? defaultTemplate : resolve(values.template), include: values.include ?? [] });
}
