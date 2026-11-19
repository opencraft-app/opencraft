import type { TencentOaThreadParticipants } from "./contract";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const employeeName = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(value);

/** Product wire boundary: exactly one outcome for each requested Thread. */
export function parseParticipantsResponse(value: unknown, threadIds: readonly string[]) {
  if (!record(value) || !Array.isArray(value.data)
    || (value.errors !== undefined && !Array.isArray(value.errors))) {
    throw new Error("Invalid participant response");
  }
  const remaining = new Set(threadIds);
  const rows = new Map<string, TencentOaThreadParticipants>();
  const errors = new Set<string>();
  const claim = (outcome: unknown): Record<string, unknown> & { threadId: string } => {
    if (!record(outcome) || typeof outcome.threadId !== "string" || !remaining.delete(outcome.threadId)) {
      throw new Error("Unexpected or duplicate participant outcome");
    }
    return { ...outcome, threadId: outcome.threadId };
  };
  for (const outcome of value.data) {
    const row = claim(outcome);
    if (typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || row.revision < 0
      || !Array.isArray(row.participants) || row.participants.length > 10000
      || !row.participants.every(employeeName) || new Set(row.participants).size !== row.participants.length
      || (row.pending !== undefined && typeof row.pending !== "boolean")
      || (row.creator != null && !employeeName(row.creator))) {
      throw new Error("Invalid participant row");
    }
    rows.set(row.threadId, {
      threadId: row.threadId, revision: row.revision, participants: row.participants,
      ...(row.pending !== undefined ? { pending: row.pending } : {}),
      ...(row.creator !== undefined ? { creator: row.creator } : {}),
    });
  }
  for (const outcome of value.errors ?? []) errors.add(claim(outcome).threadId);
  if (remaining.size) throw new Error("Incomplete participant response");
  return { rows, errors };
}
