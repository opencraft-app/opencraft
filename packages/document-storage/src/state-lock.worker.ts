import { DatabaseSync } from "node:sqlite";
import { closeSync, constants, lstatSync, openSync, rmdirSync } from "node:fs";
import { serveWorkerOwner } from "@opencraft/worker-owner/serve";

/** Earlier releases leased `<file>.lock` as a proper-lockfile directory whose holder
 * refreshed it every 5s; one this much older belongs to nobody. */
const LEGACY_LEASE_EXPIRED_MS = 60_000;

/**
 * Holds the kernel locks behind state document updates, off the caller's event
 * loop. A lock is a SQLite exclusive transaction on a permanent private file:
 * the kernel releases it when this process dies, and it never expires while the
 * process lives, however long its event loop stalls. Attempts never wait here;
 * the caller retries, so one busy file never delays another.
 */
serveWorkerOwner(() => {
  const held = new Map<number, DatabaseSync>();
  let sequence = 0;
  /** Creates the lock file once. Closing a descriptor to an inode SQLite already
   * locks would drop this process's POSIX locks, so an existing file is only
   * ever opened by SQLite. */
  const prepare = (path: string): boolean => {
    try {
      closeSync(openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = lstatSync(path);
    if (info.isDirectory()) {
      // rmdir never removes a lock file; a legacy locker that recreates the
      // directory keeps it, and this attempt reports the file as busy.
      if (info.mtimeMs >= Date.now() - LEGACY_LEASE_EXPIRED_MS) return false;
      try {
        rmdirSync(path);
      } catch {
        return false;
      }
      return prepare(path);
    }
    // Windows has no POSIX modes or owners; the user's profile protects the file there.
    const foreign =
      process.platform !== "win32" &&
      ((info.mode & 0o077) !== 0 || (process.getuid !== undefined && info.uid !== process.getuid()));
    if (!info.isFile() || foreign) throw new Error("State document lock must be a private regular file");
    return true;
  };
  return {
    methods: {
      /** A token for the held lock, or null while another holder has it. */
      acquire(path: string): number | null {
        if (!prepare(path)) return null;
        const database = new DatabaseSync(path);
        try {
          database.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
        } catch (error) {
          database.close();
          if ((error as { errcode?: number }).errcode === 5) return null; // SQLITE_BUSY
          throw error;
        }
        held.set(++sequence, database);
        return sequence;
      },
      release(token: number): void {
        const database = held.get(token);
        held.delete(token);
        database?.close();
      },
    },
    close() {
      for (const database of held.values()) database.close();
      held.clear();
    },
  };
});
