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

export function combineAbortSignals(signals: readonly AbortSignal[]): {
  readonly signal: AbortSignal; dispose(): void;
} {
  const controller = new AbortController();
  const attached: Array<{ readonly signal: AbortSignal; readonly listener: () => void }> = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const { signal, listener } of attached) signal.removeEventListener("abort", listener);
    attached.length = 0;
  };
  const cancel = (source: AbortSignal) => {
    if (disposed || controller.signal.aborted) return;
    controller.abort(source.reason);
    dispose();
  };
  for (const source of signals) {
    if (source.aborted) { cancel(source); break; }
    const listener = () => cancel(source);
    source.addEventListener("abort", listener, { once: true });
    attached.push({ signal: source, listener });
  }
  return { signal: controller.signal, dispose };
}
