import { scopedSqlDatabase, type SqlDatabase } from "@opencraft/sql";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { nodeSqlDatabase, openManagedDatabase, SqliteLifecycleError, type DatabaseOutcome } from "@opencraft/sqlite-node";
import { serverLegacyOptions, type ServerStoreId } from "./legacy.js";

/** An owner's open Server installation, lent through the runtime-neutral SQL port. */
export interface ServerDatabaseHandle {
  readonly database: SqlDatabase;
  readonly outcome: DatabaseOutcome;
  /**
   * File of a Node-owned installation. Only Node compositions use it, to start
   * companion Workers on the same file; the SQL port itself has no location.
   */
  readonly location?: string;
}
/** A trusted owner lends its connection; repositories never close borrowed handles. */
export type ServerDatabaseSource = string | ServerDatabaseHandle;
export interface ServerRepository {
  readonly database: SqlDatabase;
  readonly outcome: DatabaseOutcome;
  /** Node file backing this repository, when there is one (see ServerDatabaseHandle.location). */
  readonly location?: string;
  close(): void;
}
export function openServerRepository(source: ServerDatabaseSource, store: ServerStoreId): ServerRepository {
  if (typeof source !== "string") {
    const lease = scopedSqlDatabase(source.database, "Server repository");
    return { database: lease.database, outcome: source.outcome, ...(source.location ? { location: source.location } : {}), close: lease.close };
  }
  if (source !== ":memory:" && (existsSync(join(dirname(source), "opencraft-server.sqlite")) || existsSync(join(dirname(source), ".server-import")))) {
    throw new SqliteLifecycleError("unsupported-legacy", "Server data is consolidated; use the Server storage owner");
  }
  const managed = openManagedDatabase({ path: source, ...serverLegacyOptions(store) });
  const location = managed.database.location() ?? undefined;
  return { database: nodeSqlDatabase(managed.database), outcome: managed.outcome, ...(location ? { location } : {}), close() { managed.database.close(); } };
}
