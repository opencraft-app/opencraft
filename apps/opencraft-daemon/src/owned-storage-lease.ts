import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteLifecycleError } from "@opencraft/sqlite-node";

/** All current overlay owners hold a shared lease; offline maintenance holds exclusive.
 * Older binaries do not participate: they must be stopped before maintenance.
 */
export function acquireOwnedStorageLease(directory: string, maintenance = false): () => void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, ".opencraft-owned-storage-lock.sqlite");
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.nlink !== 1) throw new Error("Storage lease must be a private regular file");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const lock = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600);
    lock.exec("PRAGMA busy_timeout=0");
    if (lock.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete") {
      throw new Error("Storage lease must use rollback journal locking");
    }
    if (!lock.prepare("SELECT 1 FROM sqlite_schema WHERE name='storage_lease'").get()) {
      lock.exec("CREATE TABLE storage_lease (id INTEGER PRIMARY KEY)");
    }
    lock.exec(maintenance ? "BEGIN EXCLUSIVE" : "BEGIN");
    lock.prepare("SELECT * FROM storage_lease").all();
  } catch (error) {
    lock.close();
    throw new SqliteLifecycleError("busy", "Owned storage is in use or its lease cannot be acquired", error);
  }
  let closed = false;
  return () => { if (!closed) { closed = true; lock.close(); } };
}
