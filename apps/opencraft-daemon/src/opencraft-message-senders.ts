import type { DatabaseSync } from "node:sqlite";
import type { MessageSender } from "@opencraft/appserver-protocol";

/** One instance per stable Server identity directory; message identity outlives connections. */
export class OpenCraftMessageSenders {
  private readonly db: DatabaseSync;
  constructor(database: DatabaseSync) {
    this.db = database;
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
  hasEmployees(threadId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM message_senders WHERE thread_id=?
      AND json_extract(sender_json,'$.kind')='employee' LIMIT 1`).get(threadId) !== undefined;
  }
  isInherited(threadId: string, messageId: string): boolean {
    return this.db.prepare("SELECT 1 FROM message_sender_origins WHERE thread_id=? AND client_message_id=?")
      .get(threadId, messageId) !== undefined;
  }
  /** Only an observed history item is projected; an unused fork mapping creates no messages. */
  cloneThread(source: string, target: string): void {
    if (!source || !target || source === target) return;
    this.db.exec("SAVEPOINT message_sender_clone");
    try {
      this.db.prepare(`INSERT OR IGNORE INTO message_senders
        SELECT ?,client_message_id,sender_json,accepted_at_ms FROM message_senders WHERE thread_id=?`).run(target, source);
      this.db.prepare(`INSERT OR IGNORE INTO message_sender_origins
        SELECT ?,s.client_message_id,COALESCE(o.source_thread_id,?) FROM message_senders s
        LEFT JOIN message_sender_origins o ON o.thread_id=s.thread_id AND o.client_message_id=s.client_message_id
        WHERE s.thread_id=?`).run(target, source, source);
      this.db.exec("RELEASE message_sender_clone");
    } catch (error) {
      this.db.exec("ROLLBACK TO message_sender_clone; RELEASE message_sender_clone"); throw error;
    }
  }
}
