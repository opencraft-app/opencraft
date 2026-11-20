import { createHash } from "node:crypto";

export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const PERSONAMEM_TYPES = Object.freeze([
  "recall_user_shared_facts",
  "suggest_new_ideas",
  "recalling_facts_mentioned_by_the_user",
  "track_full_preference_evolution",
  "recalling_the_reasons_behind_previous_updates",
  "provide_preference_aligned_recommendations",
  "generalizing_to_new_scenarios",
]);

// RFC4180 fields, including escaped quotes, embedded commas and newlines.
export function parseCsv(text) {
  const rows = [],
    row = [];
  let field = "",
    quoted = false,
    closed = false;
  const push = () => {
    row.push(field);
    field = "";
    closed = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
    } else if (c === '"' && !field && !closed) quoted = true;
    else if (c === ",") push();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      push();
      rows.push(row.splice(0));
    } else {
      if (closed || c === '"') throw new Error("Invalid CSV quoting");
      field += c;
    }
  }
  if (quoted) throw new Error("Unterminated CSV quote");
  if (field || row.length || closed) {
    push();
    rows.push(row);
  }
  const header = rows.shift();
  if (!header || new Set(header).size !== header.length)
    throw new Error("Invalid CSV header");
  return rows.map((r) => {
    if (r.length !== header.length)
      throw new Error("CSV column count mismatch");
    return Object.fromEntries(header.map((h, i) => [h, r[i]]));
  });
}

export function parseContexts(text) {
  const contexts = new Map();
  for (const line of text.trim().split(/\r?\n/)) {
    const entries = Object.entries(JSON.parse(line));
    if (entries.length !== 1)
      throw new Error("Expected one shared context per line");
    const [id, messages] = entries[0];
    if (contexts.has(id) || !Array.isArray(messages) || !messages.length)
      throw new Error("Invalid or duplicate shared context");
    for (const m of messages) {
      if (
        !["system", "user", "assistant"].includes(m.role) ||
        typeof m.content !== "string" ||
        !m.content.trim()
      )
        throw new Error("Unsupported PersonaMem message or modality");
    }
    contexts.set(
      id,
      messages.map(({ role, content }) => ({ role, content })),
    );
  }
  return contexts;
}

export function validateQuestions(rows, contexts) {
  const seen = new Set(),
    owners = new Map();
  for (const row of rows) {
    const messages = contexts.get(row.shared_context_id),
      end = Number(row.end_index_in_shared_context);
    if (!row.question_id || seen.has(row.question_id))
      throw new Error("Duplicate or missing question identity");
    seen.add(row.question_id);
    if (
      !row.persona_id ||
      !messages ||
      !Number.isSafeInteger(end) ||
      end < 1 ||
      end > messages.length
    )
      throw new Error("Invalid causal context boundary");
    if (
      owners.has(row.shared_context_id) &&
      owners.get(row.shared_context_id) !== row.persona_id
    )
      throw new Error("Shared context crosses personas");
    owners.set(row.shared_context_id, row.persona_id);
    if (
      !PERSONAMEM_TYPES.includes(row.question_type) ||
      !/^\(?[a-d]\)?$/.test(row.correct_answer.toLowerCase().trim()) ||
      !row.user_question_or_message ||
      !row.all_options
    )
      throw new Error("Unsupported PersonaMem question");
  }
  return rows;
}

export function selectQuestions(rows, count, seed) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 10 || !seed)
    throw new Error("Expected 1..10 contexts and an explicit seed");
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.shared_context_id))
      groups.set(row.shared_context_id, []);
    groups.get(row.shared_context_id).push(row);
  }
  if (groups.size < count) throw new Error("Insufficient contexts");
  // Group selection is independent of gold, length, answerability and prior results.
  const ids = [...groups.keys()]
    .sort((a, b) => hash(`${seed}:${a}`).localeCompare(hash(`${seed}:${b}`)))
    .slice(0, count);
  return ids.map((id) => {
    const presentTypes = PERSONAMEM_TYPES.filter((type) =>
      groups.get(id).some((r) => r.question_type === type),
    );
    const questions = presentTypes
      .map((type) => {
        const candidates = groups
          .get(id)
          .filter((r) => r.question_type === type)
          .sort((a, b) =>
            hash(`${seed}:${a.question_id}`).localeCompare(
              hash(`${seed}:${b.question_id}`),
            ),
          );
        if (!candidates.length)
          throw new Error(
            `Selected context lacks category ${type}; no replacement selection`,
          );
        return candidates[0];
      })
      .sort(
        (a, b) =>
          Number(a.end_index_in_shared_context) -
            Number(b.end_index_in_shared_context) ||
          a.question_id.localeCompare(b.question_id),
      );
    return { id, persona: questions[0].persona_id, questions };
  });
}

// Only roles/content and query/options cross the worker boundary. Gold, category,
// persona/dataset identities, reference distances and annotations remain outside.
export function projectGroup(group, contexts) {
  const messages = contexts.get(group.id);
  return {
    history: messages.slice(
      0,
      Math.max(
        ...group.questions.map((r) => Number(r.end_index_in_shared_context)),
      ),
    ),
    queries: group.questions.map((r) => ({
      end: Number(r.end_index_in_shared_context),
      question: r.user_question_or_message,
      options: r.all_options,
    })),
  };
}

// Port of Evaluation.extract_answer in the retained official inference.py.
export function scoreOption(predicted, correct) {
  const options = (text) => {
    const s = text.toLowerCase();
    const parens = [...s.matchAll(/\(([a-d])\)/g)].map((m) => m[1]);
    return new Set(
      parens.length ? parens : [...s.matchAll(/\b([a-d])\b/g)].map((m) => m[1]),
    );
  };
  const target = correct.toLowerCase().replace(/^[() ]+|[() ]+$/g, "");
  let text = predicted.trim();
  if (text.includes("<final_answer>"))
    text = text.split("<final_answer>").at(-1).trim();
  if (text.endsWith("</final_answer>")) text = text.slice(0, -15).trim();
  const matches = (value) => {
    const set = options(value);
    return set.size === 1 && set.has(target);
  };
  return matches(text) || matches(predicted);
}
