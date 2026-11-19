import { stable } from "../../domain/values.mjs";

/** Storage for the context owner's derived checkpoints; canonical messages are never rewritten. */
export class SqliteConversationContext {
  constructor(uow) {
    this.db = uow.db;
  }
  anchor(conversationId, messageId) {
    return (
      this.db
        .prepare("SELECT seq,id,role,length(text) AS length FROM conversation_message WHERE conversation_id=? AND id=?")
        .get(conversationId, messageId) ?? null
    );
  }
  tail(conversationId, anchorSeq, limit) {
    return this.db
      .prepare(
        "SELECT seq,id,role,substr(text,1,1000) AS text,length(text)>1000 AS truncated FROM conversation_message WHERE conversation_id=? AND seq<=? ORDER BY seq DESC LIMIT ?",
      )
      .all(conversationId, anchorSeq, limit)
      .reverse();
  }
  latest(conversationId, beforeSeq = Number.MAX_SAFE_INTEGER) {
    return (
      this.db
        .prepare(
          "SELECT * FROM conversation_context WHERE conversation_id=? AND state='ready' AND (end_seq<? OR (end_seq=? AND end_offset=0)) ORDER BY end_seq DESC,end_offset DESC LIMIT 1",
        )
        .get(conversationId, beforeSeq, beforeSeq) ?? null
    );
  }
  get(id) {
    return this.db.prepare("SELECT * FROM conversation_context WHERE id=?").get(id) ?? null;
  }
  next(conversationId, cursor, beforeSeq, maxCharacters) {
    const row = this.db
      .prepare(
        "SELECT seq,id,role,text FROM conversation_message WHERE conversation_id=? AND seq>=? AND seq<? ORDER BY seq LIMIT 1",
      )
      .get(conversationId, cursor.seq, beforeSeq);
    if (!row) return null;
    const offset = row.seq === cursor.seq ? cursor.offset : 0;
    return {
      ...row,
      text: row.text.slice(offset, offset + maxCharacters),
      length: row.text.length,
    };
  }
  count(conversationId, cursor, beforeSeq) {
    return this.db
      .prepare("SELECT count(*) AS count FROM conversation_message WHERE conversation_id=? AND seq>=? AND seq<?")
      .get(conversationId, cursor.seq, beforeSeq).count;
  }
  source(conversationId, segment) {
    const row = this.db
      .prepare("SELECT id,role,text FROM conversation_message WHERE conversation_id=? AND seq=? AND id=?")
      .get(conversationId, segment.seq, segment.id);
    return row
      ? {
          ...row,
          text: row.text.slice(segment.offset, segment.offset + segment.text.length),
          length: row.text.length,
        }
      : null;
  }
  add(job) {
    this.db
      .prepare(
        "INSERT INTO conversation_context(id,conversation_id,parent_id,state,start_seq,start_offset,end_seq,end_offset,source_json,created_at) VALUES(?,?,?,'pending',?,?,?,?,?,?)",
      )
      .run(
        job.id,
        job.conversationId,
        job.parentId,
        job.start.seq,
        job.start.offset,
        job.end.seq,
        job.end.offset,
        stable(job.input),
        job.at,
      );
  }
  attempted(id) {
    this.db.prepare("UPDATE conversation_context SET attempts=attempts+1 WHERE id=? AND state='pending'").run(id);
  }
  ready(id, summary, at) {
    this.db
      .prepare(
        "UPDATE conversation_context SET state='ready',summary_json=?,ready_at=?,error=NULL WHERE id=? AND state='pending'",
      )
      .run(stable(summary), at, id);
  }
  failed(id, error, nextAt, exhausted) {
    this.db
      .prepare("UPDATE conversation_context SET state=?,error=?,next_at=? WHERE id=? AND state='pending'")
      .run(exhausted ? "failed" : "pending", String(error).slice(0, 1000), nextAt, id);
  }
  superseded(id) {
    this.db.prepare("UPDATE conversation_context SET state='superseded' WHERE id=? AND state='pending'").run(id);
  }
  pending(conversationId) {
    return (
      this.db
        .prepare(
          "SELECT id,state,attempts,next_at,error FROM conversation_context WHERE conversation_id=? AND state IN ('pending','failed') AND parent_id IS (SELECT id FROM conversation_context WHERE conversation_id=? AND state='ready' ORDER BY end_seq DESC,end_offset DESC LIMIT 1) ORDER BY created_at DESC,rowid DESC LIMIT 1",
        )
        .get(conversationId, conversationId) ?? null
    );
  }
  retry(conversationId) {
    return Number(
      this.db
        .prepare(
          "UPDATE conversation_context SET state='pending',attempts=0,next_at=0,error=NULL WHERE conversation_id=? AND state='failed' AND parent_id IS (SELECT id FROM conversation_context WHERE conversation_id=? AND state='ready' ORDER BY end_seq DESC,end_offset DESC LIMIT 1)",
        )
        .run(conversationId, conversationId).changes,
    );
  }
}
