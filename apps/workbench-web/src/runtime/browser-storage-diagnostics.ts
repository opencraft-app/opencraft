import { getLocalDiagnosticsState, recordLocalDiagnostic } from "./local-diagnostics";

// IDs belong to this JavaScript context. Storage keys, routes and document
// contents never enter the diagnostic buffer.
let contextId: string | undefined;
let sequence = 0;

export function traceBrowserStorage(operation: string, phase: string, fields: Readonly<Record<string, string>> = {}) {
  const session = getLocalDiagnosticsState();
  if (!session.enabled) return;
  const context = contextId ??= Math.random().toString(36).slice(2);
  const id = ++sequence;
  const started = performance.now();
  let slow = false;
  let finished = false;
  function emit(event: string) {
    if (getLocalDiagnosticsState().session !== session.session) return;
    recordLocalDiagnostic("browser-storage", { contextId: context, id, operation, phase, event,
      elapsedMs: Math.round(performance.now() - started), ...fields });
  }
  const timer = setTimeout(() => { slow = true; emit("waiting"); }, 2000);
  return {
    phase(next: string) {
      if (finished || phase === next) return;
      phase = next;
      if (slow) emit("progress");
    },
    finish(event: "complete" | "error" | "abort" | "detached") {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (slow || event === "error" || event === "abort" || performance.now() - started >= 2000) emit(event);
    },
  };
}
