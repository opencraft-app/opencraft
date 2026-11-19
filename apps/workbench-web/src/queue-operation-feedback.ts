/** Preserve rejection so editors keep drafts; report failures outside queue layout. */
export async function withQueueFailureFeedback<T>(operation: () => Promise<T>, report: (error: unknown) => void): Promise<T> {
  try { return await operation(); }
  catch (error) { try { report(error); } catch { /* Diagnostics must not replace the operation failure. */ } throw error; }
}

/** Only known protocol reasons are exported; arbitrary server text may contain secrets. */
export function queueFailureFields(error: unknown) {
  const value = error !== null && typeof error === "object" ? error as Record<string, unknown> : {};
  const data = value.data !== null && typeof value.data === "object" ? value.data as Record<string, unknown> : {};
  const reasons: Record<string, string> = {
    "Execution identity is unavailable": "execution-identity-unavailable",
    "This operation cannot use the current reply's account. Send a new message instead.": "execution-account-unconfirmed",
    "no active turn to steer": "no-active-turn",
    "Queued message is unavailable": "queue-unavailable",
    "Queued message is already being dispatched": "already-dispatching",
    "Earlier delivery is unconfirmed; review it before sending another message": "earlier-delivery-unconfirmed",
    "Earlier delivery is still being sent": "earlier-delivery-pending",
    "Actor input requires its trusted admission": "actor-admission-required",
    "Message identity already belongs to another Turn": "different-turn",
    "This Host does not support atomic steering of queued messages": "atomic-steer-unsupported",
    "Thread is not idle": "thread-not-idle",
  };
  return {
    rpcCode: typeof value.code === "number" && Number.isFinite(value.code) ? value.code : null,
    reason: typeof value.message === "string" && Object.hasOwn(reasons, value.message) ? reasons[value.message] : "unclassified",
    retryable: typeof data.retryable === "boolean" ? data.retryable : null,
    notSubmitted: typeof data.notSubmitted === "boolean" ? data.notSubmitted : null,
    submissionOutcome: ["rejected", "accepted", "unknown"].includes(String(data.submissionOutcome)) ? String(data.submissionOutcome) : null,
  };
}
