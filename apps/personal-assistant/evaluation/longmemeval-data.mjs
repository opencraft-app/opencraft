import { createHash } from "node:crypto";

export function benchmarkTime(value) {
  if (typeof value !== "string" || !value.trim())
    throw new Error("Missing benchmark timestamp");
  let text = value.replace(/\s*\([A-Za-z]+\)/g, "").trim();
  if (/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(text))
    text = text.replaceAll("/", "-").replace(" ", "T") + "Z";
  // Other accepted timestamps must carry an explicit UTC offset.
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(text))
    throw new Error("Timestamp requires a date and timezone");
  const at = Date.parse(text);
  if (!Number.isFinite(at)) throw new Error("Invalid benchmark timestamp");
  return at;
}

export function selectCases(rows, limit, { strictTime = false } = {}) {
  if (!Array.isArray(rows) || !rows.length)
    throw new Error("Expected a nonempty LongMemEval JSON array");
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("limit must be a positive integer");
  const seen = new Set();
  for (const row of rows) {
    if (
      !row ||
      typeof row.question_id !== "string" ||
      !row.question_id ||
      seen.has(row.question_id)
    )
      throw new Error("Missing/duplicate question_id");
    seen.add(row.question_id);
  }
  return rows.slice(0, limit).map((row) => {
    if (
      typeof row.question !== "string" ||
      !row.question.trim() ||
      row.question.length > 10000
    )
      throw new Error("Invalid question");
    const queryAt = benchmarkTime(row.question_date);
    const {
      haystack_sessions: sessions,
      haystack_dates: dates,
      haystack_session_ids: ids,
    } = row;
    if (
      !Array.isArray(sessions) ||
      !sessions.length ||
      !Array.isArray(dates) ||
      !Array.isArray(ids) ||
      sessions.length !== dates.length ||
      sessions.length !== ids.length ||
      ids.some((id) => typeof id !== "string" || !id)
    )
      throw new Error("History sessions, dates and IDs must align");
    let characters = row.question.length,
      futureSessionCount = 0;
    const history = sessions
      .map((messages, i) => {
        const at = benchmarkTime(dates[i]);
        if (at > queryAt) {
          futureSessionCount++;
          if (strictTime) throw new Error("History contains a future session");
        }
        if (!Array.isArray(messages) || !messages.length)
          throw new Error("Empty history session");
        return {
          at,
          position: i,
          messages: messages.map((message) => {
            if (
              !message ||
              !["user", "assistant"].includes(message.role) ||
              typeof message.content !== "string" ||
              !message.content.trim() ||
              message.content.length > 1000000
            )
              throw new Error("Invalid history message");
            characters += message.content.length;
            return { role: message.role, content: message.content }; // Deliberately project out has_answer and every other label.
          }),
        };
      })
      .sort((a, b) => a.at - b.at || a.position - b.position);
    if (characters > 20 * 1024 * 1024)
      throw new Error(
        "Case exceeds 20 Mi characters; shard explicitly, never silently truncate",
      );
    return {
      id: row.question_id,
      futureSessionCount,
      repeatedSessionIds: ids.length - new Set(ids).size,
      category:
        typeof row.question_type === "string" ? row.question_type : "unknown",
      key: createHash("sha256")
        .update(row.question_id)
        .digest("hex")
        .slice(0, 24),
      // This is the complete allowlist sent across the evaluator/assistant boundary.
      input: {
        question: row.question,
        queryAt,
        history: history.map(({ at, messages }) => ({ at, messages })),
      },
    };
  });
}
