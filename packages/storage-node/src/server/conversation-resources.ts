import type { SqlDatabase } from "@opencraft/sql";

/** One acknowledged lifecycle observation of a conversation's resources. */
export interface ConversationResourceRow {
  readonly hostId: string;
  readonly threadId: string;
  readonly state: "active" | "archived" | "deleted";
  readonly generation: number;
  /** Resource owners whose cleanup for this generation is not yet acknowledged. */
  readonly pending: readonly string[];
}

/** The retired journal as the owner found it: absent, or its exact bytes and digest. */
export type ConversationResourceLegacySource =
  { readonly kind: "absent" } | { readonly kind: "present"; readonly sha256: string; readonly text: string };

/** Reads the retired journal. Supplied only by the Node owner; it never writes it. */
export interface ConversationResourceLegacyJournal {
  readonly name: string;
  read(): ConversationResourceLegacySource;
}

export interface ConversationResourceMethods {
  /**
   * Imports the retired journal once, then returns every committed row. Rows
   * naming an owner outside `owners` are refused, as the journal refused them.
   */
  openConversationResources(input: { owners: readonly string[] }): ConversationResourceRow[];
  /** Commits rows in one transaction. A row never moves to an older generation. */
  putConversationResources(rows: readonly ConversationResourceRow[]): void;
}

const STATES = new Set(["active", "archived", "deleted"]);
const valid = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1024;

/** The record shape the journal accepted; `owners` limits pending names. */
export function conversationResourceRow(value: unknown, owners: ReadonlySet<string>): ConversationResourceRow {
  const row = value as Record<string, unknown> | null;
  if (
    !row ||
    typeof row !== "object" ||
    !valid(row.hostId) ||
    !valid(row.threadId) ||
    typeof row.state !== "string" ||
    !STATES.has(row.state) ||
    !Number.isSafeInteger(row.generation) ||
    (row.generation as number) < 1 ||
    !Array.isArray(row.pending) ||
    row.pending.some((name) => typeof name !== "string" || !owners.has(name))
  )
    throw new Error("Invalid conversation resource record");
  return {
    hostId: row.hostId,
    threadId: row.threadId,
    state: row.state as ConversationResourceRow["state"],
    generation: row.generation as number,
    pending: [...(row.pending as string[])],
  };
}

/**
 * The conversation resource lifecycle's durable rows in the Server core
 * (InstallationCore). Runs only on the owner connection; the network thread
 * holds the committed projection and calls these through the owner port.
 */
export function conversationResourceMethods(
  db: SqlDatabase,
  legacy?: ConversationResourceLegacyJournal,
): ConversationResourceMethods {
  const all = db.prepare("SELECT host_id, thread_id, state, generation, pending FROM conversation_resources");
  const insert = db.prepare(
    "INSERT INTO conversation_resources(host_id, thread_id, state, generation, pending) VALUES(?, ?, ?, ?, ?)",
  );
  // Writers are serialized by the network thread; the guard keeps a stale
  // write from ever replacing a newer generation.
  const upsert = db.prepare(`INSERT INTO conversation_resources(host_id, thread_id, state, generation, pending)
    VALUES(?, ?, ?, ?, ?) ON CONFLICT(host_id, thread_id) DO UPDATE SET
      state=excluded.state, generation=excluded.generation, pending=excluded.pending
    WHERE excluded.generation >= conversation_resources.generation`);
  const receipt = db.prepare("SELECT sha256 FROM conversation_resource_imports WHERE source=?");
  const record = db.prepare(
    "INSERT INTO conversation_resource_imports(source, sha256, rows, imported_at) VALUES(?, ?, ?, ?)",
  );

  const importLegacy = (owners: ReadonlySet<string>) => {
    if (!legacy) return;
    const source = legacy.read();
    const digest = source.kind === "present" ? source.sha256 : "absent";
    const prior = receipt.get(legacy.name);
    if (prior) {
      // The journal is never written after import. Different bytes, or a
      // journal appearing after an import that found none, mean an older
      // writer ran against it (for example after a rollback); merging would
      // let it overwrite newer committed generations. Removing the kept
      // backup is an ordinary operator action and carries no such evidence.
      if (source.kind === "present" && prior.sha256 !== digest)
        throw new Error(
          `Conversation resource journal ${legacy.name} changed after its import; resolve it before starting`,
        );
      return;
    }
    let rows: ConversationResourceRow[] = [];
    if (source.kind === "present") {
      let saved: { version?: unknown; rows?: unknown };
      try {
        saved = JSON.parse(source.text);
      } catch {
        throw new Error("Invalid conversation resource journal");
      }
      if (!saved || saved.version !== 1 || !Array.isArray(saved.rows))
        throw new Error("Invalid conversation resource journal");
      // The journal kept one record per key; a later duplicate replaced an earlier one.
      const byKey = new Map<string, ConversationResourceRow>();
      for (const value of saved.rows) {
        const row = conversationResourceRow(value, owners);
        byKey.set(JSON.stringify([row.hostId, row.threadId]), row);
      }
      rows = [...byKey.values()];
    }
    db.transaction(() => {
      if (receipt.get(legacy.name)) throw new Error("Conversation resource import raced");
      if (rows.length && all.get()) throw new Error("Conversation resources exist without an import receipt");
      for (const row of rows)
        insert.run(row.hostId, row.threadId, row.state, row.generation, JSON.stringify(row.pending));
      record.run(legacy.name, digest, rows.length, Date.now());
    });
  };

  return {
    openConversationResources({ owners }) {
      if (!Array.isArray(owners) || owners.some((name) => typeof name !== "string" || !name))
        throw new Error("Invalid resource owners");
      const names = new Set(owners);
      importLegacy(names);
      return all.all().map((row) => {
        let pending: unknown;
        try {
          pending = JSON.parse(String(row.pending));
        } catch {
          pending = null;
        }
        return conversationResourceRow(
          { hostId: row.host_id, threadId: row.thread_id, state: row.state, generation: row.generation, pending },
          names,
        );
      });
    },
    putConversationResources(rows) {
      if (!Array.isArray(rows)) throw new Error("Invalid conversation resource write");
      const checked = rows.map((row) =>
        conversationResourceRow(row, new Set(Array.isArray(row?.pending) ? row.pending : [])),
      );
      db.transaction(() => {
        for (const row of checked) {
          const { changes } = upsert.run(
            row.hostId,
            row.threadId,
            row.state,
            row.generation,
            JSON.stringify(row.pending),
          );
          if (Number(changes) !== 1) throw new Error("Conversation resource generation regressed");
        }
      });
    },
  };
}
