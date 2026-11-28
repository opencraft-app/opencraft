import { ownedDatabasePath } from "./owned-database-path.js";
import { acquireOwnedStorageLease } from "./owned-storage-lease.js";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { openManagedDatabase, createSchemaValidator, createMissingLegacyObjects, type DatabaseOutcome } from "@opencraft/sqlite-node";

import type { AttachmentRef } from "@opencraft/appserver-protocol";

const ATTACHMENT_CACHE_LIMIT = 2048;

export const OPENCRAFT_MESSAGE_ATTACHMENTS_BASELINE = `
CREATE TABLE codex_message_attachments (
        thread_id TEXT NOT NULL,
        client_message_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        ref_json TEXT NOT NULL,
        PRIMARY KEY(thread_id, client_message_id, attachment_id)
      ) STRICT;
      CREATE INDEX codex_message_attachments_message
        ON codex_message_attachments(thread_id, client_message_id, ordinal);
`;

/** v2 changes owned live names without rewriting the published v1 baseline. */
export const OPENCRAFT_MESSAGE_ATTACHMENTS_OWNED_NAMES = `
ALTER TABLE codex_message_attachments RENAME TO opencraft_message_attachments;
DROP INDEX codex_message_attachments_message;
CREATE INDEX opencraft_message_attachments_message
  ON opencraft_message_attachments(thread_id, client_message_id, ordinal);
`;
export const OPENCRAFT_MESSAGE_ATTACHMENTS_MIGRATIONS = [
  { version: 1, name: "codex-message-attachments", sql: OPENCRAFT_MESSAGE_ATTACHMENTS_BASELINE },
  { version: 2, name: "opencraft-message-attachments-owned-names", sql: OPENCRAFT_MESSAGE_ATTACHMENTS_OWNED_NAMES },
] as const;
const FULL_SCHEMA = OPENCRAFT_MESSAGE_ATTACHMENTS_BASELINE + OPENCRAFT_MESSAGE_ATTACHMENTS_OWNED_NAMES;
const legacy = createMissingLegacyObjects(OPENCRAFT_MESSAGE_ATTACHMENTS_BASELINE);

/** Durable display metadata; Codex's native `mention` remains the execution input. */
export class OpenCraftMessageAttachments {
  private readonly db: DatabaseSync;
  private readonly recent = new Map<string, AttachmentRef[]>();
  private insertStmt?: StatementSync;
  private listStmt?: StatementSync;
  private hasRefStmt?: StatementSync;
  private cloneStmt?: StatementSync;
  readonly outcome: DatabaseOutcome;
  readonly path: string;
  private readonly releaseLease: () => void;

  constructor(dataDirectory: string) {
    ownedDatabasePath(dataDirectory, "opencraft-message-attachments.sqlite", "codex-message-attachments.sqlite");
    this.releaseLease = acquireOwnedStorageLease(dataDirectory);
    try {
      const path = this.path = ownedDatabasePath(dataDirectory, "opencraft-message-attachments.sqlite", "codex-message-attachments.sqlite");
      const managed = openManagedDatabase({ schemaId: "opencraft-message-attachments", path, legacyPolicy: "reject-unknown", validateSchema: createSchemaValidator(FULL_SCHEMA), migrations: OPENCRAFT_MESSAGE_ATTACHMENTS_MIGRATIONS,
        legacyMigration: { accepts: legacy.accepts, migrate(database) { legacy.migrate(database); database.exec(OPENCRAFT_MESSAGE_ATTACHMENTS_OWNED_NAMES); } } });
      this.db = managed.database;
      this.outcome = managed.outcome;
    } catch (error) { this.releaseLease(); throw error; }
  }

  close(): void { this.recent.clear(); try { this.db.close(); } finally { this.releaseLease(); } }

  private invalidateThread(threadId: string): void {
    const prefix = `["${JSON.stringify(threadId).slice(1, -1)}",`;
    for (const key of this.recent.keys()) {
      if (key.startsWith(prefix)) this.recent.delete(key);
    }
  }

  /** Record before dispatch. A retry may repeat the same identity, never replace it. */
  record(threadId: string, clientMessageId: string, refs: readonly AttachmentRef[]): void {
    if (!threadId || !clientMessageId) throw new Error("Attachment message identity is required");
    if (refs.length === 0) return;
    const key = JSON.stringify([threadId, clientMessageId]);
    this.recent.delete(key);
    const existing = this.list(threadId, clientMessageId);
    if (existing.length > 0) {
      if (JSON.stringify(existing) !== JSON.stringify(refs)) {
        throw new Error("Client message identity already has different attachments");
      }
      return;
    }
    this.recent.delete(key);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insert = (this.insertStmt ??= this.db.prepare(`INSERT INTO opencraft_message_attachments
        (thread_id,client_message_id,attachment_id,ordinal,ref_json) VALUES(?,?,?,?,?)`));
      refs.forEach((ref, ordinal) => insert.run(threadId, clientMessageId, ref.id, ordinal, JSON.stringify(ref)));
      this.db.exec("COMMIT");
      this.remember(threadId, clientMessageId, [...refs]);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Live messages reuse already staged or read metadata, without a storage read. */
  peek(threadId: string, clientMessageId: string): readonly AttachmentRef[] {
    return this.recent.get(JSON.stringify([threadId, clientMessageId])) ?? [];
  }

  private remember(threadId: string, clientMessageId: string, refs: AttachmentRef[]): void {
    const key = JSON.stringify([threadId, clientMessageId]);
    this.recent.delete(key);
    this.recent.set(key, refs);
    if (this.recent.size > ATTACHMENT_CACHE_LIMIT) this.recent.delete(this.recent.keys().next().value!);
  }

  list(threadId: string, clientMessageId: string): AttachmentRef[] {
    const key = JSON.stringify([threadId, clientMessageId]);
    const cached = this.recent.get(key);
    if (cached !== undefined) {
      this.remember(threadId, clientMessageId, cached);
      return [...cached];
    }
    const refs = (this.listStmt ??= this.db.prepare(`SELECT ref_json FROM opencraft_message_attachments
      WHERE thread_id=? AND client_message_id=? ORDER BY ordinal`))
      .all(threadId, clientMessageId)
      .map(row => JSON.parse(String(row.ref_json)) as AttachmentRef);
    this.remember(threadId, clientMessageId, refs);
    return [...refs];
  }

  hasReference(attachmentId: string): boolean {
    return (this.hasRefStmt ??= this.db.prepare("SELECT 1 FROM opencraft_message_attachments WHERE attachment_id=? LIMIT 1"))
      .get(attachmentId) !== undefined;
  }

  /** A fork keeps historical messages but receives a new Thread identity. */
  cloneThread(sourceThreadId: string, targetThreadId: string): void {
    if (!sourceThreadId || !targetThreadId || sourceThreadId === targetThreadId) return;
    this.invalidateThread(targetThreadId);
    (this.cloneStmt ??= this.db.prepare(`INSERT OR IGNORE INTO opencraft_message_attachments
      (thread_id,client_message_id,attachment_id,ordinal,ref_json)
      SELECT ?,client_message_id,attachment_id,ordinal,ref_json
      FROM opencraft_message_attachments WHERE thread_id=?`))
      .run(targetThreadId, sourceThreadId);
    this.invalidateThread(targetThreadId);
  }
}
