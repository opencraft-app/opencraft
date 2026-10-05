import {
  directionForDistanceChange,
  directionForTouchDelta,
  directionForWheelDelta,
  distanceFromTopPx,
  footerResizeCompensation,
  footerScrollPaddingPx,
  invertedWebScrollTopForDistance,
  keyboardScrollDirection,
  normalizeWheelDeltaPx,
  normalizeInvertedWebViewportMetrics,
  resolveScrollOrigin,
  TurnScrollController,
  type ScrollDirectionSample,
  type TurnScrollControllerSnapshot,
  type LatestTurnMeasurementChange,
} from "@opencraft/timeline-virtualizer";

import { beginTimelineElementReflow, preserveTimelineElementPositionOnReflow, type TimelineReflowLease } from "./reflow";
import {
  observeBorderBoxHeight,
  resizeObserverBlockSize,
} from "./measurement";

interface WebConversationScrollPortListeners {
  readonly keydown?: (event: KeyboardEvent) => void;
  readonly pointercancel?: (event: PointerEvent) => void;
  readonly pointerdown?: (event: PointerEvent) => void;
  readonly pointerup?: (event: PointerEvent) => void;
  readonly scroll?: (event: Event) => void;
  readonly touchcancel?: (event: TouchEvent) => void;
  readonly touchend?: (event: TouchEvent) => void;
  readonly touchmove?: (event: TouchEvent) => void;
  readonly touchstart?: (event: TouchEvent) => void;
  readonly wheel?: (event: WheelEvent) => void;
}

export interface WebConversationScrollBehavior {
  /** Cancels higher-level target positioning as soon as physical input begins. */
  readonly onUserInput?: () => void;
  readonly onUserScrollToTop?: () => void;
}

export interface WebConversationTurnMeasurement {
  readonly turnKey: string;
  readonly heightPx: number;
}

export interface WebConversationMeasurementBatch {
  /** Invalidates asynchronous work from an earlier viewport lifetime. */
  readonly generation: number;
  readonly measurements: readonly WebConversationTurnMeasurement[];
  readonly source:
    | { readonly kind: "resize-observer" }
    | {
        readonly kind: "renderer";
        readonly requests: readonly WebConversationLayoutInvalidation[];
      };
}

export interface WebConversationLayoutInvalidation {
  readonly documentId: string;
  readonly generation: number;
  readonly geometryChanged: boolean;
  readonly reason: string;
}

export function shouldAcceptWebConversationInvalidation(
  latestGeneration: number | undefined,
  request: WebConversationLayoutInvalidation,
): boolean {
  return request.geometryChanged && request.generation >= (latestGeneration ?? 0);
}

export type WebConversationMeasurementListener = (
  batch: WebConversationMeasurementBatch,
) => void;

/** r3562 has two measurements, not two competing follow policies. */
export type WebConversationLatestTurnMeasurement =
  | (LatestTurnMeasurementChange & {
      readonly kind: "turn-height";
      readonly element: HTMLElement | null;
    })
  | {
      readonly kind: "follow-content";
      readonly turnKey: string;
      readonly followContentHeightPx: number;
      readonly element: HTMLElement;
    };

/**
 * Sole DOM owner for one mounted Web conversation viewport.
 *
 * React owns projection state; this owner owns platform resources: the
 * scrollport, Turn elements, ResizeObserver, reflow anchors and the platform
 * TurnScrollController. No renderer is allowed to construct a competing DOM
 * observer for the same Turn rows.
 */
export class WebConversationViewportOwner {
  readonly scrollElementRef: { current: HTMLDivElement | null } = { current: null };
  readonly turnElementsRef: { current: Map<string, HTMLDivElement> } = {
    current: new Map(),
  };
  readonly scrollController: TurnScrollController;

  private measurementListener: WebConversationMeasurementListener | null = null;
  private latestTurnMeasurementListener: ((measurement: WebConversationLatestTurnMeasurement) => void) | null = null;
  private readonly followContentElements = new Map<HTMLElement, { readonly turnKey: string; heightPx: number }>();
  private resizeObserver: ResizeObserver | null = null;
  private readonly newlyMountedTurns = new Map<string, HTMLDivElement>();
  private generation = 1;
  private disposed = false;
  private measurementFrame: number | null = null;
  private readonly pendingInvalidations = new Map<string, WebConversationLayoutInvalidation>();
  private readonly latestDocumentGenerations = new Map<string, number>();
  private readonly platformResources = new Set<() => void>();
  private footerElement: HTMLElement | null = null;
  private footerObservationDispose: (() => void) | null = null;
  private footerHeightPx: number | null = null;
  private footerResizeViewportPreserveDisabled = false;
  private reflowLease: TimelineReflowLease | null = null;

  constructor(initialDistanceFromBottomPx: number) {
    this.scrollController = new TurnScrollController({
      getMetrics: () => {
        const element = this.scrollElementRef.current;
        return element === null
          ? {
              distanceFromBottomPx: Math.max(0, initialDistanceFromBottomPx),
              viewportHeightPx: 0,
              scrollHeightPx: 0,
            }
          : normalizeInvertedWebViewportMetrics({
              contentHeightPx: element.scrollHeight,
              viewportHeightPx: element.clientHeight,
              scrollTopPx: element.scrollTop,
            });
      },
      writeDistanceFromBottomPx: (distance, behavior) => {
        const element = this.scrollElementRef.current;
        if (element === null) return;
        element.scrollTo({
          behavior: behavior === "smooth" ? "smooth" : "instant",
          top: invertedWebScrollTopForDistance(distance),
        });
      },
      now: () => performance.now(),
      requestFrame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (handle) => window.cancelAnimationFrame(handle),
    }, initialDistanceFromBottomPx);
  }

  readonly attachScrollElement = (element: HTMLDivElement | null): void => {
    if (this.disposed) return;
    if (this.scrollElementRef.current === element) return;
    this.cancelReflowAnchor();
    this.scrollElementRef.current?.style.removeProperty("--thread-scroll-padding-bottom");
    this.scrollElementRef.current = element;
    this.rebindFooterObservation();
  };

  /**
   * ThreadScrollLayout owns footer geometry. React only attaches the element;
   * no footer height is mirrored through component state or the virtualizer.
   */
  readonly attachFooterElement = (element: HTMLElement | null): void => {
    if (this.disposed || this.footerElement === element) return;
    this.footerElement = element;
    this.rebindFooterObservation();
  };

  getFooterScrollPaddingPx(): number {
    const value = Number.parseFloat(
      this.scrollElementRef.current?.style.getPropertyValue(
        "--thread-scroll-padding-bottom",
      ) ?? "",
    );
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  }

  setFooterResizeViewportPreserveDisabled(disabled: boolean): void {
    this.footerResizeViewportPreserveDisabled = disabled;
  }

  /** Async geometry from a retired viewport lifetime must fail closed. */
  isCurrentGeneration(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  setMeasurementListener(listener: WebConversationMeasurementListener | null): void {
    if (this.disposed) return;
    this.measurementListener = listener;
  }

  setLatestTurnMeasurementListener(listener: ((measurement: WebConversationLatestTurnMeasurement) => void) | null): void {
    if (!this.disposed) this.latestTurnMeasurementListener = listener;
  }

  /** Called only after the virtualizer has committed the corresponding layout. */
  publishLatestTurnHeightChange(change: LatestTurnMeasurementChange): void {
    if (this.disposed) return;
    this.latestTurnMeasurementListener?.({
      ...change,
      kind: "turn-height",
      element: this.getTurnElement(change.turnKey),
    });
  }

  /** React ref cleanup retires the exact registration, including exiting rows. */
  observeLatestTurnFollowContent(turnKey: string, element: HTMLDivElement | null): (() => void) | undefined {
    if (this.disposed || element === null) return;
    const registration = { turnKey, heightPx: 0 };
    this.followContentElements.set(element, registration);
    this.ensureResizeObserver().observe(element, { box: "border-box" });
    return () => {
      if (this.followContentElements.get(element) !== registration) return;
      this.followContentElements.delete(element);
      this.resizeObserver?.unobserve(element);
    };
  }

  private publishFollowContentMeasurement(turnKey: string): void {
    let heightPx = 0;
    let lastElement: HTMLElement | null = null;
    for (const [element, measurement] of this.followContentElements) {
      if (measurement.turnKey !== turnKey) continue;
      heightPx += measurement.heightPx;
      if (lastElement === null || (lastElement.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) {
        lastElement = element;
      }
    }
    if (lastElement !== null) this.latestTurnMeasurementListener?.({
      kind: "follow-content",
      turnKey,
      followContentHeightPx: heightPx,
      element: lastElement,
    });
  }

  /** Coalesces renderer requests into one measured layout transaction per frame. */
  readonly requestLayoutMeasurement = (
    request: WebConversationLayoutInvalidation,
  ): void => {
    if (this.disposed) return;
    const latest = this.latestDocumentGenerations.get(request.documentId) ?? 0;
    if (request.generation < latest) return;
    if (request.generation > latest) {
      this.latestDocumentGenerations.set(request.documentId, request.generation);
      const pending = this.pendingInvalidations.get(request.documentId);
      if (pending !== undefined && pending.generation < request.generation) {
        this.pendingInvalidations.delete(request.documentId);
      }
    }
    // Even a paint-only request advances the document generation fence. It
    // must be able to invalidate an older queued geometry request without
    // forcing a redundant Turn measurement of its own.
    if (!request.geometryChanged) return;
    this.pendingInvalidations.set(request.documentId, request);
    if (this.measurementFrame !== null) return;
    this.measurementFrame = window.requestAnimationFrame(() => {
      this.measurementFrame = null;
      if (this.disposed || this.pendingInvalidations.size === 0) return;
      const requests = [...this.pendingInvalidations.values()];
      this.pendingInvalidations.clear();
      const measurements = Object.entries(this.measureMountedTurns()).map(
        ([turnKey, heightPx]) => ({ turnKey, heightPx }),
      );
      if (measurements.length === 0) return;
      this.measurementListener?.({
        generation: this.generation,
        measurements,
        source: { kind: "renderer", requests },
      });
    });
  };

  readonly observeTurn = (turnKey: string, element: HTMLDivElement | null): void => {
    if (this.disposed) return;
    const previous = this.turnElementsRef.current.get(turnKey);
    if (previous === element) return;
    if (previous !== undefined) {
      this.resizeObserver?.unobserve(previous);
      this.turnElementsRef.current.delete(turnKey);
      this.newlyMountedTurns.delete(turnKey);
    }
    if (element === null) return;
    element.dataset.virtualizedTurnKey = turnKey;
    this.turnElementsRef.current.set(turnKey, element);
    this.newlyMountedTurns.set(turnKey, element);
    this.ensureResizeObserver().observe(element, { box: "border-box" });
  }

  private bindScrollPortListeners(listeners: WebConversationScrollPortListeners): () => void {
    const element = this.scrollElementRef.current;
    if (element === null || this.disposed) return () => undefined;
    const abortController = new AbortController();
    const options: AddEventListenerOptions = {
      passive: true,
      signal: abortController.signal,
    };
    for (const [type, listener] of Object.entries(listeners)) {
      if (listener !== undefined) element.addEventListener(type, listener as EventListener, options);
    }
    return this.ownPlatformResource(() => abortController.abort());
  }

  /**
   * Codex ThreadScrollLayout's Web input transaction. DOM evidence remains in
   * the platform owner; Conversation observes semantic scroll notifications.
   */
  bindScrollBehavior(callbacks: WebConversationScrollBehavior): () => void {
    const element = this.scrollElementRef.current;
    if (element === null || this.disposed) return () => undefined;
    let inputDirection: ScrollDirectionSample | null = null;
    let pointerSnapshot: { scrollHeightPx: number; scrollTopPx: number } | null = null;
    let touchPoint: { identifier: number; x: number; y: number } | null = null;

    const loadOlderAtTop = () => {
      // Input can arrive before its ensuing scroll event. Sample the physical
      // viewport here; the controller remains the owner of durable distance.
      const metrics = normalizeInvertedWebViewportMetrics({
        contentHeightPx: element.scrollHeight,
        viewportHeightPx: element.clientHeight,
        scrollTopPx: element.scrollTop,
      });
      if (distanceFromTopPx({
        contentHeightPx: metrics.scrollHeightPx,
        distanceFromBottomPx: metrics.distanceFromBottomPx,
        viewportHeightPx: metrics.viewportHeightPx,
      }) <= 64) callbacks.onUserScrollToTop?.();
    };
    const markDirection = (direction: "away" | "toward" | null) => {
      this.scrollController.cancelScrollAnimation();
      if (direction === null) {
        inputDirection = null;
        return;
      }
      const metrics = normalizeInvertedWebViewportMetrics({
        contentHeightPx: element.scrollHeight,
        viewportHeightPx: element.clientHeight,
        scrollTopPx: element.scrollTop,
      });
      const canMove = direction === "away"
        ? distanceFromTopPx({
            contentHeightPx: metrics.scrollHeightPx,
            distanceFromBottomPx: metrics.distanceFromBottomPx,
            viewportHeightPx: metrics.viewportHeightPx,
          }) > 0
        : metrics.distanceFromBottomPx > 0;
      inputDirection = canMove
        ? { direction, lastAtMs: performance.now() }
        : null;
    };
    const handleWheel = (event: WheelEvent) => {
      this.cancelReflowAnchor();
      callbacks.onUserInput?.();
      const delta = normalizeWheelDeltaPx(
        event.deltaY,
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 1
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? 2
            : 0,
        element.clientHeight,
      );
      this.scrollController.recordWheelDelta(delta);
      markDirection(directionForWheelDelta(delta));
      if (event.deltaY < 0) loadOlderAtTop();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement
        && target !== element
        && (
          target.isContentEditable
          || target.closest("input, select, textarea") !== null
          || ((event.key === " " || event.key === "Spacebar")
            && target.closest("button, [role='button']") !== null)
        )
      ) return;
      const direction = keyboardScrollDirection(event);
      if (direction === null) return;
      this.cancelReflowAnchor();
      callbacks.onUserInput?.();
      this.scrollController.cancelPendingLayoutPreservation();
      markDirection(direction);
    };
    const handlePointerDown = (event: PointerEvent) => {
      this.cancelReflowAnchor();
      callbacks.onUserInput?.();
      inputDirection = null;
      pointerSnapshot = event.pointerType === "mouse" && event.target === element
        ? { scrollHeightPx: element.scrollHeight, scrollTopPx: element.scrollTop }
        : null;
      if (event.pointerType === "mouse" && event.target === element) {
        this.scrollController.cancelPendingLayoutPreservation();
      }
      this.scrollController.cancelScrollAnimation();
    };
    const clearPointer = () => { pointerSnapshot = null; };
    const handleTouchStart = (event: TouchEvent) => {
      callbacks.onUserInput?.();
      const touch = event.touches.length === 1 ? event.touches[0] : undefined;
      touchPoint = touch === undefined ? null : {
        identifier: touch.identifier,
        x: touch.clientX,
        y: touch.clientY,
      };
    };
    const handleTouchMove = (event: TouchEvent) => {
      const previous = touchPoint;
      const touch = event.touches.length === 1 ? event.touches[0] : undefined;
      if (previous === null || touch === undefined || touch.identifier !== previous.identifier) {
        touchPoint = null;
        return;
      }
      const direction = directionForTouchDelta(
        touch.clientX - previous.x,
        touch.clientY - previous.y,
      );
      if (direction === null) return;
      touchPoint = null;
      this.cancelReflowAnchor();
      this.scrollController.cancelPendingLayoutPreservation();
      markDirection(direction);
      if (direction === "away") loadOlderAtTop();
    };
    const clearTouch = () => { touchPoint = null; };
    const handleScroll = () => {
      const physicalDistance = Math.max(0, -element.scrollTop);
      if (
        pointerSnapshot !== null
        && pointerSnapshot.scrollHeightPx === element.scrollHeight
        && pointerSnapshot.scrollTopPx !== element.scrollTop
      ) {
        markDirection(directionForDistanceChange(
          this.scrollController.getLastScrollDistanceFromBottomPx(),
          physicalDistance,
        ));
        pointerSnapshot = null;
      }
      const now = performance.now();
      const report = this.scrollController.reportPlatformScroll((change) =>
        resolveScrollOrigin(
          inputDirection,
          change.previousDistanceFromBottomPx,
          change.currentDistanceFromBottomPx,
          now,
        )
      );
      if (report.origin === "user" && inputDirection !== null) {
        inputDirection = report.distanceFromBottomPx <= 24
          ? null
          : { ...inputDirection, lastAtMs: now };
        if (report.distanceFromBottomPx > report.previousDistanceFromBottomPx) {
          loadOlderAtTop();
        }
      }
    };

    return this.bindScrollPortListeners({
      keydown: handleKeyDown,
      pointercancel: clearPointer,
      pointerdown: handlePointerDown,
      pointerup: clearPointer,
      scroll: handleScroll,
      touchcancel: clearTouch,
      touchend: clearTouch,
      touchmove: handleTouchMove,
      touchstart: handleTouchStart,
      wheel: handleWheel,
    });
  }

  observeViewportGeometry(onChange: () => void): () => void {
    const element = this.scrollElementRef.current;
    if (element === null || this.disposed) return () => undefined;
    // r3562 oO: initialize once, then coalesce scrollport/window resizes.
    // Content height belongs to the virtualizer's row measurement transaction.
    // Observing its ancestor here creates a shallower, skipped RO notification
    // when a row callback synchronously commits the virtual layout.
    onChange();
    let frame: number | null = null;
    const update = () => {
      frame ??= window.requestAnimationFrame(() => {
        frame = null;
        onChange();
      });
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    window.addEventListener("resize", update, { passive: true });
    return this.ownPlatformResource(() => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
      if (frame !== null) window.cancelAnimationFrame(frame);
    });
  }

  observeResponseSpacer(
    spacer: Element,
    onIntersection: (record: IntersectionObserverEntry) => void,
  ): () => void {
    const root = this.scrollElementRef.current;
    if (root === null || this.disposed || typeof IntersectionObserver === "undefined") {
      return () => undefined;
    }
    const observer = new IntersectionObserver((records) => {
      const record = records.at(-1);
      if (record !== undefined) onIntersection(record);
    }, {
      root,
      threshold: Array.from({ length: 101 }, (_, index) => index / 100),
    });
    observer.observe(spacer);
    return this.ownPlatformResource(() => observer.disconnect());
  }

  getTurnElement(turnKey: string): HTMLDivElement | null {
    return this.turnElementsRef.current.get(turnKey) ?? null;
  }

  measureMountedTurns(): Readonly<Record<string, number>> {
    const measurements: Record<string, number> = {};
    for (const [turnKey, element] of this.turnElementsRef.current) {
      const height = element.offsetHeight;
      if (height > 0) measurements[turnKey] = height;
    }
    return measurements;
  }

  /** r3562's pre-paint mount queue, separate from asynchronous resize records. */
  measureNewlyMountedTurns(): readonly WebConversationTurnMeasurement[] {
    const measurements: WebConversationTurnMeasurement[] = [];
    for (const [turnKey, element] of this.newlyMountedTurns) {
      if (this.turnElementsRef.current.get(turnKey) !== element) continue;
      if (element.offsetHeight > 0) measurements.push({ turnKey, heightPx: element.offsetHeight });
    }
    this.newlyMountedTurns.clear();
    return measurements;
  }

  captureReflowAnchor(target: EventTarget | null): void {
    const scrollElement = this.scrollElementRef.current;
    if (scrollElement === null || !(target instanceof HTMLElement)) return;
    const anchor = target.closest<HTMLElement>(
      "[aria-expanded], [data-timeline-preserve-on-reflow='true']",
    );
    if (
      anchor === null
      || anchor.dataset.timelineReflowOwned === "true"
      || anchor.closest("[data-thread-user-message-navigation-content='true']") === null
    ) return;
    this.cancelReflowAnchor();
    const cancel = preserveTimelineElementPositionOnReflow(anchor, scrollElement);
    this.reflowLease = { complete: cancel, cancel };
  }

  /** One interaction owns the local anchor; old callbacks can only release their lease. */
  readonly beginReflowAnchor = (anchor: HTMLElement): TimelineReflowLease | null => {
    this.cancelReflowAnchor();
    const scrollElement = this.scrollElementRef.current;
    if (this.disposed || scrollElement === null || !scrollElement.contains(anchor)) return null;
    const lease = beginTimelineElementReflow(anchor, scrollElement);
    this.reflowLease = lease;
    return lease;
  };

  private cancelReflowAnchor(): void {
    this.reflowLease?.cancel();
    this.reflowLease = null;
  }

  getScrollSnapshot(): TurnScrollControllerSnapshot {
    return this.scrollController.getSnapshot();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelReflowAnchor();
    this.generation += 1;
    this.measurementListener = null;
    this.latestTurnMeasurementListener = null;
    this.followContentElements.clear();
    if (this.measurementFrame !== null) window.cancelAnimationFrame(this.measurementFrame);
    this.measurementFrame = null;
    this.pendingInvalidations.clear();
    this.latestDocumentGenerations.clear();
    this.footerObservationDispose?.();
    this.footerObservationDispose = null;
    this.footerElement = null;
    this.footerHeightPx = null;
    this.scrollElementRef.current?.style.removeProperty("--thread-scroll-padding-bottom");
    for (const dispose of [...this.platformResources]) dispose();
    this.platformResources.clear();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.turnElementsRef.current.clear();
    this.newlyMountedTurns.clear();
    this.scrollElementRef.current = null;
    this.scrollController.dispose();
  }

  private rebindFooterObservation(): void {
    this.footerObservationDispose?.();
    this.footerObservationDispose = null;
    this.footerHeightPx = null;
    const footer = this.footerElement;
    const scrollElement = this.scrollElementRef.current;
    if (footer === null || scrollElement === null) {
      scrollElement?.style.removeProperty("--thread-scroll-padding-bottom");
      return;
    }
    this.footerObservationDispose = observeBorderBoxHeight(footer, (heightPx) => {
      if (this.disposed || this.footerElement !== footer || this.scrollElementRef.current !== scrollElement) {
        return;
      }
      const previousHeightPx = this.footerHeightPx;
      if (previousHeightPx === heightPx) return;
      this.footerHeightPx = heightPx;
      scrollElement.style.setProperty(
        "--thread-scroll-padding-bottom",
        `${footerScrollPaddingPx(heightPx)}px`,
      );
      const compensatedDistance = footerResizeCompensation({
        currentDistanceFromBottomPx: normalizeInvertedWebViewportMetrics({
          contentHeightPx: scrollElement.scrollHeight,
          viewportHeightPx: scrollElement.clientHeight,
          scrollTopPx: scrollElement.scrollTop,
        }).distanceFromBottomPx,
        footerResizeViewportPreserveDisabled: this.footerResizeViewportPreserveDisabled,
        isScrollAnimationActive: this.scrollController.getSnapshot().isScrollAnimationActive,
        nextFooterHeightPx: heightPx,
        previousFooterHeightPx: previousHeightPx,
      });
      if (compensatedDistance !== null) {
        this.scrollController.scrollToDistanceFromBottomPx(compensatedDistance, "instant");
      }
    });
  }

  private ensureResizeObserver(): ResizeObserver {
    if (this.resizeObserver !== null) return this.resizeObserver;
    this.resizeObserver = new ResizeObserver((records) => {
      if (this.disposed) return;
      const measurements: WebConversationTurnMeasurement[] = [];
      const changedFollowTurns = new Set<string>();
      for (const record of records) {
        const followContent = this.followContentElements.get(record.target as HTMLElement);
        if (followContent !== undefined) {
          followContent.heightPx = resizeObserverBlockSize(record);
          changedFollowTurns.add(followContent.turnKey);
          continue;
        }
        const key = (record.target as HTMLElement).dataset.virtualizedTurnKey;
        if (
          key === undefined
          || this.turnElementsRef.current.get(key) !== record.target
        ) continue;
        measurements.push({
          turnKey: key,
          heightPx: Math.max(1, resizeObserverBlockSize(record)),
        });
      }
      if (measurements.length > 0) this.measurementListener?.({
        generation: this.generation,
        measurements,
        source: { kind: "resize-observer" },
      });
      // Row transactions may synchronously change/unmount follow targets.
      // Read the live registrations only after those transactions finish.
      for (const turnKey of changedFollowTurns) this.publishFollowContentMeasurement(turnKey);
    });
    return this.resizeObserver;
  }

  private ownPlatformResource(disposeResource: () => void): () => void {
    let active = true;
    const dispose = () => {
      if (!active) return;
      active = false;
      this.platformResources.delete(dispose);
      disposeResource();
    };
    this.platformResources.add(dispose);
    return dispose;
  }
}

export function createWebConversationViewportOwner(
  initialDistanceFromBottomPx: number,
): WebConversationViewportOwner {
  return new WebConversationViewportOwner(initialDistanceFromBottomPx);
}
