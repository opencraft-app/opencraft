import { openManagedDatabase, createSchemaValidator } from "@opencraft/sqlite-node";

const schema = `CREATE TABLE im_post_receipts (
 scope TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('sending','delivered','rejected','unknown')),
 post_id TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(scope,request_id)
) STRICT;`;
export type PostReceipt = { fingerprint: string; state: "sending" | "delivered" | "rejected" | "unknown"; postId: string | null };
/** IM owns durable effect receipts, not a queue. Existing switchboard schema stays unchanged. */
export class ImPostReceipts {
  private readonly managed;
  constructor(path: string) {
    this.managed = openManagedDatabase({ path, legacyPolicy: "reject",
      migrations: [{ version: 1, name: "im-channel-post-receipts", sql: schema }],
      validateSchema: createSchemaValidator(schema) });
    // An interrupted write cannot be proved absent from the provider.
    this.managed.database.prepare("UPDATE im_post_receipts SET state='unknown', updated_at=? WHERE state='sending'").run(Date.now());
  }
  get outcome() { return this.managed.outcome; }
  get(scope: string, requestId: string): PostReceipt | null {
    const row = this.managed.database.prepare("SELECT fingerprint,state,post_id FROM im_post_receipts WHERE scope=? AND request_id=?").get(scope, requestId);
    return row ? { fingerprint: String(row.fingerprint), state: row.state as PostReceipt["state"], postId: row.post_id === null ? null : String(row.post_id) } : null;
  }
  claim(scope: string, requestId: string, fingerprint: string): boolean {
    return this.managed.database.prepare("INSERT OR IGNORE INTO im_post_receipts VALUES(?,?,?,'sending',NULL,?)").run(scope, requestId, fingerprint, Date.now()).changes === 1;
  }
  finish(scope: string, requestId: string, state: "delivered" | "rejected" | "unknown", postId: string | null = null) {
    this.managed.database.prepare("UPDATE im_post_receipts SET state=?, post_id=?, updated_at=? WHERE scope=? AND request_id=? AND state='sending'").run(state, postId, Date.now(), scope, requestId);
  }
  close() { this.managed.database.close(); }
}
