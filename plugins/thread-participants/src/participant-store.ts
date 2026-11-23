// Worker-only module: it holds the SQLite connection. The main thread reaches
// it through `thread-participants.worker.ts` and never imports this file.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { WorkerOwnerFatal, type ServedOwner } from "@opencraft/worker-owner/serve";
import { isParticipantName } from "./contract";
import type { ParticipantApply, ParticipantProjection, ParticipantStoreData, ParticipantWrite } from "./store-protocol";

// Published table names keep their historical prefix; they are not renamed.
const REQUIRED_TABLES = [
  "ioa_message_presence",
  "ioa_participant_state",
  "ioa_thread_creators",
  "ioa_presence_sync",
  "message_senders",
  "message_sender_origins",
] as const;

/**
 * Borrowed WAL connection to the Host database. The Host's managed owner opened
 * and migrated the file; this connection never creates, migrates or recovers it.
 */
export class ParticipantStore {
  readonly #database: DatabaseSync;
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
    StatementSync
  >;

  constructor(path: string) {
    // A read-only probe fails on a missing file instead of creating an empty store.
    const probe = new DatabaseSync(path, { readOnly: true });
    try {
      if (probe.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal") {
        throw new Error("Thread participants require the Host database in WAL mode");
      }
      const present = new Set(
        probe
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((row) => String(row.name)),
      );
      const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
      if (missing.length) throw new Error(`Host database lacks participant tables: ${missing.join(", ")}`);
    } finally {
      probe.close();
    }
    const database = (this.#database = new DatabaseSync(path));
    try {
      database.exec("PRAGMA busy_timeout=5000");
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
    } catch (error) {
      database.close();
      throw error;
    }
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
      if (!this.#statements.insertCreator.run(threadId, loginName).changes) return false;
      this.#statements.bump.run(threadId);
      return true;
    });
    return { projection: this.#projection(threadId), changed };
  }

  /** Deletion clears creator and presence; the revision keeps advancing for a reused ID. */
  forget(threadId: string): ParticipantWrite {
    const changed = this.#transaction(() => {
      this.#statements.clearSync.run(threadId);
      const creator = this.#statements.clearCreator.run(threadId).changes > 0;
      const presence = this.#statements.clearPresence.run(threadId).changes > 0;
      if (creator || presence) this.#statements.bump.run(threadId);
      return creator || presence;
    });
    return { projection: this.#projection(threadId), changed };
  }

  close(): void {
    this.#database.close();
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
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const value = write();
      this.#database.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch (rollback) {
        // The connection state is unknown; the owner must not accept more writes.
        throw new WorkerOwnerFatal("Thread participant storage could not roll back", { cause: rollback });
      }
      throw error;
    }
  }
}

/** The served owner; the Worker entry and test fixtures share it. */
export function openParticipantStore({ path }: ParticipantStoreData): ServedOwner {
  const store = new ParticipantStore(path);
  return {
    methods: {
      load: (threadIds: string[]) => store.load(threadIds),
      apply: (threadId: string, messageIds: string[], replace: boolean) => store.apply(threadId, messageIds, replace),
      recordCreator: (threadId: string, loginName: string | null) => store.recordCreator(threadId, loginName),
      forget: (threadId: string) => store.forget(threadId),
    },
    close: () => store.close(),
  };
}
