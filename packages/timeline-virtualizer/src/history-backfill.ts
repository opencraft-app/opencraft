import type { TurnViewportMetrics } from "./ports";
import { shouldLoadOlderHistory } from "./scroll";

export type TurnHistoryPageResult = void | "stop";

export type TurnHistoryBackfillDiagnostic = Readonly<{
  phase: "load-start" | "load-settled" | "stop" | "error";
  generation: number;
  before: TurnViewportMetrics;
  after?: TurnViewportMetrics | null;
  reason?: "page-stop" | "owner-invalid" | "unchanged-height" | "error";
}>;

export interface TurnHistoryBackfillPort {
  readonly afterLayout: () => Promise<void>;
  readonly isEnabled: () => boolean;
  readonly loadPage: () => TurnHistoryPageResult | Promise<TurnHistoryPageResult>;
  readonly readMetrics: () => TurnViewportMetrics | null;
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

  constructor(private readonly port: TurnHistoryBackfillPort) {}

  invalidate(): void {
    this.epoch += 1;
  }

  readonly request = (): Promise<void> => {
    const running = this.operation;
    if (running !== null) {
      return running.generation === this.epoch
        ? running.promise
        : running.promise.catch(() => undefined).then(this.request);
    }

    const generation = this.epoch;
    const promise = this.fillViewport(generation).finally(() => {
      if (this.operation?.promise === promise) this.operation = null;
    });
    this.operation = { generation, promise };
    return promise;
  };

  private async fillViewport(owner: number): Promise<void> {
    if (!this.canContinue(owner)) return;

    let lastBefore: TurnViewportMetrics | null = null;
    try {
      for (;;) {
        const before = this.port.readMetrics();
        if (before === null || !shouldLoadOlderHistory({
          contentHeightPx: before.scrollHeightPx,
          viewportHeightPx: before.viewportHeightPx,
          distanceFromBottomPx: before.distanceFromBottomPx,
        })) return;

        lastBefore = before;
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
          this.port.onDiagnostic?.({ phase: "stop", generation: owner, before, after, reason: "page-stop" });
          return;
        }

        if (after === null || after.scrollHeightPx === before.scrollHeightPx) {
          this.port.onDiagnostic?.({ phase: "stop", generation: owner, before, after, reason: "unchanged-height" });
          return;
        }
      }
    } catch (error) {
      const before = lastBefore ?? this.port.readMetrics();
      if (before !== null) this.port.onDiagnostic?.({ phase: "error", generation: owner, before, reason: "error" });
      this.port.onError?.(error);
    }
  }

  private canContinue(owner: number): boolean {
    return owner === this.epoch && this.port.isEnabled();
  }
}
