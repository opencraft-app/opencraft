import { DatabaseSync } from "node:sqlite";
import { closeSync, constants, lstatSync, openSync, rmdirSync } from "node:fs";
import { serveWorkerOwner } from "@opencraft/worker-owner/serve";
import { acquireProcessWriter, LEGACY_OWNER_LEASE_EXPIRED_MS } from "./writer-lock.js";

/**
 * Holds kernel locks for callers whose event loop must not do synchronous IO
 * (see `locks.ts`). Every lock dies with this Worker or the process. Attempts
 * never wait here; callers retry, so one busy lock never delays another.
 * Earlier releases leased these paths as proper-lockfile directories that a
 * live holder refreshed every few seconds; one older than
 * LEGACY_OWNER_LEASE_EXPIRED_MS belongs to nobody and is converted.
 */
serveWorkerOwner(() => {
  const held = new Map<number, () => void>();
  let sequence = 0;
  const hold = (release: () => void) => (held.set(++sequence, release), sequence);
  /** Removes an expired legacy lease directory; false while one is still fresh.
   * rmdir never removes a lock file, and a legacy locker that recreates the
   * directory keeps it. */
  const clearLegacy = (path: string): boolean => {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info?.isDirectory()) return true;
    if (info.mtimeMs >= Date.now() - LEGACY_OWNER_LEASE_EXPIRED_MS) return false;
    try {
      rmdirSync(path);
      return true;
    } catch {
      return false;
    }
  };
  /** Creates a short lock's file once. Closing a descriptor to an inode SQLite
   * already locks would drop this process's POSIX locks, so an existing file is
   * only ever opened by SQLite. */
  const prepare = (path: string): boolean => {
    if (!clearLegacy(path)) return false;
    try {
      closeSync(openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = lstatSync(path);
    if (info.isDirectory()) return false; // A legacy locker recreated it.
    // Windows has no POSIX modes or owners; the user's profile protects the file there.
    const foreign =
      process.platform !== "win32" &&
      ((info.mode & 0o077) !== 0 || (process.getuid !== undefined && info.uid !== process.getuid()));
    if (!info.isFile() || foreign) throw new Error("Lock must be a private regular file");
    return true;
  };
  return {
    methods: {
      /** A short exclusive lock: a SQLite exclusive transaction on a permanent
       * private file. A token, or null while another holder has it. */
      exclusive(path: string): number | null {
        if (!prepare(path)) return null;
        const database = new DatabaseSync(path);
        try {
          database.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
        } catch (error) {
          database.close();
          if ((error as { errcode?: number }).errcode === 5) return null; // SQLITE_BUSY
          throw error;
        }
        return hold(() => database.close());
      },
      /** One `acquireOwnerLock` attempt: a token, or null while a live owner (or
       * a fresh legacy lease) holds the path. */
      owner(path: string): number | null {
        for (let attempt = 0; ; attempt++) {
          try {
            return hold(acquireProcessWriter(path));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
            const info = lstatSync(path, { throwIfNoEntry: false });
            if (attempt > 0 || !info?.isDirectory() || !clearLegacy(path)) return null;
          }
        }
      },
      release(token: number): void {
        const release = held.get(token);
        held.delete(token);
        release?.();
      },
    },
    close() {
      for (const release of held.values()) release();
      held.clear();
    },
  };
});
