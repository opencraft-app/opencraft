import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

async function optionalJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

/** Fingerprint the actual npm installation, not a stale standalone lab lock.
 * Archive names stay within the evidence directory even for ancestor manifests.
 * Missing/foreign/malformed lockfiles are not silently omitted from run identity.
 */
export async function installationManifests(root) {
  root = resolve(root);
  const own = await optionalJson(join(root, 'package.json'));
  if (typeof own?.name !== 'string' || !own.name) throw Error('Missing package identity');
  let local;
  for (let directory = root;; directory = dirname(directory)) {
    const manifest = directory === root ? own : await optionalJson(join(directory, 'package.json'));
    const lock = await optionalJson(join(directory, 'package-lock.json'));
    const key = relative(directory, root).split('\\').join('/');
    if (lock?.packages?.[key]?.name === own.name) {
      if (directory === root) local = directory;
      else if (manifest?.workspaces) return records(directory);
    }
    if (directory === dirname(directory)) break;
  }
  if (local) return records(local);
  throw Error('No installation lockfile binds this package');

  async function records(directory) {
    const files = [{ file: 'package.json', sourceFile: 'package.json' }];
    if (directory !== root) files.push({ file: 'installation/package.json', sourceFile: relative(root, join(directory, 'package.json')).split('\\').join('/') });
    files.push({ file: directory === root ? 'package-lock.json' : 'installation/package-lock.json', sourceFile: relative(root, join(directory, 'package-lock.json')).split('\\').join('/') });
    return Promise.all(files.map(async entry => ({ ...entry, kind: 'dependency', sha256: createHash('sha256').update(await readFile(join(root, entry.sourceFile))).digest('hex') })));
  }
}
