import type { AppServerTurn } from "./types";

/**
 * Hermes Desktop treats a terminal frame as state, not as assistant prose.
 * Keep this decision renderer-neutral so live Web and Native projections
 * cannot drift from reconnect hydration.
 */
export interface HermesTerminalCompletion {
  readonly status: AppServerTurn["status"];
  readonly errorMessage: string | null;
  /** Only an explicitly partial failed completion owns visible assistant text. */
  readonly keepFailedAssistantText: boolean;
}

// Compatibility with older gateways that put a provider failure only in the
// terminal text. This is the same narrow fallback used by Hermes Desktop.
const COMPLETION_ERROR_PATTERNS = [
  /^API call failed after \d+ retries:/iu,
  /^HTTP\s+\d{3}\b/iu,
  /^(Provider|Gateway)\s+error:/iu,
];

function wireText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value.flatMap((part) => {
    if (typeof part === "string") return [part];
    if (typeof part !== "object" || part === null || Array.isArray(part)) return [];
    return typeof (part as { text?: unknown }).text === "string"
      ? [(part as { text: string }).text]
      : [];
  }).join("\n").trim();
}

export function hermesCompletionErrorText(finalText: string): string | null {
  const normalized = finalText.trim();
  return normalized !== "" && COMPLETION_ERROR_PATTERNS.some((pattern) => pattern.test(normalized))
    ? normalized
    : null;
}

export function hermesFailureMessage(
  payload: Readonly<Record<string, unknown>>,
  fallback = "Hermes turn failed",
): string {
  return wireText(payload.error) || wireText(payload.message) || fallback;
}

/**
 * Port of Hermes Desktop's completionError/keepFailedPartialText invariant.
 *
 * `message.complete(status=error)` uses `text` as an error-compatible wire
 * field. It becomes assistant output only when `partial: true` says that text
 * was already streamed as a real, incomplete response.
 */
export function resolveHermesTerminalCompletion(
  payload: Readonly<Record<string, unknown>>,
  finalText: string,
): HermesTerminalCompletion {
  if (payload.status === "interrupted" || payload.status === "cancelled" || payload.status === "canceled") {
    return { status: "interrupted", errorMessage: null, keepFailedAssistantText: false };
  }

  const explicitlyFailed = payload.status === "error"
    || payload.status === "failed"
    || payload.error !== undefined;
  if (explicitlyFailed) {
    return {
      status: "failed",
      errorMessage: hermesFailureMessage(payload, finalText.trim() || "Hermes turn failed"),
      keepFailedAssistantText: payload.partial === true && finalText.trim() !== "",
    };
  }

  const legacyError = hermesCompletionErrorText(finalText);
  if (legacyError !== null) {
    return { status: "failed", errorMessage: legacyError, keepFailedAssistantText: false };
  }

  return { status: "completed", errorMessage: null, keepFailedAssistantText: false };
}
