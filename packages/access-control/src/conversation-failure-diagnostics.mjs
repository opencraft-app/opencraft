/** Diagnostics never carry input text, raw engine errors, credentials or paths. */
const reasons = new Map([
  ["Host queue is unavailable", "queue_unavailable"],
  ["Trusted Actor admission required", "trusted_admission_required"],
  ["Client is not initialized", "client_not_initialized"],
  ["Actor Host unavailable", "host_unavailable"],
  ["Actor Host admission failed", "host_admission_failed"],
  ["Actor Host closed", "host_closed"],
  ["Actor execution outcome unknown", "host_timeout"],
  ["Actor request unavailable", "actor_request_unavailable"],
]);
const stages = new Set(["connect", "initialize", "request"]);
const numeric = (value) => (typeof value === "number" && Number.isSafeInteger(value) ? value : null);
export function conversationFailure(error, stage = "request", engineMessage) {
  const value = error && typeof error === "object" ? error : {};
  return {
    transportStage: stages.has(stage) ? stage : "request",
    rpcCode: numeric(value.code),
    status: numeric(value.status),
    reason: reasons.get(engineMessage ?? value.message) ?? "unclassified",
  };
}
/** Per-request bounded, non-throwing diagnostics: logging cannot affect custody. */
export class ConversationFailureDiagnostics {
  #recent = new Map();
  constructor(now = Date.now, emit = (record) => console.warn("[conversation-delivery]", JSON.stringify(record))) {
    this.now = now;
    this.emit = emit;
  }
  report(requestId, binding, phase, error) {
    try {
      const e = error && typeof error === "object" ? error : {};
      const d = e.conversationDiagnostic ?? {};
      const summary = conversationFailure(e, d.transportStage);
      summary.rpcCode = numeric(d.rpcCode) ?? summary.rpcCode;
      summary.status = numeric(d.status) ?? summary.status;
      if ([...reasons.values(), "unclassified"].includes(d.reason)) summary.reason = d.reason;
      const key = requestId + ":" + phase,
        fingerprint = JSON.stringify(summary),
        prior = this.#recent.get(key),
        now = this.now();
      if (prior?.fingerprint === fingerprint && now - prior.at < 30_000) {
        prior.suppressed++;
        return;
      }
      const record = {
        event: "handoff-failed",
        requestId,
        threadId: binding.threadId,
        hostId: binding.hostId,
        phase,
        ...summary,
        suppressed: prior?.suppressed ?? 0,
      };
      if (!this.#recent.has(key) && this.#recent.size >= 4096) this.#recent.delete(this.#recent.keys().next().value);
      this.#recent.set(key, { fingerprint, at: now, suppressed: 0 });
      this.emit(record);
    } catch {
      /* A failed logger must not modify delivery or trigger a replay. */
    }
  }
}
