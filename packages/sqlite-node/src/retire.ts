import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DatabaseOutcome } from "./lifecycle.js";
import { SqliteLifecycleError } from "./errors.js";
import { hasLedger, transaction } from "./migrations.js";

/** A connection opened by one owner and lent to the repositories that share its file. */
export interface BorrowedDatabase {
  readonly database: DatabaseSync;
  readonly outcome: DatabaseOutcome;
}

const RETIRED_PREFIX = "retired-into:";

/** The database a retired owner's data now lives in, or null while it is still active. */
export function retiredInto(database: DatabaseSync): string | null {
  if (!hasLedger(database)) return null;
  const row = database.prepare("SELECT name FROM schema_migrations ORDER BY version DESC LIMIT 1").get() as
    { name: string } | undefined;
  return row && row.name.startsWith(RETIRED_PREFIX) ? row.name.slice(RETIRED_PREFIX.length) : null;
}

/**
 * Close an owner's ledger after its rows were imported into `into`.
 *
 * The marker is one more ledger version, so code that still expects this file
 * refuses it as `newer-schema` instead of silently reading data that stopped
 * changing at the import. Idempotent for the same target.
 */
export function retireManagedDatabase(database: DatabaseSync, into: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(into))
    throw new SqliteLifecycleError("history-mismatch", "Invalid retirement target");
  transaction(database, () => {
    if (!hasLedger(database))
      throw new SqliteLifecycleError("history-mismatch", "Only a ledgered database can be retired");
    const current = retiredInto(database);
    if (current === into) return;
    if (current !== null)
      throw new SqliteLifecycleError("history-mismatch", "Database was already retired into another database");
    const { version } = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
      version: number;
    };
    const name = RETIRED_PREFIX + into;
    database
      .prepare("INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES(?,?,?,?)")
      .run(Number(version) + 1, name, createHash("sha256").update(name).digest("hex"), Date.now());
  });
}
