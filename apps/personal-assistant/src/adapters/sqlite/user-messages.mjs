import { stable } from "../../domain/values.mjs";

export class SqliteUserMessages {
  constructor(uow) {
    this.db = uow.db;
  }
  get(id) {
    return this.db.prepare("SELECT * FROM user_message WHERE id=?").get(id) ?? null;
  }
  add(message, body) {
    this.db
      .prepare("INSERT INTO user_message(id,conversation_id,body_json,state,created_at) VALUES(?,?,?,'pending',?)")
      .run(message.id, message.conversation_id, stable(body), message.at);
  }
  list(conversationId, after, limit) {
    return this.db
      .prepare("SELECT rowid AS cursor,* FROM user_message WHERE conversation_id=? AND rowid>? ORDER BY rowid LIMIT ?")
      .all(conversationId, after, limit);
  }
  pending(now) {
    return this.db
      .prepare(
        `SELECT m.* FROM user_message m WHERE m.state='pending' AND m.next_at<=?
      AND NOT EXISTS(SELECT 1 FROM user_message older WHERE older.conversation_id=m.conversation_id AND older.state='pending' AND older.rowid<m.rowid)
      ORDER BY m.rowid LIMIT 8`,
      )
      .all(now);
  }
  accepted(id, receipt, at) {
    this.db
      .prepare(
        "UPDATE user_message SET state='accepted',receipt_json=?,accepted_at=?,error=NULL WHERE id=? AND state='pending'",
      )
      .run(stable(receipt), at, id);
  }
  withdrawn(id) {
    this.db.prepare("UPDATE user_message SET state='withdrawn' WHERE id=? AND state='pending'").run(id);
  }
  failed(id, error, nextAt) {
    this.db
      .prepare(
        "UPDATE user_message SET state=CASE WHEN attempts>=4 THEN 'failed' ELSE 'pending' END,attempts=attempts+1,error=?,next_at=? WHERE id=? AND state='pending'",
      )
      .run(String(error).slice(0, 1000), nextAt, id);
  }
  retry(id) {
    return Number(
      this.db
        .prepare(
          "UPDATE user_message SET state='pending',attempts=0,error=NULL,next_at=0 WHERE id=? AND state='failed'",
        )
        .run(id).changes,
    );
  }
}
