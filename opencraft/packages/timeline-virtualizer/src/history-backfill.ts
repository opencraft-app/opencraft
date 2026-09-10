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

/**
 * Coordinates the recovered Codex history-fill transaction independently of
 * DOM or React Native. It owns the single-flight lock and generation boundary;
 * the host owns measurement and the post-load layout barrier.
 */
export class TurnHistoryBackfillCoordinator {
  private active: ActiveBackfill | null = null;
  private generation = 0;

  constructor(private readonly port: TurnHistoryBackfillPort) {}

  /** Invalidates an observer/layout owner without allowing two page loads at once. */
  invalidate(): void {
    this.generation += 1;
  }

  request = (): Promise<void> => {
    const generation = this.generation;
    const active = this.active;
    if (active !== null) {
      if (active.generation === generation) return active.promise;
      return active.promise.then(this.request, this.request);
    }

    const promise = this.drain(generation).finally(() => {
      if (this.active?.promise === promise) this.active = null;
    });
    this.active = { generation, promise };
    return promise;
  };

  private async drain(generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;
    try {
      for (;;) {
        const before = this.port.readMetrics();
        if (
          before === null
          || !shouldLoadOlderHistory({
            contentHeightPx: before.scrollHeightPx,
            distanceFromBottomPx: before.distanceFromBottomPx,
            viewportHeightPx: before.viewportHeightPx,
          })
        ) return;

        const result = await this.port.loadPage();
        await this.port.afterLayout();
        if (!this.isCurrent(generation) || result === "stop") return;

        const after = this.port.readMetrics();
        if (after === null || after.scrollHeightPx === before.scrollHeightPx) return;
      }
    } catch (error) {
      this.port.onError?.(error);
    }
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation && this.port.isEnabled();
  }
}
