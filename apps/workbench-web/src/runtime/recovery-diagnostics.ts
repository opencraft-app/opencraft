import { observeRecovery } from "./observability";
import { isLocalDiagnosticsEnabled, recordLocalDiagnostic, subscribeLocalDiagnostics } from "./local-diagnostics";
const fields = new Set(["recoveryId", "stage", "attemptId", "eventAtMs", "method", "elapsedMs", "attempt", "delayMs", "demand", "durationMs", "requests", "responseBytes", "projectionMs", "extraConversations", "nativeReads", "nativeEvents", "displayVersion", "messages", "timestamps", "workClocks", "authoritative", "cacheHit", "storageFailure", "renderedTimes", "visibleTimes", "touch", "viewportWidth"]);
export function reportRecoveryEvent(event: Readonly<Record<string, string | number>>) {
  if (!isLocalDiagnosticsEnabled()) return;
  observeRecovery(event);
  recordLocalDiagnostic("recovery", Object.fromEntries(Object.entries(event).filter(([key]) => fields.has(key))));
}
// One bounded, anonymous episode per page. Never include storage keys, account,
// Host/Thread identities, text, timestamp values, user agent or error messages.
const displayStartedAt = Date.now();
const displayEpisode = `recovery-${displayStartedAt.toString(36)}-0`;
const lastDisplayFields = new Map<string, string>();
subscribeLocalDiagnostics(() => lastDisplayFields.clear());
/** Read before gathering DOM diagnostics that can no longer be reported. */
export function canReportDisplayEvent(): boolean { return isLocalDiagnosticsEnabled(); }

export function reportDisplayEvent(stage: "display-load" | "display-save" | "display-paint", fields: Readonly<Record<string, number>>) {
  if (!isLocalDiagnosticsEnabled()) return;
  const signature = JSON.stringify(fields);
  if (lastDisplayFields.get(stage) === signature || !canReportDisplayEvent()) return;
  lastDisplayFields.set(stage, signature);
  reportRecoveryEvent({ recoveryId: displayEpisode, stage, displayVersion: 1,
    elapsedMs: Math.max(0, Date.now() - displayStartedAt), eventAtMs: Date.now(),
    touch: Number(typeof navigator !== "undefined" && navigator.maxTouchPoints > 0),
    viewportWidth: typeof window === "undefined" ? 0 : window.innerWidth, ...fields });
}
