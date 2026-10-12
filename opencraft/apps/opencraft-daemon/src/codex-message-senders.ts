import { DatabaseSync } from "node:sqlite";
import type { MessageSender } from "@opencraft/appserver-protocol";

/** One instance per stable Host directory; message identity outlives connections. */
export class CodexMessageSenders {
  private readonly db: DatabaseSync;
  constructor(database: DatabaseSync) {
    this.db = database;
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS message_senders (
        thread_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
        sender_json TEXT NOT NULL, accepted_at_ms INTEGER NOT NULL,
        PRIMARY KEY(thread_id,client_message_id)
      ) STRICT;`);
  }
  record(threadId: string, messageId: string, sender: MessageSender | null): void {
    if (!threadId || !messageId || threadId.length > 4096 || messageId.length > 4096) throw new Error("Message identity is required");
    const snapshot = sender === null ? null : { kind: sender.kind, loginName: sender.loginName };
    if (snapshot && (snapshot.kind !== "employee" || !/^[A-Za-z0-9._-]{1,128}$/u.test(snapshot.loginName))) throw new Error("Invalid verified sender");
    const encoded = JSON.stringify(snapshot);
    // One atomic insertion, including an explicit unknown author. Retries cannot reattribute it.
    this.db.prepare(`INSERT OR IGNORE INTO message_senders VALUES(?,?,?,?)`).run(threadId, messageId, encoded, Date.now());
    const existing = this.db.prepare(`SELECT sender_json FROM message_senders WHERE thread_id=? AND client_message_id=?`).get(threadId, messageId);
    if (existing?.sender_json !== encoded) throw new Error("Message already belongs to another sender");
  }
  get(threadId: string, messageId: string): MessageSender | null {
    const row = this.db.prepare(`SELECT sender_json FROM message_senders WHERE thread_id=? AND client_message_id=?`).get(threadId, messageId);
    return row ? JSON.parse(String(row.sender_json)) as MessageSender | null : null;
  }
  /** Only an observed history item is projected; an unused fork mapping creates no messages. */
  cloneThread(source: string, target: string): void {
    if (!source || !target || source === target) return;
    this.db.prepare(`INSERT OR IGNORE INTO message_senders
      SELECT ?,client_message_id,sender_json,accepted_at_ms FROM message_senders WHERE thread_id=?`).run(target, source);
  }
}
