import { join } from "node:path";
import { openManagedDatabase, createSchemaValidator, type DatabaseOutcome } from "@opencraft/sqlite-node";
import type { DatabaseSync } from "node:sqlite";

/** Hub-only owner. Existing Host ledgers/files stay at their original owner and versions. */
export const THREAD_IDENTITY_SCHEMA = `
CREATE TABLE message_senders (
  thread_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
  sender_json TEXT NOT NULL, accepted_at_ms INTEGER NOT NULL,
  PRIMARY KEY(thread_id,client_message_id)
) STRICT;
CREATE TABLE message_sender_origins (
  thread_id TEXT NOT NULL, client_message_id TEXT NOT NULL, source_thread_id TEXT NOT NULL,
  PRIMARY KEY(thread_id,client_message_id)
) STRICT;
CREATE TABLE ioa_message_presence (
  thread_id TEXT NOT NULL, client_message_id TEXT NOT NULL, login_name TEXT NOT NULL,
  PRIMARY KEY(thread_id,client_message_id)
) STRICT;
CREATE INDEX ioa_presence_names ON ioa_message_presence(thread_id,login_name);
CREATE TABLE ioa_participant_state (thread_id TEXT PRIMARY KEY, revision INTEGER NOT NULL) STRICT;
CREATE TABLE ioa_thread_creators (thread_id TEXT PRIMARY KEY, login_name TEXT) STRICT;
CREATE TABLE ioa_presence_sync (thread_id TEXT PRIMARY KEY, reconciled_at_ms INTEGER NOT NULL) STRICT;
`;
export class ThreadIdentityDatabase {
  readonly database: DatabaseSync;
  readonly outcome: DatabaseOutcome;
  constructor(directory: string) {
    const opened = openManagedDatabase({ path: join(directory, "thread-identity.sqlite"), legacyPolicy: "reject-unknown",
      validateSchema: createSchemaValidator(THREAD_IDENTITY_SCHEMA),
      migrations: [{ version: 1, name: "thread-identity", sql: THREAD_IDENTITY_SCHEMA }],
    });
    this.database = opened.database; this.outcome = opened.outcome;
  }
  close(): void { this.database.close(); }
}
