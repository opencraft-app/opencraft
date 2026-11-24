// Worker-only module: it holds the SQLite connection. The main thread reaches
// it through `thread-participants.worker.ts` and never imports this file. The
// rows themselves are kept by the runtime-neutral `SqlParticipantStore`.
import { DatabaseSync } from "node:sqlite";
import { nodeSqlDatabase } from "@opencraft/sqlite-node";
import { WorkerOwnerFatal, type ServedOwner } from "@opencraft/worker-owner/serve";
import { PARTICIPANT_TABLES, SqlParticipantStore } from "./sql-participant-store";
import type { ParticipantApply, ParticipantProjection, ParticipantStoreData, ParticipantWrite } from "./store-protocol";

/**
 * Borrowed WAL connection to the Host database. The Host's managed owner opened
 * and migrated the file; this connection never creates, migrates or recovers it.
 */
export class ParticipantStore {
  readonly #connection: DatabaseSync;
  readonly #store: SqlParticipantStore;

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
      const missing = PARTICIPANT_TABLES.filter((table) => !present.has(table));
      if (missing.length) throw new Error(`Host database lacks participant tables: ${missing.join(", ")}`);
    } finally {
      probe.close();
    }
    const connection = (this.#connection = new DatabaseSync(path));
    try {
      connection.exec("PRAGMA busy_timeout=5000");
      this.#store = new SqlParticipantStore(nodeSqlDatabase(connection), {
        // The connection state is unknown; the owner must not accept more writes.
        unrecoverable: (cause) => new WorkerOwnerFatal("Thread participant storage could not roll back", { cause }),
      });
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  load(threadIds: readonly string[]): ParticipantProjection[] {
    return this.#store.load(threadIds);
  }

  apply(threadId: string, messageIds: readonly string[], replace: boolean): ParticipantApply {
    return this.#store.apply(threadId, messageIds, replace);
  }

  recordCreator(threadId: string, loginName: string | null): ParticipantWrite {
    return this.#store.recordCreator(threadId, loginName);
  }

  forget(threadId: string): ParticipantWrite {
    return this.#store.forget(threadId);
  }

  close(): void {
    this.#connection.close();
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
