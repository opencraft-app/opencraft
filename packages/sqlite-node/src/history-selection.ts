import type { DatabaseSync } from "node:sqlite";
import { SqliteLifecycleError } from "./errors.js";
import { createSchemaValidator } from "./lifecycle.js";
import { hasLedger, prepareMigrations, validateHistory, type Migration } from "./migrations.js";

/** A complete, owner-supplied append-only history. IDs are local identifiers, not database input. */
export interface MigrationHistory {
  readonly id: string;
  readonly migrations: readonly Migration[];
}

/**
 * Read-only selection for an existing ledgered database. The owner must hold its
 * writer fence through selection and the subsequent managed open, on its storage
 * worker rather than a request/event-loop thread. No migration
 * or ledger row is modified here; an unknown, empty or changed history fails closed.
 *
 * If multiple chains share the current prefix, the owner must provide a matching
 * preferred ID. This chooses a future append path, not a different interpretation
 * of any already-recorded migration.
 */
export function selectMigrationHistory(
  database: DatabaseSync,
  histories: readonly MigrationHistory[],
  preferredId?: string,
): { readonly history: MigrationHistory; readonly appliedVersion: number } {
  if (!histories.length || new Set(histories.map(history => history.id)).size !== histories.length
    || histories.some(history => !history.id)) {
    throw new SqliteLifecycleError("history-mismatch", "Invalid migration histories");
  }
  // Validate every owner manifest before observing a match; an invalid unused
  // alternative must not silently turn an ambiguous configuration into a match.
  const prepared = histories.map(history => ({ history, migrations: prepareMigrations(history.migrations) }));
  if (!hasLedger(database)) throw new SqliteLifecycleError("history-mismatch", "Database migration ledger is missing");
  const matches: Array<{ history: MigrationHistory; appliedVersion: number }> = [];
  for (const { history, migrations } of prepared) {
    let applied: number;
    try { applied = validateHistory(database, migrations); }
    catch (error) {
      if (error instanceof SqliteLifecycleError && (error.kind === "history-mismatch" || error.kind === "newer-schema")) continue;
      throw error;
    }
    if (applied === 0) continue;
    try { createSchemaValidator(migrations.slice(0, applied).map(migration => migration.sql).join(";\n"))(database); }
    catch (error) {
      if (error instanceof SqliteLifecycleError && error.kind === "history-mismatch") continue;
      throw error;
    }
    matches.push({ history, appliedVersion: applied });
  }
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1 && preferredId !== undefined) {
    const preferred = matches.find(match => match.history.id === preferredId);
    if (preferred) return preferred;
  }
  throw new SqliteLifecycleError("history-mismatch", matches.length ? "Migration history is ambiguous" : "Unknown migration history or schema");
}
