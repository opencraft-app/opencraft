import { DatabaseSync } from 'node:sqlite';
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync, fsyncSync } from 'node:fs';
import { lstat, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

interface Owner { version: 1; pid: number; boot: string; start: string; claim: string; released: boolean; }
function identity(pid: number): Pick<Owner, 'boot' | 'start'> | null {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] === 'Z' || fields[0] === 'X') return null;
      return { boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), start: fields[19]! };
    } catch (error) { if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code!)) return null; throw error; }
  }
  try { process.kill(pid, 0); return { boot: process.platform, start: 'unknown' }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return null; throw error; }
}
function readOwner(path: string): Owner | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    // Windows reports no POSIX modes (0o666); the user's profile protects the file there.
    if (!info.isFile() || info.size > 4096 || (process.platform !== 'win32' && (info.mode & 0o077))) throw Error('Invalid writer owner file');
    const owner = JSON.parse(readFileSync(fd, 'utf8')) as Owner;
    if (owner.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.boot !== 'string'
      || typeof owner.start !== 'string' || typeof owner.claim !== 'string' || typeof owner.released !== 'boolean') throw Error('Invalid writer owner identity');
    return owner;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function saveOwner(path: string, owner: Owner) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { writeFileSync(fd, JSON.stringify(owner)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    // Windows cannot open or fsync a directory; NTFS journals the rename itself.
    if (process.platform !== 'win32') { const directory = openSync(dirname(path), constants.O_RDONLY); try { fsyncSync(directory); } finally { closeSync(directory); } }
  } finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
}

/** One kernel-owned writer for the entire store lifetime. The inode is permanent:
 * SIGKILL releases SQLite's OS lock, and a paused live owner never expires.
 * Reuse the old lease pathname as a regular file so legacy mkdir/rmdir lockers
 * cannot acquire or remove it. An existing legacy directory must be released by
 * its owner; age alone never authorizes converting it.
 */
export function acquireProcessWriter(path: string): () => void {
  if (!isAbsolute(path)) throw Error('Writer lock requires an absolute path');
  let database: DatabaseSync | undefined;
  const ownerPath = `${path}.owner.json`;
  try {
    // Closing an arbitrary descriptor to an existing SQLite inode can release
    // this process's POSIX locks. Only SQLite may open/close an existing lock.
    try { const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); closeSync(fd); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = lstatSync(path);
    // Windows has no POSIX modes or owners (files report 0o666); its ACLs and the user's profile protect the lock.
    const posixPrivate = process.platform === 'win32' || (!(info.mode & 0o077) && !(process.getuid && info.uid !== process.getuid()));
    if (!info.isFile() || !posixPrivate) throw Error('Writer lock must be a private regular file');
    database = new DatabaseSync(path);
    database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    const previous = readOwner(ownerPath);
    if (previous && !previous.released) {
      const observed = identity(previous.pid);
      if (observed?.boot === previous.boot && observed.start === previous.start)
        throw Error(`Writer owner ${previous.pid} is still alive`);
    }
    const owner: Owner = { version: 1, pid: process.pid, ...identity(process.pid)!, claim: randomUUID(), released: false };
    saveOwner(ownerPath, owner);
    const held = database;
    let released = false;
    return () => {
      if (released) return;
      try {
        const current = readOwner(ownerPath);
        if (current && current.claim !== owner.claim) throw Error('Writer identity changed before release');
        // The enclosing disposable data root may already have been removed.
        // Never recreate it, overwrite another claim or unlink the lock inode.
        if (current) saveOwner(ownerPath, { ...owner, released: true });
      } finally { held.close(); released = true; }
    };
  } catch (cause) {
    database?.close();
    throw Object.assign(new Error('Writer lock is already being held or ownership cannot be verified', { cause }), { code: 'ELOCKED', file: path });
  }
}

/** Earlier releases leased an owner path as a proper-lockfile directory that a live
 * holder refreshed every 5s and any contender reclaimed once its mtime was 10s old. */
export const LEGACY_OWNER_LEASE_EXPIRED_MS = 60_000;

/** A process-lifetime owner lock at a pathname older releases leased with proper-lockfile.
 * The kernel writer never expires while the owner process is alive, however long its
 * event loop stalls, and process death releases it; there is no refresh timer whose
 * failure could surface as an uncaught `ECOMPROMISED`. The pathname becomes a regular
 * file, so older mkdir lockers can neither acquire nor remove it. A legacy lease
 * directory is converted only once its mtime is far older than any refresh a live
 * holder would make; a fresh one is refused like any live writer (`ELOCKED`).
 * `retries` counts further attempts against a live writer, one second apart. */
export async function acquireOwnerLock(path: string, { retries = 0 }: { retries?: number } = {}): Promise<() => void> {
  for (let attempt = 0; ; attempt++) {
    try { return acquireProcessWriter(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error;
      const legacy = await lstat(path).catch(() => undefined);
      // rmdir never removes a regular-file lock; a legacy locker that recreates the
      // directory first keeps it, and the next attempt refuses again.
      if (legacy?.isDirectory() && legacy.mtimeMs < Date.now() - LEGACY_OWNER_LEASE_EXPIRED_MS
        && await rmdir(path).then(() => true, () => false)) continue;
      if (attempt >= retries) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
