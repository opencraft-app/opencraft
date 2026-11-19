/** Exact text search over the owner's canonical conversation, not a model-generated summary. */
export function searchHistory(
  db,
  conversationId,
  { query, after, limit = 12, anchorId },
) {
  const cursor = after === undefined ? 0 : Number(after);
  if (!Number.isSafeInteger(cursor) || cursor < 0)
    throw new Error("Invalid history cursor");
  let before = Number.MAX_SAFE_INTEGER;
  if (anchorId !== undefined) {
    const anchor = db
      .prepare(
        "SELECT seq FROM conversation_message WHERE conversation_id=? AND id=?",
      )
      .get(conversationId, anchorId);
    if (!anchor) throw new Error("History anchor is unavailable");
    before = anchor.seq;
  }
  return db
    .prepare(
      `SELECT seq,id,role,text,at FROM conversation_message WHERE conversation_id=? AND seq>? AND seq<=?
    AND instr(lower(text),lower(?))>0 ORDER BY seq LIMIT ?`,
    )
    .all(conversationId, cursor, before, query, limit);
}
