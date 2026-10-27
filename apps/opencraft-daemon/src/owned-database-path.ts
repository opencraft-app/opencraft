import { lstatSync } from "node:fs";
import { join } from "node:path";
import { SqliteLifecycleError } from "@opencraft/sqlite-node";

export const OWNED_STORAGE_MOVE_JOURNAL = ".opencraft-owned-storage-move.json";

function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new SqliteLifecycleError("io", "Cannot inspect Host database path", error);
  }
}

/** New stores use the owned name. Existing stores stay at their original path,
 * including SQLite sidecars; opening never renames, copies or merges them.
 */
export function ownedDatabasePath(directory: string, name: string, legacyName: string): string {
  if (present(join(directory, OWNED_STORAGE_MOVE_JOURNAL))) {
    throw new SqliteLifecycleError("busy", "Owned storage has unfinished offline maintenance; resume the storage move before opening it");
  }
  const current = join(directory, name), legacy = join(directory, legacyName);
  const hasCurrent = present(current), hasLegacy = present(legacy);
  if (hasCurrent && hasLegacy) {
    throw new SqliteLifecycleError("unsupported-legacy", "Both current and legacy Host database files exist; refusing to choose a store");
  }
  for (const [path, exists] of [[current, hasCurrent], [legacy, hasLegacy]] as const) {
    if (!exists && ["-wal", "-shm", "-journal"].some(suffix => present(path + suffix))) {
      throw new SqliteLifecycleError("unsupported-legacy", "Host database sidecars exist without their database; refusing to create a replacement");
    }
  }
  return hasLegacy ? legacy : current;
}
