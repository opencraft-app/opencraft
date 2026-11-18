import {
  createWebConversationViewportOwner,
  type WebConversationScrollBehavior,
  type WebConversationViewportOwner,
} from "./conversation-viewport-owner";

export interface WebTimelineMeasurement {
  readonly timelineKey: string;
  readonly heightPx: number;
}

export interface WebTimelineMeasurementBatch {
  readonly generation: number;
  readonly measurements: readonly WebTimelineMeasurement[];
}

export interface TimelineScrollSnapshot {
  readonly distanceFromBottomPx: number;
  readonly viewportHeightPx: number;
  readonly scrollHeightPx: number;
  readonly isScrolledFromBottom: boolean;
  readonly isScrollAnimationActive: boolean;
}

export interface TimelineScrollController {
  reportPlatformScroll(origin: "system" | "user"): TimelineScrollSnapshot;
  subscribe(listener: (snapshot: TimelineScrollSnapshot) => void): () => void;
  addUserScrollListener(
    listener: (distanceFromBottomPx: number, previousDistanceFromBottomPx: number) => void,
  ): () => void;
  getLastScrollDistanceFromBottomPx(): number;
  scrollToDistanceFromBottomPx(
    distanceFromBottomPx: number,
    behavior: "instant" | "smooth",
    origin?: "system" | "user",
  ): void;
  compensateScrollToDistanceFromBottomPx(distanceFromBottomPx: number): void;
  compensateLayoutToDistanceFromBottomPx(distanceFromBottomPx: number, baseDistanceFromBottomPx: number): boolean;
  scrollToBottom(): void;
  preserveScrollPositionForNextLayout(): void;
  recordWheelDelta(deltaPx: number): void;
  cancelPendingLayoutPreservation(): void;
  cancelScrollAnimation(): void;
}

/**
 * Domain-neutral façade over the sole Web scroll/measurement owner. The
 * wrapped implementation is shared with Task timelines, while Bot callers
 * never acquire Turn identity or lifecycle semantics.
 */
export class WebTimelineViewportOwner {
  readonly scrollElementRef: { current: HTMLDivElement | null };
  readonly scrollController: TimelineScrollController;

  constructor(private readonly native: WebConversationViewportOwner) {
    this.scrollElementRef = native.scrollElementRef;
    this.scrollController = native.scrollController;
  }

  readonly attachScrollElement = (element: HTMLDivElement | null): void => {
    this.native.attachScrollElement(element);
  };

  // Message timelines include the measured dock in their own layout transaction.
  readonly attachFooterElement = (element: HTMLElement | null): void => {
    this.native.setFooterResizeViewportPreserveDisabled(true);
    this.native.attachFooterElement(element);
  };
  readonly getFooterHeight = (): number => this.native.getFooterHeight();
  readonly subscribeFooterHeight = (listener: () => void): (() => void) => this.native.subscribeFooterHeight(listener);

  setMeasurementListener(
    listener: ((batch: WebTimelineMeasurementBatch) => void) | null,
  ): void {
    this.native.setMeasurementListener(listener === null ? null : (batch) => {
      listener({
        generation: batch.generation,
        measurements: batch.measurements.map((measurement) => ({
          timelineKey: measurement.turnKey,
          heightPx: measurement.heightPx,
        })),
      });
    });
  }

  observeEntry(timelineKey: string, element: HTMLDivElement | null): void {
    this.native.observeTurn(timelineKey, element);
  }

  /** Measure newly mounted rows before their estimated geometry can paint. */
  measureNewlyMountedEntries(): readonly WebTimelineMeasurement[] {
    return this.native.measureNewlyMountedTurns().map(({ turnKey, heightPx }) => ({ timelineKey: turnKey, heightPx }));
  }

  bindScrollBehavior(callbacks: WebConversationScrollBehavior): () => void {
    return this.native.bindScrollBehavior(callbacks);
  }

  observeViewportGeometry(onChange: () => void): () => void {
    return this.native.observeViewportGeometry(onChange);
  }

  dispose(): void {
    this.native.dispose();
  }
}

export function createWebTimelineViewportOwner(
  initialDistanceFromBottomPx: number,
): WebTimelineViewportOwner {
  return new WebTimelineViewportOwner(
    createWebConversationViewportOwner(initialDistanceFromBottomPx),
  );
}
