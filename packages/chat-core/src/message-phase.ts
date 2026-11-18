import type { TimelineSourceItem, TimelineSourceTurn } from "./projection";

/** Items that start a new request segment instead of continuing assistant work. */
const INPUT_ITEMS = new Set(["userMessage", "steeringUserMessage", "hookPrompt", "realtimeTranscript"]);
/** Display boundaries and Turn resources: neither assistant work nor answers. */
const NEUTRAL_ITEMS = new Set(["steered", "worktreeInit", "turnDiff"]);
const MESSAGE_ITEMS = new Set(["agentMessage", "assistantMessage"]);

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function isAsync(payload: Record<string, unknown>): boolean {
  return payload.delivery === "async" || (Array.isArray(payload.questions) && payload.questions.length > 0);
}

/**
 * Codex treats a missing `phase` as "possibly the answer" (`None | FinalAnswer`)
 * and only excludes explicit commentary. Some providers never send `phase`.
 * For phase-less providers, once a Turn has settled its structure is final:
 * a message followed by more assistant work in its request segment was
 * commentary; the last one with no work after it was the answer. Explicit
 * phase-aware histories and running Turns are never changed, so a live answer cannot be
 * reclassified while work may still follow.
 */
export function inferSettledMessagePhases(turn: TimelineSourceTurn): TimelineSourceTurn {
  if (turn.status !== "complete" && turn.status !== "failed" && turn.status !== "interrupted") return turn;
  // Native phase-aware histories may deliberately contain unqualified messages.
  // Derive structure only for providers that supplied no phase contract at all.
  if (
    turn.items.some(
      (item) =>
        MESSAGE_ITEMS.has(item.type) &&
        (record(item.payload).phase === "commentary" || record(item.payload).phase === "final_answer"),
    )
  )
    return turn;
  const unknown = turn.items.some(
    (item) => MESSAGE_ITEMS.has(item.type) && record(item.payload).phase == null && !isAsync(record(item.payload)),
  );
  if (!unknown) return turn;
  const inferred = new Map<number, "commentary" | "final_answer">();
  let followedByWork = false;
  let answerSeen = false;
  for (let index = turn.items.length - 1; index >= 0; index--) {
    const item = turn.items[index]!;
    if (INPUT_ITEMS.has(item.type)) {
      followedByWork = false;
      answerSeen = false;
      continue;
    }
    if (NEUTRAL_ITEMS.has(item.type)) continue;
    if (!MESSAGE_ITEMS.has(item.type)) {
      followedByWork = true;
      continue;
    }
    const payload = record(item.payload);
    if (isAsync(payload)) continue;
    if (payload.phase === "commentary") continue;
    if (payload.phase === "final_answer") {
      answerSeen = true;
      continue;
    }
    inferred.set(index, followedByWork || answerSeen ? "commentary" : "final_answer");
    if (!followedByWork) answerSeen = true;
  }
  const items = turn.items.map((item, index): TimelineSourceItem => {
    const phase = inferred.get(index);
    return phase === undefined ? item : { ...item, payload: { ...record(item.payload), phase } };
  });
  return { ...turn, items };
}
