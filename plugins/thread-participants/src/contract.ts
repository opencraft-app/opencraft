/** Batch read of verified Thread participants. Params: `{ threadIds: string[] }` (1..100). */
export const THREAD_PARTICIPANTS_LIST = "opencraft/thread-participants/list";
/** Host notification after a Thread's participant projection changed: `{ threadId, revision }`. */
export const THREAD_PARTICIPANTS_CHANGED = "opencraft/thread-participants/changed";
/**
 * Deprecated wire names published before participants moved into core. A Host
 * serves and advertises both, and a client accepts either capability, so
 * existing Hosts and clients upgrade independently. Remove after consumers move.
 */
export const LEGACY_THREAD_PARTICIPANTS_LIST = "opencraft/ioa/thread-participants/list";
export const LEGACY_THREAD_PARTICIPANTS_CHANGED = "opencraft/ioa/thread-participants/changed";
export const THREAD_PARTICIPANTS_VERSION = 1;
export const THREAD_PARTICIPANTS_BATCH_LIMIT = 100;
/** Identity kind of a verified MessageSender; avatar resolvers receive it unchanged. */
export const THREAD_PARTICIPANT_IDENTITY_KIND = "employee";

export interface ThreadParticipants {
  readonly threadId: string;
  /** Monotonic per Thread; increases whenever participants or the creator change. */
  readonly revision: number;
  /** Verified sender login names, least recently active first. */
  readonly participants: readonly string[];
  /** True while a provider has not finished reconciling; the row is provisional. */
  readonly pending?: boolean;
  /** Absent on older Hosts; null means no verified creation identity is known. */
  readonly creator?: string | null;
}

/** The verified sender name grammar the Host accepts for submissions. */
export const isParticipantName = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(value);

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Wire boundary: exactly one outcome (row or error) for each requested Thread. */
export function parseThreadParticipantsResponse(value: unknown, threadIds: readonly string[]) {
  if (!record(value) || !Array.isArray(value.data) || (value.errors !== undefined && !Array.isArray(value.errors))) {
    throw new Error("Invalid participant response");
  }
  const remaining = new Set(threadIds);
  const rows = new Map<string, ThreadParticipants>();
  const errors = new Set<string>();
  const claim = (outcome: unknown): Record<string, unknown> & { threadId: string } => {
    if (!record(outcome) || typeof outcome.threadId !== "string" || !remaining.delete(outcome.threadId)) {
      throw new Error("Unexpected or duplicate participant outcome");
    }
    return { ...outcome, threadId: outcome.threadId };
  };
  for (const outcome of value.data) {
    const row = claim(outcome);
    if (
      typeof row.revision !== "number" ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 0 ||
      !Array.isArray(row.participants) ||
      row.participants.length > 10000 ||
      !row.participants.every(isParticipantName) ||
      new Set(row.participants).size !== row.participants.length ||
      (row.pending !== undefined && typeof row.pending !== "boolean") ||
      (row.creator != null && !isParticipantName(row.creator))
    ) {
      throw new Error("Invalid participant row");
    }
    rows.set(row.threadId, {
      threadId: row.threadId,
      revision: row.revision,
      participants: row.participants as string[],
      ...(row.pending !== undefined ? { pending: row.pending as boolean } : {}),
      ...(row.creator !== undefined ? { creator: row.creator as string | null } : {}),
    });
  }
  for (const outcome of value.errors ?? []) errors.add(claim(outcome).threadId);
  if (remaining.size) throw new Error("Incomplete participant response");
  return { rows, errors };
}

/** The list method a Host advertises, preferring the core name over the alias. */
export function supportedParticipantsMethod(extensions: Readonly<Record<string, unknown>> | undefined): string | null {
  for (const method of [THREAD_PARTICIPANTS_LIST, LEGACY_THREAD_PARTICIPANTS_LIST]) {
    const capability = extensions?.[method];
    if (record(capability) && capability.version === THREAD_PARTICIPANTS_VERSION) return method;
  }
  return null;
}
