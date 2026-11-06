import type { PiSnapshot } from "./session.js";
import type { SubmissionRecord } from "@earendil-works/pi-durable";

/** Steers belong to a run; an unplaced steer cannot keep a settled owner alive. */
export function expiredPiSteers(snapshot: Pick<PiSnapshot, "submissions" | "inbox" | "live">): Set<SubmissionRecord["id"]> {
  const expired = new Set<SubmissionRecord["id"]>();
  if (snapshot.live.run) return expired;
  const receipts = new Map(snapshot.submissions.map(record => [record.requestId, record]));
  const byId = new Map(snapshot.submissions.map(record => [record.id, record]));
  for (const item of snapshot.inbox) {
    const ownerId = item.entry?.data?.steerTurnId;
    if (item.mode !== "steer" || typeof ownerId !== "string") continue;
    const input = byId.get(item.id);
    if (input?.status !== "queued") continue;
    const owner = receipts.get(ownerId);
    if (owner?.status === "done" || owner?.status === "unanswered") expired.add(input.id);
  }
  return expired;
}
