/**
 * Cross-runtime equivalent of AbortSignal.throwIfAborted().
 *
 * React Native's AbortSignal intentionally implements a smaller surface than
 * browsers. Runtime and adapter code must therefore depend on the semantic
 * contract (an aborted operation throws), not on a browser prototype method.
 */
export function throwIfSignalAborted(signal?: AbortSignal): void {
  if (signal?.aborted !== true) return;

  const reason = signal.reason;
  if (reason instanceof Error) throw reason;

  const error = new Error(
    typeof reason === "string" && reason.length > 0
      ? reason
      : "The operation was aborted",
  );
  error.name = "AbortError";
  throw error;
}
