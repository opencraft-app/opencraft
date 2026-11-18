import type { TurnViewportMetrics } from "./ports";
import { shouldLoadOlderHistory } from "./scroll";

/** Canonical pagination state; geometry is demand, never evidence of progress. */
export interface TurnHistoryPagination {
  readonly cursor: string | null;
  readonly hasOlder: boolean;
  readonly loading: boolean;
}

export type TurnHistoryPageResult = void | "stop";

export type TurnHistoryBackfillDiagnostic = Readonly<{
  phase: "load-start" | "load-settled" | "stop" | "error";
  generation: number;
  before: TurnViewportMetrics;
  after?: TurnViewportMetrics | null;
  reason?: "page-stop" | "owner-invalid" | "unchanged-cursor" | "error";
}>;

export interface TurnHistoryBackfillPort {
  readonly afterLayout: () => Promise<void>;
  readonly isEnabled: () => boolean;
  readonly loadPage: () => TurnHistoryPageResult | Promise<TurnHistoryPageResult>;
  readonly readPagination: () => TurnHistoryPagination | null;
  readonly readMetrics: () => TurnViewportMetrics | null;
  /** Stable identity of unconfirmed visible history; null means no visible gap.
   * This is viewport demand; canonical pagination still owns progress. */
  readonly readVisibleHistoryGap?: () => string | null;
  readonly onError?: (error: unknown) => void;
  readonly onDiagnostic?: (event: TurnHistoryBackfillDiagnostic) => void;
}

interface ActiveBackfill {
  readonly generation: number;
  readonly promise: Promise<void>;
}

/** Owns serialized history work across layout generations. */
export class TurnHistoryBackfillCoordinator {
  private operation: ActiveBackfill | null = null;
  private epoch = 0;
  private pending = false;
  // No-progress/error frontiers stay stopped through incidental layout events.
  // A changed cursor, a new owner or explicit user retry can admit another read.
  private stoppedCursor: string | null | undefined;

  readonly retry = (): Promise<void> => {
    this.stoppedCursor = undefined;
    return this.request();
  };

  constructor(private readonly port: TurnHistoryBackfillPort) {}

  invalidate(): void {
    this.epoch += 1;
    this.stoppedCursor = undefined;
  }

  readonly request = (): Promise<void> => {
    this.pending = true;
    const running = this.operation;
    if (running !== null) {
      return running.generation === this.epoch
        ? running.promise
        : running.promise.catch(() => undefined).then(this.request);
    }

    const generation = this.epoch;
    // Publish single-flight ownership before calling any reentrant host port.
    const promise: Promise<void> = Promise.resolve().then(async () => {
      do {
        this.pending = false;
        await this.fillViewport(generation);
      } while (this.pending && this.canContinue(generation));
    }).finally(() => {
      if (this.operation?.promise !== promise) return;
      this.operation = null;
      // A notification can arrive between the last drain pass and settlement.
      if (this.pending && this.canContinue(generation)) return this.request();
    });
    this.operation = { generation, promise };
    return promise;
  };

  private async fillViewport(owner: number): Promise<void> {
    if (!this.canContinue(owner)) return;

    let lastBefore: TurnViewportMetrics | null = null;
    let attemptedCursor: string | null | undefined;
    try {
      for (;;) {
        if (!this.canContinue(owner)) return;
        const pagination = this.port.readPagination();
        if (!pagination?.hasOlder || pagination.loading || pagination.cursor === this.stoppedCursor) return;
        const before = this.port.readMetrics();
        const gapBefore = this.port.readVisibleHistoryGap?.() ?? null;
        if (before === null || before.viewportHeightPx <= 0 || (gapBefore === null && !shouldLoadOlderHistory({
          contentHeightPx: before.scrollHeightPx,
          viewportHeightPx: before.viewportHeightPx,
          distanceFromBottomPx: before.distanceFromBottomPx,
        }))) return;

        lastBefore = before;
        attemptedCursor = pagination.cursor;
        this.port.onDiagnostic?.({ phase: "load-start", generation: owner, before });
        const page = await this.port.loadPage();
        // The host must settle the page's geometry even if ownership changed.
        await this.port.afterLayout();
        if (!this.canContinue(owner)) {
          this.port.onDiagnostic?.({ phase: "stop", generation: owner, before, reason: "owner-invalid" });
          return;
        }
        const after = this.port.readMetrics();
        this.port.onDiagnostic?.({ phase: "load-settled", generation: owner, before, after });
        if (page === "stop") {
          this.stoppedCursor = this.port.readPagination()?.cursor;
          this.port.onDiagnostic?.({ phase: "stop", generation: owner, before, after, reason: "page-stop" });
          return;
        }

        const next = this.port.readPagination();
        if (!next?.hasOlder) return;
        if (next.cursor === pagination.cursor) {
          this.stoppedCursor = next.cursor;
          this.port.onDiagnostic?.({ phase: "stop", generation: owner, before, after, reason: "unchanged-cursor" });
          return;
        }
      }
    } catch (error) {
      if (!this.canContinue(owner)) return;
      this.stoppedCursor = attemptedCursor;
      const before = lastBefore ?? this.port.readMetrics();
      if (before !== null) this.port.onDiagnostic?.({ phase: "error", generation: owner, before, reason: "error" });
      this.port.onError?.(error);
    }
  }

  private canContinue(owner: number): boolean {
    return owner === this.epoch && this.port.isEnabled();
  }
}
