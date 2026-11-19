import { SqliteLifecycleError } from "./errors.js";
import type { MigrationHistory } from "./history-selection.js";

/**
 * Compare complete owner-supplied migration histories to an independently
 * trusted previous release. This does not authenticate either input: callers
 * must obtain the previous release through their own trusted authority.
 * Existing IDs, versions, names, and SQL bytes cannot change or disappear.
 * Adding an independent history requires an explicit opt-in; this check does
 * not prove that histories converge, that migrations are safe for existing
 * data, or that a database has the expected ledger or schema.
 */
export function assertAppendOnlyMigrationHistories(
  previous: readonly MigrationHistory[],
  candidate: readonly MigrationHistory[],
  options: { readonly allowNewHistories?: boolean } = {},
): void {
  const invalid = () => new SqliteLifecycleError("history-mismatch", "Invalid or changed published migration history");
  const validate = (histories: readonly MigrationHistory[]): Map<string, MigrationHistory> => {
    if (!Array.isArray(histories) || histories.length === 0) throw invalid();
    const result = new Map<string, MigrationHistory>();
    for (const history of histories) {
      if (
        !history ||
        typeof history.id !== "string" ||
        !history.id ||
        result.has(history.id) ||
        !Array.isArray(history.migrations) ||
        history.migrations.length === 0
      )
        throw invalid();
      for (const [index, migration] of history.migrations.entries()) {
        if (
          !migration ||
          migration.version !== index + 1 ||
          typeof migration.name !== "string" ||
          !migration.name ||
          typeof migration.sql !== "string" ||
          !migration.sql
        )
          throw invalid();
      }
      result.set(history.id, history);
    }
    return result;
  };
  const published = validate(previous);
  const proposed = validate(candidate);
  for (const [id, prior] of published) {
    const next = proposed.get(id);
    if (!next || next.migrations.length < prior.migrations.length) throw invalid();
    for (const [index, old] of prior.migrations.entries()) {
      const current = next.migrations[index]!;
      if (old.version !== current.version || old.name !== current.name || old.sql !== current.sql) throw invalid();
    }
  }
  if (options.allowNewHistories !== true && proposed.size !== published.size) throw invalid();
}
