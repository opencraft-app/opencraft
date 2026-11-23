import type { SqlDatabase } from "@opencraft/sql";

/**
 * A stored record as the owner returns it. `selection` is the JSON value written by the
 * caller after it validated the selection at its own boundary; readers validate it again.
 */
export interface StoredAccountModelDefaults {
  readonly revision: number;
  readonly selection: unknown;
}

export interface AccountModelDefaultsMethods {
  /** Revision 0 and a null selection when the Actor has no record for this Host. */
  readAccountModelDefaults(actorId: string, hostId: string): StoredAccountModelDefaults;
  /**
   * Replaces the record only while it is still at `revision`. A stale revision leaves
   * the record unchanged and returns the current one with `updated: false`.
   */
  compareAndSetAccountModelDefaults(
    actorId: string,
    hostId: string,
    revision: number,
    selection: unknown,
  ): { readonly updated: boolean; readonly record: StoredAccountModelDefaults };
}

const FORMAT = 1;

function key(actorId: unknown, hostId: unknown): void {
  if (typeof actorId !== "string" || !actorId || actorId.length > 512) throw new Error("Invalid model defaults Actor");
  if (typeof hostId !== "string" || !hostId.trim() || hostId.length > 512)
    throw new Error("Invalid model defaults Host");
}

/** Invoked only in the Server owner Worker; the network thread reaches it through async calls. */
export function accountModelDefaultsMethods(db: SqlDatabase): AccountModelDefaultsMethods {
  const read = db.prepare(
    "SELECT revision, format, selection FROM account_model_defaults WHERE actor_id=? AND host_id=?",
  );
  const insert =
    db.prepare(`INSERT INTO account_model_defaults(actor_id, host_id, revision, format, selection, updated_at)
    VALUES(?, ?, 1, ?, ?, ?) ON CONFLICT(actor_id, host_id) DO NOTHING`);
  const update = db.prepare(`UPDATE account_model_defaults SET revision=revision+1, selection=?, updated_at=?
    WHERE actor_id=? AND host_id=? AND revision=? AND format=?`);

  const current = (actorId: string, hostId: string): StoredAccountModelDefaults => {
    key(actorId, hostId);
    const row = read.get(actorId, hostId);
    if (!row) return { revision: 0, selection: null };
    // A newer owner's format is never reinterpreted or overwritten by this one.
    if (row.format !== FORMAT || typeof row.revision !== "number" || typeof row.selection !== "string")
      throw new Error("Unsupported model defaults format");
    return { revision: row.revision, selection: JSON.parse(row.selection) };
  };

  return {
    readAccountModelDefaults: current,
    compareAndSetAccountModelDefaults(actorId, hostId, revision, selection) {
      key(actorId, hostId);
      if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid model defaults revision");
      if (selection === null || typeof selection !== "object" || Array.isArray(selection))
        throw new Error("Invalid model selection");
      const value = JSON.stringify(selection);
      if (value.length > 4096) throw new Error("Invalid model selection");
      // Reject an unknown stored format before attempting to replace it.
      current(actorId, hostId);
      const now = Date.now();
      const changes =
        revision === 0
          ? insert.run(actorId, hostId, FORMAT, value, now).changes
          : update.run(value, now, actorId, hostId, revision, FORMAT).changes;
      return { updated: Number(changes) === 1, record: current(actorId, hostId) };
    },
  };
}
