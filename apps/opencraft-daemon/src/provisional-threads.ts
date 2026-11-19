import { threadCatalogEntry } from "@opencraft/appserver-protocol";
import type { ThreadCreationEvidenceStore } from "@opencraft/app-host-server/thread-catalog";
import { join } from "node:path";
import {
  openManagedDatabase,
} from "@opencraft/sqlite-node";

type RecordValue = Record<string, unknown>;
export type ThreadCreationPhase =
  | "created"
  | "attempted"
  | "accepted"
  | "persisted";
const schemaV1 = `CREATE TABLE thread_creations (
  thread_id TEXT PRIMARY KEY, result_json TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('created','attempted','accepted','persisted')),
  input_id TEXT, turn_id TEXT
) STRICT;`;
const environmentOwnerMigration =
  "ALTER TABLE thread_creations ADD COLUMN environment_owner TEXT;";

/** Positive creation evidence only. An absent legacy row never means empty history. */
export class ProvisionalThreads {
  private readonly managed;
  // Durable acceptance is not evidence that a row stayed unarchived while this
  // owner was offline. Recover only after fresh native creation metadata.
  private readonly catalogObserved = new Set<string>();
  constructor(directory: string) {
    this.managed = openManagedDatabase({
      schemaId: "provisional-threads",
      path: join(directory, "thread-creations.sqlite"),
      legacyPolicy: "reject",
      migrations: [
        { version: 1, name: "thread-creation-lifecycle", sql: schemaV1 },
        {
          version: 2,
          name: "creation-environment-owner",
          sql: environmentOwnerMigration,
        },
      ],
    });
  }
  get outcome() {
    return this.managed.outcome;
  }
  created(
    threadId: string,
    result: RecordValue,
    environmentOwner?: string,
  ): void {
    // A notification can precede the full receipt. Enrich only that partial
    // record; an established recovery receipt/owner remains immutable.
    const old = this.read(threadId);
    const receipt = old
      ? {
          ...result,
          thread: {
            ...(result.thread as RecordValue),
            ...(old.result.thread as RecordValue),
          },
        }
      : result;
    this.managed.database
      .prepare(
        "INSERT INTO thread_creations(thread_id,result_json,phase,input_id,turn_id,environment_owner) VALUES(?,?,'created',NULL,NULL,?) ON CONFLICT(thread_id) DO UPDATE SET result_json=excluded.result_json,environment_owner=excluded.environment_owner,catalog_only=0 WHERE thread_creations.catalog_only=1",
      )
      .run(threadId, JSON.stringify(receipt), environmentOwner ?? null);
  }
  get(
    threadId: string,
  ): {
    phase: ThreadCreationPhase;
    result: RecordValue;
    inputId: string | null;
    turnId: string | null;
    environmentOwner: string | null;
  } | null {
    return this.read(threadId, false);
  }
  private read(
    threadId: string,
    includeCatalogOnly = true,
  ): ReturnType<ProvisionalThreads["get"]> {
    const row = this.managed.database
      .prepare(
        "SELECT * FROM thread_creations WHERE thread_id=? AND (? OR catalog_only=0)",
      )
      .get(threadId, includeCatalogOnly ? 1 : 0);
    return row
      ? {
          phase: row.phase as ThreadCreationPhase,
          result: JSON.parse(String(row.result_json)),
          inputId: row.input_id === null ? null : String(row.input_id),
          turnId: row.turn_id === null ? null : String(row.turn_id),
          environmentOwner:
            row.environment_owner === null
              ? null
              : String(row.environment_owner),
        }
      : null;
  }
  /** A handoff away from the creation environment has begun: the creation
   * owner no longer attests what native has configured, including after restart. */
  retireEnvironmentOwner(threadId: string): void {
    this.managed.database
      .prepare(
        "UPDATE thread_creations SET environment_owner=NULL WHERE thread_id=? AND phase='created'",
      )
      .run(threadId);
  }
  attempted(threadId: string, inputId: string): void {
    this.managed.database
      .prepare(
        "UPDATE thread_creations SET phase='attempted',input_id=? WHERE thread_id=? AND phase='created'",
      )
      .run(inputId, threadId);
  }
  accepted(threadId: string, inputId: string, turnId: string): void {
    if (!turnId) return;
    this.managed.database
      .prepare(
        "UPDATE thread_creations SET phase='accepted',input_id=CASE WHEN phase='accepted' AND input_id IS NOT NULL AND input_id<>'' THEN input_id ELSE ? END,turn_id=COALESCE(turn_id,?) WHERE thread_id=? AND phase IN ('created','attempted','accepted') AND (phase<>'accepted' OR turn_id IS NULL OR turn_id=?)",
      )
      .run(inputId, turnId, threadId, turnId);
  }
  persisted(threadId: string): void {
    this.managed.database
      .prepare(
        "UPDATE thread_creations SET phase='persisted' WHERE thread_id=?",
      )
      .run(threadId);
  }
  /** Directory evidence shares recovery's existing durable creation record.
   * Legacy rows are enrolled only when observed: migration cannot resurrect an
   * old accepted row whose subsequent archive was never recorded here. */
  readonly catalog: ThreadCreationEvidenceStore = {
    allocate: (thread) => {
      // Native thread metadata is directory evidence, not a thread/start
      // receipt proving empty history or binding an execution environment.
      this.managed.database
        .prepare(
          "INSERT INTO thread_creations(thread_id,result_json,phase,catalog_only) VALUES(?,?,'created',1) ON CONFLICT(thread_id) DO NOTHING",
        )
        .run(thread.id, JSON.stringify({ thread }));
      if (!this.catalogObserved.has(thread.id)) {
        const value = this.read(thread.id)!;
        // A fresh native observation replaces execution status from an old
        // process; subsequent duplicate receipts cannot roll it back again.
        const result = {
          ...value.result,
          thread: {
            ...(value.result.thread as RecordValue),
            status: thread.status,
          },
        };
        this.managed.database
          .prepare(
            "UPDATE thread_creations SET result_json=? WHERE thread_id=?",
          )
          .run(JSON.stringify(result), thread.id);
      }
      this.catalogObserved.add(thread.id);
      this.managed.database
        .prepare(
          "UPDATE thread_creations SET catalog_state='pending' WHERE thread_id=? AND catalog_state IS NULL AND phase<>'persisted'",
        )
        .run(thread.id);
    },
    read: (id) => {
      if (!this.catalogObserved.has(id)) return undefined;
      const stored = this.managed.database
        .prepare("SELECT catalog_state FROM thread_creations WHERE thread_id=?")
        .get(id);
      const value = this.read(id),
        thread = value && threadCatalogEntry(value.result.thread);
      return value && thread
        ? {
            thread,
            accepted: value.phase === "accepted" || value.phase === "persisted",
            retired:
              stored?.catalog_state === "retired" ||
              value.phase === "persisted",
          }
        : undefined;
    },
    accept: (id, turnId) => {
      // The acceptance notification may precede the response's input ID.
      this.managed.database
        .prepare(
          "UPDATE thread_creations SET phase='accepted',input_id=NULL,turn_id=COALESCE(turn_id,?) WHERE thread_id=? AND phase IN ('created','attempted') AND catalog_state='pending'",
        )
        .run(turnId, id);
    },
    patch: (id, patch) => {
      const value = this.read(id),
        evidence = this.catalog.read(id);
      if (!value || !evidence || evidence.retired) return;
      const result = {
        ...value.result,
        thread: { ...(value.result.thread as RecordValue), ...patch },
      };
      this.managed.database
        .prepare("UPDATE thread_creations SET result_json=? WHERE thread_id=?")
        .run(JSON.stringify(result), id);
    },
    retire: (id, removed = false) => {
      if (!removed) {
        this.managed.database
          .prepare(
            "UPDATE thread_creations SET catalog_state='retired' WHERE thread_id=?",
          )
          .run(id);
        return;
      }
      // Removal may precede creation metadata. Keep a negative directory fact,
      // not a fabricated Thread or an empty-history recovery receipt.
      this.managed.database
        .prepare(
          "INSERT INTO thread_creations(thread_id,result_json,phase,catalog_state,catalog_only) VALUES(?,'{}','created','retired',1) ON CONFLICT(thread_id) DO UPDATE SET catalog_state='retired'",
        )
        .run(id);
    },
    committed: () =>
      this.managed.database
        .prepare(
          "SELECT thread_id,result_json FROM thread_creations WHERE phase='accepted' AND catalog_state='pending'",
        )
        .all()
        .flatMap((row) => {
          if (!this.catalogObserved.has(String(row.thread_id))) return [];
          const thread = threadCatalogEntry(
            JSON.parse(String(row.result_json)).thread,
          );
          // Durable metadata cannot certify live execution following a restart.
          return thread
            ? [{ ...thread, status: { type: "notLoaded" as const } }]
            : [];
        }),
  };
  close() {
    this.catalogObserved.clear();
    this.managed.database.close();
  }
}
