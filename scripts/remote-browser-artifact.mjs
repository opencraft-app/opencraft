import { readFile, readdir, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

async function digest(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
/** An explicitly selected owned runtime must match this exact fork definition
 * and every shipped byte. A stale/incomplete artifact never falls back to stock. */
export async function verifyRemoteBrowserArtifact(directory, forkDefinition) {
  if (!isAbsolute(directory)) throw new Error('Owned browser distribution must be an absolute path');
  const marker = 'opencraft-electron-artifact.json';
  const value = JSON.parse(await readFile(join(directory, marker), 'utf8'));
  const fork = JSON.parse(await readFile(forkDefinition, 'utf8'));
  if (value.schemaVersion !== 1 || value.platform !== 'linux' || value.arch !== process.arch
    || value.forkDefinitionSha256 !== await digest(forkDefinition)
    || value.electronVersion !== fork.version || value.chromiumVersion !== fork.chromiumVersion
    || value.nativeCopyProbePassed !== true || !Array.isArray(value.files)) throw new Error('Owned browser artifact provenance mismatch');
  const expected = new Map();
  for (const item of value.files) {
    if (!item || typeof item.path !== 'string' || item.path === marker || item.path.startsWith('/')
      || item.path.split('/').some(part => !part || part === '.' || part === '..') || item.path.includes('\\')
      || expected.has(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0)
      throw new Error('Invalid owned browser file inventory');
    expected.set(item.path, item);
  }
  for (const path of ['electron', 'LICENSE', 'LICENSES.chromium.html']) if (!expected.has(path)) throw new Error('Incomplete owned browser distribution');
  async function check(prefix = '') {
    for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (relative === marker) continue;
      if (entry.isDirectory()) { await check(relative + '/'); continue; }
      const item = expected.get(relative), stat = await lstat(join(directory, relative));
      if (!entry.isFile() || !item || stat.size !== item.size || await digest(join(directory, relative)) !== item.sha256)
        throw new Error('Owned browser distribution checksum mismatch');
      if (relative === 'electron' && !(stat.mode & 0o111)) throw new Error('Owned browser is not executable');
      expected.delete(relative);
    }
  }
  await check();
  if (expected.size) throw new Error('Owned browser distribution has missing files');
  return directory;
}
