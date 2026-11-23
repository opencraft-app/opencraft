import { scopedSqlDatabase, type SqlDatabase } from "@opencraft/sql";
import type { DatabaseOutcome } from "@opencraft/sqlite-node";

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

/** Runtime-neutral half of openServerRepository: borrow an owner's handle, never open a file. */
export function borrowServerRepository(source: ServerDatabaseHandle): ServerRepository {
  const lease = scopedSqlDatabase(source.database, "Server repository");
  return {
    database: lease.database,
    outcome: source.outcome,
    ...(source.location ? { location: source.location } : {}),
    close: lease.close,
  };
}
