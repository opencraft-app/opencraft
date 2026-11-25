import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function ifPresent(operation) {
  try { return operation(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function directoryEntries(path) {
  if (!ifPresent(() => lstatSync(path))?.isDirectory()) return [];
  if (realpathSync(path) !== path) throw new Error(`Unsafe runtime lock directory: ${path}`);
  return readdirSync(path, { withFileTypes: true });
}

/** Only paths converted by the directory-lease to SQLite transition. Permanent
 * writer locks elsewhere (including hub-network.json.lock) keep their inodes. */
function convertedLocks(role, root) {
  if (role === 'hands') return [join(root, 'terminal.lock')];
  const paths = [
    'native-host.lock', '.personal-assistant-host.lock',
    'agent/.daemon-storage-owner.lock', 'hub-network.json.state-lock', 'server-information.json.lock',
  ].map(path => join(root, path));
  for (const name of ['models', 'pi', 'projects']) {
    const directory = join(root, name);
    for (const entry of directoryEntries(directory))
      if (entry.name.endsWith('.json.lock')) paths.push(join(directory, entry.name));
  }
  const workspaces = join(root, 'workspaces');
  for (const entry of directoryEntries(workspaces))
    if (entry.isDirectory()) paths.push(join(workspaces, entry.name, 'host', 'placement.json.lock'));
  const bots = join(root, 'bots');
  for (const entry of directoryEntries(bots))
    if (entry.isDirectory()) paths.push(join(bots, entry.name + '.lock'));
  return paths;
}

function checkFile(path, info, maxSize) {
  if (!info.isFile() || info.nlink !== 1 || info.size > maxSize
    || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid())
    throw new Error(`Unexpected runtime lock file: ${path}`);
}

function claimLock(path, info) {
  if (realpathSync(dirname(path)) !== dirname(path)) throw new Error(`Unsafe runtime lock directory: ${dirname(path)}`);
  checkFile(path, info, 0);
  const marker = path + '.owner.json';
  const owner = ifPresent(() => lstatSync(marker));
  if (owner) {
    checkFile(marker, owner, 4096);
    const data = JSON.parse(readFileSync(marker, 'utf8'));
    if (data.version !== 1 || typeof data.released !== 'boolean') throw new Error(`Invalid runtime lock owner: ${marker}`);
  }
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    const current = lstatSync(path);
    if (current.dev !== info.dev || current.ino !== info.ino) throw new Error(`Runtime lock changed: ${path}`);
    return { path, marker: owner ? marker : undefined, db };
  } catch (error) {
    db.close();
    throw new Error(`Runtime lock could not be reserved for rollback: ${path}`, { cause: error });
  }
}

/** Called only after all Compose owners have stopped. Keep a SQLite claim
 * on each inode until it is archived, including after a crash left a marker. */
export function archiveRuntimeLocks(role, root) {
  if (!['gateway', 'hands'].includes(role) || !isAbsolute(root ?? '') || root === '/'
    || resolve(root) !== root || realpathSync(root) !== root)
    throw new Error('Invalid runtime lock root for rollback');
  const claims = [];
  try {
    for (const path of convertedLocks(role, root)) {
      const info = ifPresent(() => lstatSync(path));
      if (info && !info.isDirectory()) claims.push(claimLock(path, info));
    }
    for (const { path, marker } of claims) {
      // Keep the archive on the lock's own filesystem, including nested binds.
      const archive = mkdtempSync(join(dirname(path), '.opencraft-lock-rollback-'));
      if (marker) renameSync(marker, join(archive, basename(marker)));
      renameSync(path, join(archive, basename(path)));
    }
    return claims.length;
  } finally {
    for (const { db } of claims) db.close();
  }
}

if (process.argv[1] === '-') {
  const role = process.argv[2];
  const root = role === 'hands' ? process.env.OPENCRAFT_EXECUTION_DIR : process.env.OPENCRAFT_DATA_DIR;
  const count = archiveRuntimeLocks(role, root);
  if (count) console.log(`Archived ${count} released ${role} runtime locks for rollback.`);
}
