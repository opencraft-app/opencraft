import { readFile, readdir, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function digest(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
/** All distributed browser runtimes must match the owned fork and every shipped byte. */
export async function verifyRemoteBrowserArtifact(directory, forkDefinition) {
  if (!directory) throw new Error('Set OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION to a verified owned Electron distribution; see vendor/electron/CONTAINER.md');
  if (!isAbsolute(directory)) throw new Error('Owned browser distribution must be an absolute path');
  const marker = 'opencraft-electron-artifact.json';
  let value;
  try { value = JSON.parse(await readFile(join(directory, marker), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Owned Electron artifact is missing. Supply the verified browser directory through OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION or Docker --build-context owned-electron=...; see vendor/electron/CONTAINER.md');
    throw error;
  }
  const fork = JSON.parse(await readFile(forkDefinition, 'utf8'));
  if (value.schemaVersion !== 1 || value.platform !== 'linux' || value.arch !== process.arch
    || value.forkDefinitionSha256 !== await digest(forkDefinition)
    || value.electronVersion !== fork.version || value.chromiumVersion !== fork.chromiumVersion
    || value.nativeCopyProbePassed !== true || value.nativeInputCausalityProbePassed !== true
    || value.nativeImeFocusIdentityProbePassed !== true || !Array.isArray(value.files)) throw new Error('Owned browser artifact provenance mismatch: all native input probes are required');
  const expected = new Map();
  for (const item of value.files) {
    if (!item || typeof item.path !== 'string' || item.path === marker || item.path.startsWith('/')
      || item.path.split('/').some(part => !part || part === '.' || part === '..') || item.path.includes('\\')
      || expected.has(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0)
      throw new Error('Invalid owned browser file inventory');
    expected.set(item.path, item);
  }
  for (const path of ['electron', 'chrome-sandbox', 'LICENSE', 'LICENSES.chromium.html']) if (!expected.has(path)) throw new Error('Incomplete owned browser distribution');
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await verifyRemoteBrowserArtifact(process.argv[2], process.argv[3]);
  console.log('Owned browser distribution verified');
}
