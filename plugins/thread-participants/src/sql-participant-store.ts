// Runtime-neutral participant rows over the SQL port: no node:* imports, so
// the same projection runs on the Host database's Node connection (the storage
// Worker in `participant-store.ts`) and on the SQL of the object that owns the
// thread identity tables. The tables and their migrations belong to that owner.
import type { SqlDatabase, SqlStatement } from "@opencraft/sql";
import { isParticipantName } from "./contract";
import type { ParticipantApply, ParticipantProjection, ParticipantWrite } from "./store-protocol";

// Published table names keep their historical prefix; they are not renamed.
export const PARTICIPANT_TABLES = [
  "ioa_message_presence",
  "ioa_participant_state",
  "ioa_thread_creators",
  "ioa_presence_sync",
  "message_senders",
  "message_sender_origins",
] as const;

export interface SqlParticipantStoreOptions {
  /**
   * The error to throw when a failed write left the transaction open (its
   * rollback failed): the connection state is unknown and its owner must not
   * accept more writes. Defaults to a plain `Error`.
   */
  readonly unrecoverable?: (cause: unknown) => Error;
}

/** Participants and creators of each Thread, on the migrated thread identity tables. */
export class SqlParticipantStore {
  readonly #database: SqlDatabase;
  readonly #unrecoverable: (cause: unknown) => Error;
  readonly #statements: Record<
    | "participants"
    | "revision"
    | "creator"
    | "bump"
    | "insertPresence"
    | "clearPresence"
    | "insertCreator"
    | "clearCreator"
    | "clearSync"
    | "sender"
    | "inherited",
    SqlStatement
  >;

  constructor(database: SqlDatabase, options: SqlParticipantStoreOptions = {}) {
    this.#database = database;
    this.#unrecoverable =
      options.unrecoverable ?? ((cause) => new Error("Thread participant storage could not roll back", { cause }));
    this.#statements = {
      participants: database.prepare(`SELECT login_name FROM ioa_message_presence
        WHERE thread_id=? GROUP BY login_name ORDER BY MAX(rowid) ASC`),
      revision: database.prepare("SELECT revision FROM ioa_participant_state WHERE thread_id=?"),
      creator: database.prepare("SELECT login_name FROM ioa_thread_creators WHERE thread_id=?"),
      bump: database.prepare(`INSERT INTO ioa_participant_state VALUES(?,1)
        ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1`),
      insertPresence: database.prepare("INSERT OR IGNORE INTO ioa_message_presence VALUES(?,?,?)"),
      clearPresence: database.prepare("DELETE FROM ioa_message_presence WHERE thread_id=?"),
      insertCreator: database.prepare("INSERT OR IGNORE INTO ioa_thread_creators VALUES(?,?)"),
      clearCreator: database.prepare("DELETE FROM ioa_thread_creators WHERE thread_id=?"),
      clearSync: database.prepare("DELETE FROM ioa_presence_sync WHERE thread_id=?"),
      sender: database.prepare("SELECT sender_json FROM message_senders WHERE thread_id=? AND client_message_id=?"),
      inherited: database.prepare("SELECT 1 FROM message_sender_origins WHERE thread_id=? AND client_message_id=?"),
    };
  }

  load(threadIds: readonly string[]): ParticipantProjection[] {
    return threadIds.map((threadId) => this.#projection(threadId));
  }

  /** Verified senders of the given accepted user messages become participants. */
  apply(threadId: string, messageIds: readonly string[], replace: boolean): ParticipantApply {
    const recorded: string[] = [];
    const changed = this.#transaction(() => {
      const before = this.#participants(threadId);
      if (replace) this.#statements.clearPresence.run(threadId);
      for (const id of new Set(messageIds)) {
        if (this.#statements.inherited.get(threadId, id) !== undefined) continue;
        const name = this.#senderName(threadId, id);
        if (!name) continue;
        this.#statements.insertPresence.run(threadId, id, name);
        recorded.push(id);
      }
      const after = this.#participants(threadId);
      const differs = after.length !== before.length || after.some((name, index) => name !== before[index]);
      if (differs) this.#statements.bump.run(threadId);
      return differs;
    });
    return { projection: this.#projection(threadId), changed, recorded };
  }

  /** The first creation record wins, including an anonymous one. */
  recordCreator(threadId: string, loginName: string | null): ParticipantWrite {
    if (loginName !== null && !isParticipantName(loginName)) throw new Error("Invalid creation identity");
    const changed = this.#transaction(() => {
      if (!Number(this.#statements.insertCreator.run(threadId, loginName).changes)) return false;
      this.#statements.bump.run(threadId);
      return true;
    });
    return { projection: this.#projection(threadId), changed };
  }

  /** Deletion clears creator and presence; the revision keeps advancing for a reused ID. */
  forget(threadId: string): ParticipantWrite {
    const changed = this.#transaction(() => {
      this.#statements.clearSync.run(threadId);
      const creator = Number(this.#statements.clearCreator.run(threadId).changes) > 0;
      const presence = Number(this.#statements.clearPresence.run(threadId).changes) > 0;
      if (creator || presence) this.#statements.bump.run(threadId);
      return creator || presence;
    });
    return { projection: this.#projection(threadId), changed };
  }

  #senderName(threadId: string, messageId: string): string | null {
    const row = this.#statements.sender.get(threadId, messageId);
    if (!row) return null;
    try {
      const sender = JSON.parse(String(row.sender_json)) as { kind?: unknown; loginName?: unknown } | null;
      return sender?.kind === "employee" && isParticipantName(sender.loginName) ? sender.loginName : null;
    } catch {
      return null;
    }
  }

  #participants(threadId: string): string[] {
    return this.#statements.participants.all(threadId).map((row) => String(row.login_name));
  }

  #projection(threadId: string): ParticipantProjection {
    const creator = this.#statements.creator.get(threadId)?.login_name;
    return {
      threadId,
      revision: Number(this.#statements.revision.get(threadId)?.revision ?? 0),
      creator: typeof creator === "string" ? creator : null,
      participants: this.#participants(threadId),
    };
  }

  #transaction<T>(write: () => T): T {
    try {
      return this.#database.transaction(write);
    } catch (error) {
      // The port rolls back a failed write; a transaction still open means that rollback failed.
      if (this.#database.inTransaction) throw this.#unrecoverable(error);
      throw error;
    }
  }
}
