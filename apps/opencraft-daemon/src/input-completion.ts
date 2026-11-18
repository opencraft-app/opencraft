import { inputExecutionEnded, type InputCompletion } from "@opencraft/appserver-protocol";
import type { HostQueuedSubmission } from "./opencraft-host-queue.js";
import type { InputDeliveryStore } from "./input-delivery-store.js";

type RecordValue = Record<string, unknown>;
const object = (v: unknown): RecordValue => v && typeof v === "object" && !Array.isArray(v) ? v as RecordValue : {};

/** Read-only native projection apart from recovering an exact durable terminal.
 * The input's native admission must be positive before its Turn can settle it. */
export async function readInputCompletion(
  threadId: string,
  row: HostQueuedSubmission,
  deliveries: InputDeliveryStore,
  readTurn: (threadId: string, turnId: string) => Promise<RecordValue | undefined>,
  readItems: (threadId: string, turnId: string, cursor: string | null) => Promise<unknown>,
): Promise<InputCompletion> {
  const turnId = row.targetTurnId;
  const empty = (state: "pending" | "unavailable"): InputCompletion => ({version:1,turnId,status:"unknown",text:"",truncated:false,...(state === "unavailable" ? {unavailable:true as const} : {})});
  if (row.state === "discarded") return empty("unavailable");
  if (!turnId || turnId === "unknown") return empty("pending");
  let delivery = deliveries.receipt(threadId, row.clientUserMessageId, turnId);
  if (delivery.nativeAdmission !== "accepted") return empty("pending");
  if (!inputExecutionEnded(delivery)) {
    const turn = await readTurn(threadId, turnId);
    if (!turn || turn.id !== turnId) return empty("unavailable");
    if (!["completed", "failed", "interrupted"].includes(String(turn.status))) return empty("pending");
    deliveries.finish(threadId, turnId, String(turn.status));
    delivery = deliveries.receipt(threadId, row.clientUserMessageId, turnId);
  }
  let cursor: string | null = null;
  const seen = new Set<string>();
  let summary = "", truncated = false;
  // Bounded, exact-Turn reads only. Never infer results from the latest Thread.
  for (let page = 0; page < 5; page++) {
    const response = object(await readItems(threadId, turnId, cursor));
    if (!Array.isArray(response.data) || !(response.nextCursor == null || typeof response.nextCursor === "string"))
      throw new Error("Invalid native completion Item page");
    for (const entry of response.data) {
      const envelope = object(entry), item = object(envelope.item ?? entry);
      if (typeof envelope.turnId === "string" && envelope.turnId !== turnId)
        throw new Error("Native completion Item belongs to another Turn");
      if (item.type !== "agentMessage" || typeof item.text !== "string") continue;
      const separator = summary ? "\n" : "";
      const remaining = 16000 - summary.length;
      const text = separator + item.text.slice(0, remaining);
      if (text.length > remaining || item.text.length > Math.max(0, remaining - separator.length)) truncated = true;
      summary += text.slice(0, remaining);
    }
    cursor = response.nextCursor as string | null ?? null;
    if (cursor === null) break;
    if (seen.has(cursor)) throw new Error("Native completion Item cursor did not advance");
    seen.add(cursor);
    if (page === 4 || summary.length >= 16000) { truncated = true; break; }
  }
  return {version:1,turnId,status:delivery.execution as "completed" | "failed" | "interrupted",text:summary,truncated};
}
