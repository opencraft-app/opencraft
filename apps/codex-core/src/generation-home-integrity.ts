import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";

/** Read-only backup validation; never executes on the network event loop. */
export async function checkDatabases(directory: string): Promise<number> {
  if (isMainThread) throw new Error("Native HOME integrity checks require a storage Worker");
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) count += await checkDatabases(path);
    else if (entry.isFile() && /\.sqlite(?:3)?$/u.test(entry.name)) {
      const database = new DatabaseSync(path, { readOnly: true });
      try { if (!database.prepare("PRAGMA quick_check").all().every(row => Object.values(row).every(value => value === "ok"))) throw new Error("Native HOME database check failed"); }
      finally { database.close(); }
      count++;
    }
  }
  return count;
}
