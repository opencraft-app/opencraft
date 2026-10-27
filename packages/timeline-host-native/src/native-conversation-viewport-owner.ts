import {
  footerResizeCompensation,
  normalizeTurnViewportMetrics,
  topOffsetForDistanceFromBottom,
  TurnScrollController,
  type PlatformTurnViewportMetrics,
  type TurnScrollBehavior,
  type TurnScrollOrigin,
  type TurnViewportMetrics,
} from "@opencraft/timeline-virtualizer";

export interface NativeScrollCommand {
  readonly topOffsetPx: number;
  readonly animated: boolean;
}

export interface NativeContentGeometryCommit {
  readonly contentHeightPx: number;
  readonly inheritedDistanceFromBottomPx: number | null;
  readonly metrics: TurnViewportMetrics;
}

export interface NativeConversationViewportOwnerOptions {
  readonly initialDistanceFromBottomPx: number;
  readonly now?: () => number;
  readonly requestFrame?: (callback: (nowMs: number) => void) => number;
  readonly cancelFrame?: (handle: number) => void;
}

type NativeScrollWriter = (command: NativeScrollCommand) => void;

/** Translate nested Native onLayout coordinates to the visible answer edge. */
export function nativeFollowContentOverflowPx({
  virtualizerTopPx,
  latestTurnTopPx,
  contentBottomWithinTurnPx,
  viewportTopPx,
  viewportHeightPx,
  footerPaddingPx,
}: {
  readonly virtualizerTopPx: number;
  readonly latestTurnTopPx: number;
  readonly contentBottomWithinTurnPx: number;
  readonly viewportTopPx: number;
  readonly viewportHeightPx: number;
  readonly footerPaddingPx: number;
}): number {
  return virtualizerTopPx + latestTurnTopPx + contentBottomWithinTurnPx
    - (viewportTopPx + viewportHeightPx - footerPaddingPx);
}

/**
 * Native counterpart of WebConversationViewportOwner.
 *
 * It exclusively owns physical ScrollView metrics, user/system origin, scroll
 * commands and footer compensation. React components report facts and execute
 * the emitted command; they never derive a second scroll coordinate.
 */
export class NativeConversationViewportOwner {
  readonly scrollController: TurnScrollController;

  #metrics: PlatformTurnViewportMetrics = {
    contentHeightPx: 0,
    viewportHeightPx: 0,
    topOffsetPx: 0,
  };
  #writer: NativeScrollWriter | null = null;
  #userInputListener: (() => void) | null = null;
  #gestureActive = false;
  #touchNotified = false;
  #momentumActive = false;
  #gestureGraceUntilMs = 0;
  #pendingSystemTopOffsetPx: number | null = null;
  #footerScrollPaddingPx: number | null = null;
  #footerResizeViewportPreserveDisabled = false;
  #pendingFooterCompensationDistancePx: number | null = null;
  #pendingPolicyDistancePx: number | null = null;
  #generation = 0;
  #disposed = false;
  readonly #now: () => number;

  constructor({
    initialDistanceFromBottomPx,
    now = () => performance.now(),
    requestFrame = (callback) => requestAnimationFrame(callback),
    cancelFrame = (handle) => cancelAnimationFrame(handle),
  }: NativeConversationViewportOwnerOptions) {
    this.#now = now;
    this.scrollController = new TurnScrollController({
      getMetrics: () => this.getMetrics(),
      writeDistanceFromBottomPx: (distance, behavior) => {
        if (this.#disposed) return;
        const topOffsetPx = topOffsetForDistanceFromBottom(
          this.#metrics.contentHeightPx,
          this.#metrics.viewportHeightPx,
          distance,
        );
        // An animated ScrollView command only requests a destination. Keep
        // physical metrics at the last observed offset until onScroll reports
        // movement, so target positioning cannot settle before arrival.
        if (behavior !== "smooth") this.#metrics = { ...this.#metrics, topOffsetPx };
        this.#pendingSystemTopOffsetPx = topOffsetPx;
        this.#writer?.({
          topOffsetPx,
          animated: behavior === "smooth",
        });
      },
      now,
      requestFrame,
      cancelFrame,
    }, initialDistanceFromBottomPx);
  }

  get generation(): number {
    return this.#generation;
  }

  getMetrics(): TurnViewportMetrics {
    return normalizeTurnViewportMetrics(this.#metrics);
  }

  getPlatformMetrics(): PlatformTurnViewportMetrics {
    return this.#metrics;
  }

  attachScrollWriter(writer: NativeScrollWriter | null): void {
    if (this.#disposed) return;
    this.#writer = writer;
  }

  setUserInputListener(listener: (() => void) | null): void {
    if (this.#disposed) return;
    this.#userInputListener = listener;
  }

  /** A touch takes over pending motion before ScrollView decides it is a drag. */
  noteUserTouch(): void {
    if (this.#disposed || this.#touchNotified) return;
    this.#touchNotified = true;
    this.#pendingSystemTopOffsetPx = null;
    this.scrollController.cancelPendingLayoutPreservation();
    this.scrollController.cancelScrollAnimation();
    this.#userInputListener?.();
  }

  endUserTouch(): void {
    this.#touchNotified = false;
  }

  beginUserGesture(): void {
    if (this.#disposed) return;
    this.noteUserTouch();
    this.#gestureActive = true;
    this.#gestureGraceUntilMs = Number.POSITIVE_INFINITY;
  }

  endUserGesture(): void {
    if (this.#disposed) return;
    this.#gestureActive = false;
    this.#touchNotified = false;
    // Native may emit a final scroll between drag-end and momentum-begin.
    this.#gestureGraceUntilMs = this.#now() + 160;
  }

  beginMomentum(): void {
    if (this.#disposed) return;
    this.#momentumActive = true;
    this.#gestureGraceUntilMs = Number.POSITIVE_INFINITY;
  }

  endMomentum(): void {
    if (this.#disposed) return;
    this.#momentumActive = false;
    this.#gestureGraceUntilMs = this.#now() + 32;
  }

  reportViewportHeight(viewportHeightPx: number): void {
    if (this.#disposed) return;
    const nextHeightPx = Number.isFinite(viewportHeightPx) ? Math.max(0, viewportHeightPx) : 0;
    if (this.#metrics.viewportHeightPx === nextHeightPx) return;
    this.#metrics = {
      ...this.#metrics,
      viewportHeightPx: nextHeightPx,
    };
    // Before the first content geometry exists, the controller's distance is
    // the saved restore intent. An empty startup viewport cannot revoke it.
    if (this.#metrics.contentHeightPx > 0) this.scrollController.reportGeometry();
  }

  reportContentHeight(contentHeightPx: number): void {
    if (this.#disposed) return;
    this.#metrics = {
      ...this.#metrics,
      contentHeightPx: Math.max(0, contentHeightPx),
    };
  }

  /**
   * Native reports content size after React commits the complete geometry.
   * Merge every pending geometry owner in that event and perform at most one
   * physical position write.
   */
  commitContentGeometry(
    contentHeightPx: number,
    resolveDistanceFromBottomPx: (
      commit: NativeContentGeometryCommit,
    ) => number | null,
  ): number | null {
    if (this.#disposed) return null;
    this.reportContentHeight(contentHeightPx);
    const inheritedDistanceFromBottomPx =
      this.consumePendingGeometryDistanceFromBottomPx();
    const requestedDistanceFromBottomPx = resolveDistanceFromBottomPx({
      contentHeightPx: this.#metrics.contentHeightPx,
      inheritedDistanceFromBottomPx,
      metrics: this.getMetrics(),
    });
    if (requestedDistanceFromBottomPx === null) {
      this.scrollController.reportGeometry();
      return null;
    }
    const distanceFromBottomPx = Math.max(0, requestedDistanceFromBottomPx);
    this.writeDistanceFromBottomPx(distanceFromBottomPx, "instant");
    return distanceFromBottomPx;
  }

  reportPlatformScroll(metrics: PlatformTurnViewportMetrics): TurnScrollOrigin {
    if (this.#disposed) return "system";
    this.#metrics = {
      contentHeightPx: Math.max(0, metrics.contentHeightPx),
      viewportHeightPx: Math.max(0, metrics.viewportHeightPx),
      topOffsetPx: Math.max(0, metrics.topOffsetPx),
    };
    const pendingSystemTopOffsetPx = this.#pendingSystemTopOffsetPx;
    const matchesSystemWrite = pendingSystemTopOffsetPx !== null
      && Math.abs(pendingSystemTopOffsetPx - this.#metrics.topOffsetPx) <= 1;
    if (matchesSystemWrite) this.#pendingSystemTopOffsetPx = null;
    const origin: TurnScrollOrigin = matchesSystemWrite
      ? "system"
      : this.#gestureActive || this.#momentumActive || this.#now() <= this.#gestureGraceUntilMs
        ? "user"
        : "system";
    this.scrollController.reportPlatformScroll(origin);
    return origin;
  }

  setFooterResizeViewportPreserveDisabled(disabled: boolean): void {
    this.#footerResizeViewportPreserveDisabled = disabled;
  }

  /**
   * Composer padding changes participate in the same geometry transaction as
   * the ScrollView. The caller must not issue an additional compensating write.
   */
  reportFooterScrollPadding(scrollPaddingPx: number): void {
    if (this.#disposed) return;
    const next = Math.max(0, scrollPaddingPx);
    const previous = this.#footerScrollPaddingPx;
    if (previous === next) return;
    this.#footerScrollPaddingPx = next;
    const compensated = footerResizeCompensation({
      currentDistanceFromBottomPx: this.scrollController.getLastScrollDistanceFromBottomPx(),
      footerResizeViewportPreserveDisabled: this.#footerResizeViewportPreserveDisabled,
      isScrollAnimationActive: this.scrollController.getSnapshot().isScrollAnimationActive,
      nextFooterHeightPx: next,
      previousFooterHeightPx: previous,
    });
    if (compensated !== null) this.#pendingFooterCompensationDistancePx = compensated;
  }

  /** Consumed by the next Native content-size commit, never by a separate effect. */
  consumePendingGeometryDistanceFromBottomPx(): number | null {
    const distance = this.#pendingPolicyDistancePx ?? this.#pendingFooterCompensationDistancePx;
    this.#pendingPolicyDistancePx = null;
    this.#pendingFooterCompensationDistancePx = null;
    return distance;
  }

  /**
   * Schedule a policy-owned position for the geometry produced by a pending
   * React Native layout change. Policy takes precedence over footer
   * compensation because both belong to the same content-size transaction.
   */
  requestDistanceAfterNextGeometry(distanceFromBottomPx: number): void {
    if (this.#disposed) return;
    this.#pendingPolicyDistancePx = Math.max(0, distanceFromBottomPx);
  }

  writeDistanceFromBottomPx(distanceFromBottomPx: number, behavior: TurnScrollBehavior = "instant"): void {
    this.scrollController.scrollToDistanceFromBottomPx(distanceFromBottomPx, behavior);
  }

  invalidateGeneration(): number {
    this.#generation += 1;
    return this.#generation;
  }

  isCurrentGeneration(generation: number): boolean {
    return !this.#disposed && generation === this.#generation;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#writer = null;
    this.#userInputListener = null;
    this.#touchNotified = false;
    this.#pendingSystemTopOffsetPx = null;
    this.#pendingFooterCompensationDistancePx = null;
    this.#pendingPolicyDistancePx = null;
    this.scrollController.dispose();
  }
}
