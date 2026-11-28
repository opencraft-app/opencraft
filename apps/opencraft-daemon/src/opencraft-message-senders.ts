import type { SqlDatabase, SqlStatement } from "@opencraft/sql";
import type { MessageSender } from "@opencraft/appserver-protocol";
import { sqlPort, type SqlConnection } from "./sql-connection.js";

const SENDER_CACHE_LIMIT = 2048;

/** One instance per stable Server identity directory; message identity outlives connections. */
export class OpenCraftMessageSenders {
  private readonly db: SqlDatabase;
  private readonly cache = new Map<string, MessageSender | null>();
  private insertStmt?: SqlStatement;
  private selectStmt?: SqlStatement;
  private hasEmployeesStmt?: SqlStatement;
  private isInheritedStmt?: SqlStatement;
  private cloneSendersStmt?: SqlStatement;
  private cloneOriginsStmt?: SqlStatement;
  constructor(database: SqlConnection) {
    this.db = sqlPort(database);
  }
  private remember(key: string, sender: MessageSender | null): void {
    this.cache.delete(key);
    this.cache.set(key, sender);
    if (this.cache.size > SENDER_CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }
  private invalidateThread(threadId: string): void {
    const prefix = `["${JSON.stringify(threadId).slice(1, -1)}",`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }
  record(threadId: string, messageId: string, sender: MessageSender | null): void {
    if (!threadId || !messageId || threadId.length > 4096 || messageId.length > 4096) throw new Error("Message identity is required");
    const snapshot = sender === null ? null : { kind: sender.kind, loginName: sender.loginName };
    if (snapshot && (snapshot.kind !== "employee" || !/^[A-Za-z0-9._-]{1,128}$/u.test(snapshot.loginName))) throw new Error("Invalid verified sender");
    const encoded = JSON.stringify(snapshot);
    const cacheKey = JSON.stringify([threadId, messageId]);
    this.cache.delete(cacheKey);
    // One atomic insertion, including an explicit unknown author. Retries cannot reattribute it.
    (this.insertStmt ??= this.db.prepare(`INSERT OR IGNORE INTO message_senders VALUES(?,?,?,?)`)).run(threadId, messageId, encoded, Date.now());
    const existing = (this.selectStmt ??= this.db.prepare(`SELECT sender_json FROM message_senders WHERE thread_id=? AND client_message_id=?`)).get(threadId, messageId);
    if (existing?.sender_json !== encoded) throw new Error("Message already belongs to another sender");
    if (!this.db.inTransaction) this.remember(cacheKey, snapshot);
  }
  get(threadId: string, messageId: string): MessageSender | null {
    const cacheKey = JSON.stringify([threadId, messageId]);
    if (!this.db.inTransaction && this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey)!;
      this.remember(cacheKey, cached);
      return cached ? { ...cached } : null;
    }
    const row = (this.selectStmt ??= this.db.prepare(`SELECT sender_json FROM message_senders WHERE thread_id=? AND client_message_id=?`)).get(threadId, messageId);
    const parsed = row ? (JSON.parse(String(row.sender_json)) as MessageSender | null) : null;
    if (!this.db.inTransaction) this.remember(cacheKey, parsed);
    return parsed ? { ...parsed } : null;
  }
  hasEmployees(threadId: string): boolean {
    return (this.hasEmployeesStmt ??= this.db.prepare(`SELECT 1 FROM message_senders WHERE thread_id=?
      AND json_extract(sender_json,'$.kind')='employee' LIMIT 1`)).get(threadId) !== undefined;
  }
  isInherited(threadId: string, messageId: string): boolean {
    return (this.isInheritedStmt ??= this.db.prepare("SELECT 1 FROM message_sender_origins WHERE thread_id=? AND client_message_id=?"))
      .get(threadId, messageId) !== undefined;
  }
  /** Only an observed history item is projected; an unused fork mapping creates no messages. */
  cloneThread(source: string, target: string): void {
    if (!source || !target || source === target) return;
    this.invalidateThread(target);
    this.db.transaction(() => {
      (this.cloneSendersStmt ??= this.db.prepare(`INSERT OR IGNORE INTO message_senders
        SELECT ?,client_message_id,sender_json,accepted_at_ms FROM message_senders WHERE thread_id=?`)).run(target, source);
      (this.cloneOriginsStmt ??= this.db.prepare(`INSERT OR IGNORE INTO message_sender_origins
        SELECT ?,s.client_message_id,COALESCE(o.source_thread_id,?) FROM message_senders s
        LEFT JOIN message_sender_origins o ON o.thread_id=s.thread_id AND o.client_message_id=s.client_message_id
        WHERE s.thread_id=?`)).run(target, source, source);
    });
    this.invalidateThread(target);
  }
}
