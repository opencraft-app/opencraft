import { RunLimitError } from "../../domain/run-policy.mjs";

/** Bound a model exchange even when a test/provider ignores cancellation. Late proposals cannot commit. */
export async function withRequestDeadline(call, signal, timeoutMs, kind = "model-timeout") {
  signal?.throwIfAborted();
  const controller = new AbortController();
  let timer, listener;
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const ended = new Promise((_, reject) => {
    listener = () => reject(combined.reason ?? new Error("Request aborted"));
    combined.addEventListener("abort", listener, { once: true });
    if (combined.aborted) listener();
    timer = setTimeout(() => controller.abort(new RunLimitError(kind, timeoutMs)), timeoutMs);
    timer.unref?.();
  });
  try {
    combined.throwIfAborted();
    return await Promise.race([Promise.resolve().then(() => call(combined)), ended]);
  } finally {
    clearTimeout(timer);
    combined.removeEventListener("abort", listener);
  }
}
