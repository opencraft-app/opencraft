import { join } from "node:path";
import { openManagedDatabase, createSchemaValidator } from "@opencraft/sqlite-node";

type RecordValue = Record<string, unknown>;
export type ThreadCreationPhase = "created" | "attempted" | "accepted" | "persisted";
const schema = `CREATE TABLE thread_creations (
  thread_id TEXT PRIMARY KEY, result_json TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('created','attempted','accepted','persisted')),
  input_id TEXT, turn_id TEXT
) STRICT;`;

/** Positive creation evidence only. An absent legacy row never means empty history. */
export class ProvisionalThreads {
  private readonly managed;
  constructor(directory: string) {
    this.managed = openManagedDatabase({ path: join(directory, "thread-creations.sqlite"), legacyPolicy: "reject",
      migrations: [{ version: 1, name: "thread-creation-lifecycle", sql: schema }], validateSchema: createSchemaValidator(schema) });
  }
  get outcome() { return this.managed.outcome; }
  created(threadId: string, result: RecordValue): void {
    this.managed.database.prepare("INSERT INTO thread_creations VALUES(?,?,'created',NULL,NULL) ON CONFLICT(thread_id) DO NOTHING")
      .run(threadId, JSON.stringify(result));
  }
  get(threadId: string): { phase: ThreadCreationPhase; result: RecordValue; inputId: string | null; turnId: string | null } | null {
    const row = this.managed.database.prepare("SELECT * FROM thread_creations WHERE thread_id=?").get(threadId);
    return row ? { phase: row.phase as ThreadCreationPhase, result: JSON.parse(String(row.result_json)),
      inputId: row.input_id === null ? null : String(row.input_id), turnId: row.turn_id === null ? null : String(row.turn_id) } : null;
  }
  attempted(threadId: string, inputId: string): void {
    this.managed.database.prepare("UPDATE thread_creations SET phase='attempted',input_id=? WHERE thread_id=? AND phase='created'").run(inputId, threadId);
  }
  accepted(threadId: string, inputId: string, turnId: string): void {
    if (!turnId) return;
    this.managed.database.prepare("UPDATE thread_creations SET phase='accepted',input_id=?,turn_id=? WHERE thread_id=? AND phase IN ('created','attempted')")
      .run(inputId, turnId, threadId);
  }
  persisted(threadId: string): void {
    this.managed.database.prepare("UPDATE thread_creations SET phase='persisted' WHERE thread_id=?").run(threadId);
  }
  close() { this.managed.database.close(); }
}
