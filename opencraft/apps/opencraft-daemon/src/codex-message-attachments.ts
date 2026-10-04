import { chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AttachmentRef } from "@opencraft/appserver-protocol";

/** Durable display metadata; Codex's native `mention` remains the execution input. */
export class CodexMessageAttachments {
  private readonly db: DatabaseSync;

  constructor(dataDirectory: string) {
    const path = join(dataDirectory, "codex-message-attachments.sqlite");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS codex_message_attachments (
        thread_id TEXT NOT NULL,
        client_message_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        ref_json TEXT NOT NULL,
        PRIMARY KEY(thread_id, client_message_id, attachment_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS codex_message_attachments_message
        ON codex_message_attachments(thread_id, client_message_id, ordinal);`);
  }

  close(): void { this.db.close(); }

  /** Record before dispatch. A retry may repeat the same identity, never replace it. */
  record(threadId: string, clientMessageId: string, refs: readonly AttachmentRef[]): void {
    if (!threadId || !clientMessageId) throw new Error("Attachment message identity is required");
    if (refs.length === 0) return;
    const existing = this.list(threadId, clientMessageId);
    if (existing.length > 0) {
      if (JSON.stringify(existing) !== JSON.stringify(refs)) {
        throw new Error("Client message identity already has different attachments");
      }
      return;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.db.prepare(`INSERT INTO codex_message_attachments
        (thread_id,client_message_id,attachment_id,ordinal,ref_json) VALUES(?,?,?,?,?)`);
      refs.forEach((ref, ordinal) => insert.run(threadId, clientMessageId, ref.id, ordinal, JSON.stringify(ref)));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  list(threadId: string, clientMessageId: string): AttachmentRef[] {
    return this.db.prepare(`SELECT ref_json FROM codex_message_attachments
      WHERE thread_id=? AND client_message_id=? ORDER BY ordinal`)
      .all(threadId, clientMessageId)
      .map(row => JSON.parse(String(row.ref_json)) as AttachmentRef);
  }

  hasReference(attachmentId: string): boolean {
    return this.db.prepare("SELECT 1 FROM codex_message_attachments WHERE attachment_id=? LIMIT 1")
      .get(attachmentId) !== undefined;
  }

  /** A fork keeps historical messages but receives a new Thread identity. */
  cloneThread(sourceThreadId: string, targetThreadId: string): void {
    if (!sourceThreadId || !targetThreadId || sourceThreadId === targetThreadId) return;
    this.db.prepare(`INSERT OR IGNORE INTO codex_message_attachments
      (thread_id,client_message_id,attachment_id,ordinal,ref_json)
      SELECT ?,client_message_id,attachment_id,ordinal,ref_json
      FROM codex_message_attachments WHERE thread_id=?`)
      .run(targetThreadId, sourceThreadId);
  }
}
