import { observeRecovery } from "./observability";
import { serverFetch } from "./server-context";
/** Bounded metadata only. No conversation IDs, params, content or error strings. */
const pending = new Map<string, Record<string, string | number>>();
let sending = false;
let listening = false;
const fields = new Set(["recoveryId", "stage", "attemptId", "eventAtMs", "method", "elapsedMs", "attempt", "delayMs", "demand", "durationMs", "requests", "responseBytes", "projectionMs", "extraConversations", "nativeReads", "nativeEvents", "displayVersion", "messages", "timestamps", "workClocks", "authoritative", "cacheHit", "storageFailure", "renderedTimes", "visibleTimes", "touch", "viewportWidth"]);
async function flush() {
  if (sending || typeof fetch !== "function") return;
  sending = true;
  try {
    for (const [id, report] of pending) {
      const response = await serverFetch("/__opencraft_apphost_diagnostic", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "recovery", ...report }), keepalive: true,
        signal: AbortSignal.timeout(5_000),
      });
      // A rejected observation must not poison every subsequent recovery record.
      if (!response.ok && response.status !== 400 && response.status !== 413) break;
      if (pending.get(id) === report) pending.delete(id);
    }
  } catch { /* Next lifecycle/report flushes the latest bounded summary. */ }
  finally { sending = false; }
}
export function reportRecoveryEvent(event: Readonly<Record<string, string | number>>) {
  observeRecovery(event);
  const report = Object.fromEntries(Object.entries(event).filter(([key]) => fields.has(key)));
  if (typeof report.recoveryId !== "string") return;
  console.log("[appserver-recovery]", report);
  pending.set(`${report.recoveryId}:${report.stage}`, report);
  while (pending.size > 32) pending.delete(pending.keys().next().value!);
  if (!listening && typeof window !== "undefined") {
    listening = true; window.addEventListener("online", () => { void flush(); });
  }
  void flush();
}

// One bounded, anonymous episode per page. Never include storage keys, account,
// Host/Thread identities, text, timestamp values, user agent or error messages.
const displayStartedAt = Date.now();
const displayEpisode = `recovery-${displayStartedAt.toString(36)}-0`;
let displayReports = 0;
const lastDisplayFields = new Map<string, string>();
export function reportDisplayEvent(stage: "display-load" | "display-save" | "display-paint", fields: Readonly<Record<string, number>>) {
  const signature = JSON.stringify(fields);
  if (lastDisplayFields.get(stage) === signature || displayReports >= 64) return;
  lastDisplayFields.set(stage, signature);
  displayReports++;
  reportRecoveryEvent({ recoveryId: displayEpisode, stage, displayVersion: 1,
    elapsedMs: Math.max(0, Date.now() - displayStartedAt), eventAtMs: Date.now(),
    touch: Number(typeof navigator !== "undefined" && navigator.maxTouchPoints > 0),
    viewportWidth: typeof window === "undefined" ? 0 : window.innerWidth, ...fields });
}
