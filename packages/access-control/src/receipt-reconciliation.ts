/** Observation health, never execution custody or proof that an input was not sent.
 * Deliberately process-local: a restart may probe again, but durable execution IDs
 * and outcomes remain owned by the existing request/queue stores. */
export type ReconciliationHealth = {
  state: "waiting" | "recovery_required";
  reason: "protocol" | "authority" | "unavailable";
  failures: number;
  lastAttemptAt: number;
  nextAttemptAt: number;
};
export class ReceiptReconciliation {
  private readonly failures = new Map<string, ReconciliationHealth>();
  constructor(private readonly now: () => number = Date.now) {}
  status(id: string): ReconciliationHealth | { state: "ready" } {
    const value = this.failures.get(id);
    return value ? { ...value } : { state: "ready" };
  }
  canAttempt(id: string): boolean {
    return (this.failures.get(id)?.nextAttemptAt ?? 0) <= this.now();
  }
  succeeded(id: string): void {
    this.failures.delete(id);
  }
  failed(id: string, error: unknown): ReconciliationHealth {
    // Codes are deliberately allowlisted; no raw message, request, path or credential.
    const value = error && typeof error === "object" ? (error as { code?: unknown; status?: unknown }) : {};
    const reason =
      value.code === 401 || value.code === 403 || value.status === 401 || value.status === 403
        ? "authority"
        : value.code === -32600 || value.code === -32601 || value.code === -32602
          ? "protocol"
          : "unavailable";
    const prior = this.failures.get(id);
    const failures = prior?.reason === reason ? Math.min(prior.failures + 1, 1000) : 1;
    const recovery = failures >= (reason === "unavailable" ? 8 : 3);
    const delay = recovery
      ? 300_000
      : reason === "unavailable"
        ? Math.min(30_000, 1_000 * 2 ** Math.min(failures - 1, 5))
        : 30_000 * failures;
    const lastAttemptAt = this.now();
    const status: ReconciliationHealth = {
      state: recovery ? "recovery_required" : "waiting",
      reason,
      failures,
      lastAttemptAt,
      nextAttemptAt: lastAttemptAt + delay,
    };
    // Bounded scheduling hints are not another persistent execution ledger.
    if (!this.failures.has(id) && this.failures.size >= 4096) this.failures.delete(this.failures.keys().next().value!);
    this.failures.delete(id);
    this.failures.set(id, status);
    return { ...status };
  }
}
