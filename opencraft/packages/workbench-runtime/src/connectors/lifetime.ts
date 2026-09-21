export class ConnectorError extends Error {
  constructor(readonly code: "unavailable" | "authorization-required" | "authorization-pending" | "stale-cursor" | "stale-handle" | "tool-schema-too-large" | "tool-output-too-large" | "discovery-budget-exhausted" | "cancelled" | "invalid-input" | "approval-denied" | "failed") {
    super(`Connector ${code}`);
    this.name = "ConnectorError";
  }
}

/** Reject promptly; a provider ignoring cancellation still cannot publish a late resource. */
export function cancellable<T>(operation: Promise<T>, signal: AbortSignal, discard?: (value: T) => void | Promise<void>): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => { if (!settled) { settled = true; reject(new ConnectorError("cancelled")); } };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(value => {
      signal.removeEventListener("abort", abort);
      if (settled) { void Promise.resolve().then(() => discard?.(value)).catch(() => undefined); return; }
      settled = true; resolve(value);
    }, () => {
      signal.removeEventListener("abort", abort);
      if (settled) return;
      settled = true; reject(new ConnectorError("failed"));
    });
  });
}

export function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConnectorError("invalid-input");
  const encoded = JSON.stringify(value);
  if (encoded.length > 262144) throw new ConnectorError("invalid-input");
  return JSON.parse(encoded) as Record<string, unknown>;
}
