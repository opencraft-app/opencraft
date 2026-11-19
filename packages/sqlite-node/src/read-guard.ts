import type { DatabaseSync } from 'node:sqlite';

/** Process-local proof on an existing owner's connection. Never an authority token.
 * The owner must invalidate isCurrent before close/reopen or callback replacement.
 * An active transaction cannot prove that external commits have remained stable.
 */
export function captureSqliteReadGuard(database: DatabaseSync, isCurrent: () => boolean): (() => boolean) | null {
  const read = () => {
    if (!isCurrent() || database.isTransaction) return null;
    const version = database.prepare('PRAGMA data_version').get()!.data_version;
    const statement = database.prepare('SELECT total_changes() AS changes');
    statement.setReadBigInts(true);
    const changes = statement.get()!.changes;
    return !database.isTransaction && isCurrent() ? { version, changes } : null;
  };
  try {
    const initial = read();
    if (!initial) return null;
    // Once invalid, a proof must never become valid again (including ABA).
    let invalid = false;
    return () => {
      if (invalid) return false;
      try {
        const current = read();
        invalid = !current || current.version !== initial.version || current.changes !== initial.changes;
      } catch { invalid = true; }
      return !invalid;
    };
  } catch { return null; }
}
