/** Read-only local metadata. The recovery scheduler remains the sole retry owner. */
export type RecoveryStage = "connecting" | "initializing" | "backoff" | "blocked" | "queued" | "history" | "failed";
export interface RecoveryProgress {
  readonly recoveryId: string;
  readonly startedAt: number;
  readonly stage: RecoveryStage;
  readonly stageStartedAt: number;
  /** Actual starts in this episode, not the retry escalation counter. */
  readonly attempt: number;
  readonly retryAt?: number;
  readonly lastFailure?: { readonly code: string; readonly occurredAt: number };
  readonly events: readonly { readonly stage: RecoveryStage; readonly at: number; readonly attempt: number }[];
}
export function recoveryFailureCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return "UNCLASSIFIED";
  const code = typeof error.code === "string" || typeof error.code === "number" ? String(error.code) : "";
  return /^(?:[A-Z][A-Z0-9_]{0,79}|-?\d{1,10})$/.test(code) ? code : "UNCLASSIFIED";
}
export function advanceRecoveryProgress(previous: RecoveryProgress | undefined, input: {
  readonly recoveryId: string; readonly now: number; readonly stage: RecoveryStage;
  readonly startAttempt?: boolean; readonly retryAt?: number; readonly error?: unknown;
}): RecoveryProgress {
  const attempt = (previous?.attempt ?? 0) + (input.startAttempt ? 1 : 0);
  return {
    recoveryId: previous?.recoveryId ?? input.recoveryId,
    startedAt: previous?.startedAt ?? input.now,
    stage: input.stage, stageStartedAt: input.now, attempt,
    ...(input.retryAt === undefined ? {} : { retryAt: input.retryAt }),
    ...(input.error === undefined ? previous?.lastFailure ? { lastFailure: previous.lastFailure } : {}
      : { lastFailure: { code: recoveryFailureCode(input.error), occurredAt: input.now } }),
    events: [...(previous?.events ?? []), { stage: input.stage, at: input.now, attempt }].slice(-12),
  };
}
