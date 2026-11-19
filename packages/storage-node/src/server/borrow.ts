import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { SERVER_DATA_CONTRACT } from "./index.js";
import type { ServerDatabaseSource } from "./repository.js";

/** A child process borrows an already migrated installation. It cannot bootstrap,
 * import, acquire ownership, or recover its parent's database. */
export function borrowServerDatabase(directory: string): Exclude<ServerDatabaseSource, string> & { close(): void } {
  const db = new DatabaseSync(join(directory, "opencraft-server.sqlite"), { open: false });
  // Never create an empty installation when the owning process has not prepared it.
  const probe = new DatabaseSync(join(directory, "opencraft-server.sqlite"), { readOnly: true });
  try {
    const version = Number(probe.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version);
    if (version !== SERVER_DATA_CONTRACT.migrationVersion)
      throw Error("Server storage owner must migrate before borrowing");
    if (probe.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal")
      throw Error("Borrowed Server storage requires WAL");
  } finally {
    probe.close();
  }
  try {
    db.open();
    db.exec("PRAGMA foreign_keys=ON");
    return {
      database: db,
      outcome: { status: "up-to-date", appliedVersion: SERVER_DATA_CONTRACT.migrationVersion, movedAsidePaths: [] },
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
