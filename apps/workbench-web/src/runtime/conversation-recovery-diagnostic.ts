import { useEffect, useMemo, useRef } from "react";
import type { RecoveryProgress } from "@opencraft/workbench-runtime";
import type { TransportStatus } from "@opencraft/appserver-client/transport";

export interface ConversationRecoveryDiagnostic {
  /** Local view fence, excluded from copied details. */
  readonly viewKey?: string;
  readonly progress?: RecoveryProgress;
  readonly stage: "connection" | "activation" | "history";
  readonly code: string;
  readonly occurredAt: string;
  readonly runtime: string;
  readonly transport: string;
  readonly attemptId?: string;
  readonly connectionPhase?: string;
  readonly failure?: string;
  readonly closeCode?: number;
  readonly recovery?: "automatic" | "manual";
}

// Remote errors can contain content; display only bounded machine codes.
function machineCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  if (typeof error.code !== "string" && typeof error.code !== "number") return undefined;
  const code = String(error.code);
  return /^(?:[A-Z][A-Z0-9_]{0,79}|-?\d{1,10})$/.test(code) ? code : undefined;
}

export function createConversationRecoveryDiagnostic(input: {
  readonly stage: ConversationRecoveryDiagnostic["stage"];
  readonly error: unknown;
  readonly runtime: string;
  readonly transport: TransportStatus;
}, now = new Date().toISOString()): ConversationRecoveryDiagnostic {
  const failure = input.stage === "connection" ? input.transport.failure : undefined;
  const diagnostic = failure?.diagnostic;
  const attemptId = input.transport.attemptId ?? diagnostic?.attemptId;
  return {
    stage: input.stage, code: machineCode(failure) ?? machineCode(input.error) ?? "UNCLASSIFIED",
    occurredAt: diagnostic?.occurredAt ?? now, runtime: input.runtime, transport: input.transport.state,
    ...(failure ? { recovery: failure.recovery } : {}),
    ...(attemptId ? { attemptId } : {}),
    ...(diagnostic ? {
      connectionPhase: diagnostic.phase, failure: diagnostic.failure,
      ...(diagnostic.closeCode === undefined ? {} : { closeCode: diagnostic.closeCode }),
    } : {}),
  };
}

/** Presentation snapshot only. Scope/error identity fences observation timestamps. */
export function useConversationRecoveryDiagnostic(input: {
  readonly scope: string;
  readonly failed: boolean;
  readonly active?: boolean;
  readonly progress?: RecoveryProgress;
  readonly stage: ConversationRecoveryDiagnostic["stage"];
  readonly error: unknown;
  readonly runtime: string;
  readonly transport: TransportStatus;
}): ConversationRecoveryDiagnostic | undefined {
  const { scope, failed, stage, error, runtime, transport } = input;
  const failure = transport.failure;
  const observedAt = useMemo(() => new Date().toISOString(), [scope, failed, stage, error, failure]);
  const result: ConversationRecoveryDiagnostic | undefined = failed || input.active ? {
    ...createConversationRecoveryDiagnostic({ stage, error, runtime, transport }, observedAt),
    ...(!failed ? { code: "PENDING" } : {}), progress: input.progress, viewKey: scope,
  } : undefined;
  // Only state transitions log; renders and elapsed-time ticks do not flood console.
  const previous = useRef<string | undefined>(undefined);
  useEffect(() => {
    const key = result ? JSON.stringify([scope, result.stage, result.code, result.runtime, result.transport, result.attemptId,
      result.progress?.recoveryId, result.progress?.stage, result.progress?.stageStartedAt, result.progress?.attempt,
      result.progress?.retryAt, result.progress?.lastFailure?.occurredAt]) : undefined;
    if (key !== undefined && key !== previous.current) logConversationRecoveryDiagnostic(result!);
    previous.current = key;
  });
  return result;
}

/** Explicit allowlist; never stringify Error, transport reason or protocol payload. */
export function conversationRecoveryDiagnosticText(diagnostic: ConversationRecoveryDiagnostic, now = Date.now()): string {
  return [
    ["stage", diagnostic.stage], ["code", diagnostic.code], ["occurredAt", diagnostic.occurredAt],
    ["runtime", diagnostic.runtime], ["transport", diagnostic.transport],
    ["recoveryId", diagnostic.progress?.recoveryId], ["currentStage", diagnostic.progress?.stage],
    ["startedAt", diagnostic.progress ? new Date(diagnostic.progress.startedAt).toISOString() : undefined],
    ["stageStartedAt", diagnostic.progress ? new Date(diagnostic.progress.stageStartedAt).toISOString() : undefined],
    ["attemptsStarted", diagnostic.progress?.attempt],
    ["elapsedMs", diagnostic.progress ? Math.max(0, now - diagnostic.progress.startedAt) : undefined],
    ["stageElapsedMs", diagnostic.progress ? Math.max(0, now - diagnostic.progress.stageStartedAt) : undefined],
    ["retryAt", diagnostic.progress?.retryAt === undefined ? undefined : new Date(diagnostic.progress.retryAt).toISOString()],
    ["lastFailureCode", diagnostic.progress?.lastFailure?.code],
    ["lastFailureAt", diagnostic.progress?.lastFailure ? new Date(diagnostic.progress.lastFailure.occurredAt).toISOString() : undefined],
    ["recentStages", diagnostic.progress?.events.map(event => `${new Date(event.at).toISOString()} ${event.stage} #${event.attempt}`).join("; ")],
    ["recoveryPolicy", diagnostic.recovery], ["attemptId", diagnostic.attemptId],
    ["connectionPhase", diagnostic.connectionPhase], ["failure", diagnostic.failure], ["closeCode", diagnostic.closeCode],
  ].filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${value}`).join("\n");
}

/** The same allowlisted text is used for console and the clipboard. */
export function logConversationRecoveryDiagnostic(diagnostic: ConversationRecoveryDiagnostic, now = Date.now()): string {
  const text = conversationRecoveryDiagnosticText(diagnostic, now);
  try { console.log("[conversation-recovery] details\n" + text); } catch { /* Logging is observational. */ }
  return text;
}
