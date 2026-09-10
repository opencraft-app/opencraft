import type { AppServerTurn, AppServerThreadItem, HermesSessionPayload } from "./types";
import { isHermesToolItem } from "./tool-semantics";

/** Hermes Desktop appendLiveSessionProjection, expressed in Turn/Item form.
 * Backend inflight is a flat recovery tail, not another durable transcript. */
export function appendLiveSessionProjection(turns: AppServerTurn[], payload: HermesSessionPayload): AppServerTurn | null {
  const inflight = payload.inflight;
  if (!inflight) return null;
  const user = inflight.user?.trim() ?? "";
  const body = inflight.assistant ?? "";
  const error = inflight.error?.trim() ?? "";
  if (!user && !body && !inflight.streaming && !error && !inflight.corrections?.length) return null;
  const sid = payload.session_id;
  const last = turns.at(-1);
  const userText = (item: AppServerThreadItem) => Array.isArray(item.content)
    ? item.content.map((part: { text?: string }) => part.text ?? "").join("") : "";
  // A committed final reply ends the previous turn, even for equal prompts.
  const openTail = last !== undefined && (last.id === `hermes-turn-${sid}-inflight-${payload.turn_started_at ?? "live"}`
    || !last.items.some(item => item.type === "agentMessage" && (item.phase === "final_answer"
      || (last.status !== "inProgress" && item.phase !== "commentary" && item.completed !== false))));
  const turn = openTail ? last : {
    id: `hermes-turn-${sid}-inflight-${payload.turn_started_at ?? "live"}`,
    items: [], itemsView: "full" as const, status: "inProgress" as const,
    error: null, startedAt: payload.turn_started_at ?? null, completedAt: null, durationMs: null,
  };
  if (turn !== last) turns.push(turn);
  const upsert = (item: AppServerThreadItem) => {
    const index = turn.items.findIndex(existing => existing.id === item.id);
    if (index < 0) turn.items.push(item); else turn.items[index] = item;
  };
  const addUser = (text: string, id: string) => {
    if (text && !turn.items.some(item => item.type === "userMessage" && userText(item) === text)) {
      upsert({ id, type: "userMessage", content: [{ type: "text", text }], clientId: null });
    }
  };
  addUser(user, `hermes-user-inflight-${sid}`);
  const structured = turn.items.some(item => item.type === "reasoning" || isHermesToolItem(item));
  const corrections = (inflight.corrections ?? []).map((text, i) => ({ text: text.trim(), offset: inflight.correction_offsets?.[i] })).filter(entry => entry.text);
  const split = corrections.length > 0 && corrections.every(entry => Number.isInteger(entry.offset) && entry.offset! >= 0);
  // A quiet stream can be waiting on a tool/clarify; only a settled successful
  // snapshot can promote the flat tail to an authoritative final answer.
  const settled = payload.running === false && !payload.pending_clarify && !inflight.streaming && !error;
  const addAssistant = (text: string, id: string, interim: boolean) => upsert({
    id, type: "agentMessage", text, phase: interim ? "commentary" : settled ? "final_answer" : null,
    // A quiet transport is not an item/completed receipt. Preserve an open
    // segment for resumed deltas until the snapshot proves settlement.
    completed: interim || settled, memoryCitation: null,
  });
  if (!structured || error) {
    let cursor = 0;
    if (split && !error && body) {
      corrections.forEach((entry, index) => {
        const boundary = Math.min(Math.max(entry.offset!, cursor), body.length);
        if (body.slice(cursor, boundary).trim()) addAssistant(body.slice(cursor, boundary), `hermes-inflight-segment-${index}-${sid}`, true);
        addUser(entry.text, `hermes-inflight-correction-${index}-${sid}`);
        cursor = boundary;
      });
    }
    // A retained failure with no assistant body is an error-only bubble in
    // Hermes Desktop. The error itself must not manufacture a blank/text Item;
    // Turn.error owns that surface. A non-empty body is genuine partial output.
    if (body || inflight.streaming) addAssistant(body.slice(cursor), `hermes-inflight-assistant-${sid}`, false);
  }
  if (!split || structured || error || !body) corrections.forEach((entry, index) => addUser(entry.text, `hermes-inflight-correction-${index}-${sid}`));
  turn.status = error ? "failed" : payload.running || payload.pending_clarify ? "inProgress" : "completed";
  if (payload.turn_started_at !== undefined) turn.startedAt = payload.turn_started_at;
  if (error) turn.error = { message: error, codexErrorInfo: null, additionalDetails: null };
  return turn;
}
