import type { TurnViewportMetrics } from "./ports";
import { shouldLoadOlderHistory } from "./scroll";

export type TurnHistoryPageResult = void | "stop";

export interface TurnHistoryBackfillPort {
  readonly afterLayout: () => Promise<void>;
  readonly isEnabled: () => boolean;
  readonly loadPage: () => TurnHistoryPageResult | Promise<TurnHistoryPageResult>;
  readonly readMetrics: () => TurnViewportMetrics | null;
  readonly onError?: (error: unknown) => void;
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

    try {
      for (;;) {
        const before = this.port.readMetrics();
        if (before === null || !shouldLoadOlderHistory({
          contentHeightPx: before.scrollHeightPx,
          viewportHeightPx: before.viewportHeightPx,
          distanceFromBottomPx: before.distanceFromBottomPx,
        })) return;

        const page = await this.port.loadPage();
        // The host must settle the page's geometry even if ownership changed.
        await this.port.afterLayout();
        if (!this.canContinue(owner) || page === "stop") return;

        const after = this.port.readMetrics();
        if (after === null || after.scrollHeightPx === before.scrollHeightPx) return;
      }
    } catch (error) {
      this.port.onError?.(error);
    }
  }

  private canContinue(owner: number): boolean {
    return owner === this.epoch && this.port.isEnabled();
  }
}
