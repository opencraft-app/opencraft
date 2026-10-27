import type { OpenCraftTokenUsageLedger, UsageSource, UsageSourceKind, UsageTurnKey } from "./token-usage-ledger.js";

type Input = Parameters<OpenCraftTokenUsageLedger["recordInput"]>[1];
type Reconciliation = Parameters<OpenCraftTokenUsageLedger["reconcile"]>[1];
export type TokenUsageWork =
  | { readonly kind: "start"; readonly key: UsageTurnKey; readonly startedAt: number; readonly sourceKind: UsageSourceKind; readonly participantsComplete: boolean }
  | { readonly kind: "input"; readonly key: UsageTurnKey; readonly input: Input }
  | { readonly kind: "source"; readonly source: UsageSource }
  | { readonly kind: "reconcile"; readonly key: UsageTurnKey; readonly evidence: Reconciliation };

export interface TokenUsageQueueMetrics {
  readonly queued: number;
  readonly processed: number;
  readonly duplicateSources: number;
  readonly missing: number;
  readonly lastSuccessAt: number | null;
  readonly maxWriteMs: number;
}

/** Internal trusted-fact queue. Failures must be reconciled from durable native
 * facts and acceptance receipts; they never retry or cancel model execution.
 * Callers must not enqueue RPC payloads, closures, prompts or credentials.
 */
export class TokenUsageWorkQueue {
  private readonly items: TokenUsageWork[] = [];
  private scheduled: ReturnType<typeof setImmediate> | null = null;
  private closed = false;
  private processed = 0;
  private duplicates = 0;
  private missing = 0;
  private lastSuccessAt: number | null = null;
  private maxWriteMs = 0;
  private notifying = false;
  constructor(private readonly ledger: OpenCraftTokenUsageLedger, private readonly options: {
    readonly capacity?: number;
    readonly batchSize?: number;
    readonly missing: (reason: "queue-full" | "storage-write" | "shutdown") => void;
    readonly now?: () => number;
  }) {
    for (const size of [options.capacity ?? 2048, options.batchSize ?? 32]) {
      if (!Number.isSafeInteger(size) || size < 1 || size > 10000) throw new TypeError("Invalid metering queue bound");
    }
  }
  enqueue(work: TokenUsageWork): boolean {
    if (this.closed || this.items.length >= (this.options.capacity ?? 2048)) {
      this.noteMissing(this.closed ? "shutdown" : "queue-full");
      return false;
    }
    this.items.push(work);
    this.schedule();
    return true;
  }
  metrics(): TokenUsageQueueMetrics {
    return { queued: this.items.length, processed: this.processed, duplicateSources: this.duplicates,
      missing: this.missing, lastSuccessAt: this.lastSuccessAt, maxWriteMs: this.maxWriteMs };
  }
  private noteMissing(reason: "queue-full" | "storage-write" | "shutdown"): void {
    this.missing++;
    if (this.notifying) return;
    this.notifying = true;
    try { this.options.missing(reason); } catch { /* diagnostics cannot break execution */ }
    finally { this.notifying = false; }
  }
  private schedule(): void {
    if (this.scheduled !== null || this.closed) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = null;
      this.flushBatch();
      if (this.items.length) this.schedule();
    });
  }
  private flushBatch(): void {
    for (let i = 0; i < (this.options.batchSize ?? 32) && this.items.length; i++) {
      const work = this.items.shift()!;
      const start = performance.now();
      try {
        switch (work.kind) {
          case "start": this.ledger.startTurn(work.key, work.startedAt, work.sourceKind, work.participantsComplete); break;
          case "input": this.ledger.recordInput(work.key, work.input); break;
          case "source": if (this.ledger.recordSource(work.source) === "duplicate") this.duplicates++; break;
          case "reconcile": this.ledger.reconcile(work.key, work.evidence); break;
        }
        this.processed++;
        this.lastSuccessAt = (this.options.now ?? Date.now)();
      } catch { this.noteMissing("storage-write"); }
      finally { this.maxWriteMs = Math.max(this.maxWriteMs, performance.now() - start); }
    }
  }
  /** Call before closing the shared database owner. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.scheduled !== null) clearImmediate(this.scheduled);
    this.scheduled = null;
    // Bounded queue, but shutdown must not monopolize the Host event loop.
    this.flushBatch();
    while (this.items.length) { this.items.shift(); this.noteMissing("shutdown"); }
  }
}
