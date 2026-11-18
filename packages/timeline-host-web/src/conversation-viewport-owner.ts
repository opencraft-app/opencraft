import { observeTimelineScrollFrames, recordTimelineDiagnostic, timelineDiagnosticsEnabled, timelineDiagnosticId } from "./diagnostics";
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

import { beginTimelineElementReflow, OPENCRAFT_REFLOW_PRESERVATION_MS, type TimelineReflowLease } from "./reflow";
import { WebConversationContentWindow, type ConversationContentMeasurement } from "./content-window";
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

/** A synchronous DOM handoff, not a scroll-position writer or a retained floor. */
export interface WebConversationWindowHandoff {
  complete(): void;
  cancel(): void;
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

/** Separate the two measurements from follow-policy ownership. */
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
  readonly contentWindow = new WebConversationContentWindow();
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
  private diagnosticTouching = false;
  private diagnosticLastTouchEnd = -Infinity;
  private scrollFrameDiagnosticsDispose: (() => void) | null = null;
  private generation = 1;
  private disposed = false;
  private measurementFrame: number | null = null;
  private readonly pendingInvalidations = new Map<string, WebConversationLayoutInvalidation>();
  private readonly latestDocumentGenerations = new Map<string, number>();
  private readonly platformResources = new Set<() => void>();
  private footerElement: HTMLElement | null = null;
  private footerObservationDispose: (() => void) | null = null;
  private footerHeightPx: number | null = null;
  private readonly footerHeightListeners = new Set<() => void>();
  readonly getFooterHeight = (): number => this.footerHeightPx ?? 0;
  readonly subscribeFooterHeight = (listener: () => void): (() => void) => {
    this.footerHeightListeners.add(listener);
    return () => { this.footerHeightListeners.delete(listener); };
  };
  private footerResizeViewportPreserveDisabled = false;
  private reflowLease: TimelineReflowLease | null = null;
  private readonly windowHandoffs = new Map<HTMLElement, WebConversationWindowHandoff>();

  /** Called from React's pre-mutation snapshot, while the old window is intact.
   * WebKit can lay out a partially rebuilt query-container subtree during style
   * resolution, even when the DOM mutations themselves have already finished.
   * Keep its scrollable extent until the replacement has been fully styled. */
  protectWindowHandoff(spacer: HTMLElement | null): WebConversationWindowHandoff | null {
    const root = this.scrollElementRef.current;
    if (this.disposed || !root || !spacer || !root.contains(spacer) || root.clientHeight === 0) return null;
    this.windowHandoffs.get(spacer)?.cancel();
    const height = spacer.offsetHeight;
    if (height <= 0) return null;
    const previous = spacer.style.getPropertyValue("min-height");
    const priority = spacer.style.getPropertyPriority("min-height");
    const held = `${Math.ceil(height)}px`;
    spacer.style.setProperty("min-height", held);
    const finish = (complete: boolean) => {
      if (this.windowHandoffs.get(spacer) !== handoff) return;
      this.windowHandoffs.delete(spacer);
      try {
        if (complete && !this.disposed && this.scrollElementRef.current === root && root.contains(spacer) && root.clientHeight > 0) {
          // Resolve new styles and their nested layouts with the floor intact.
          // Removing it first exposes the same intermediate native clamp.
          void spacer.offsetHeight;
        }
      } finally {
        if (spacer.style.getPropertyValue("min-height") === held && spacer.style.getPropertyPriority("min-height") === "") {
          if (previous) spacer.style.setProperty("min-height", previous, priority);
          else spacer.style.removeProperty("min-height");
        }
      }
    };
    const handoff: WebConversationWindowHandoff = {
      complete: () => finish(true),
      cancel: () => finish(false),
    };
    this.windowHandoffs.set(spacer, handoff);
    return handoff;
  }

  private cancelWindowHandoffs(): void {
    for (const handoff of this.windowHandoffs.values()) handoff.cancel();
  }
  private readingAnchor: {
    element: HTMLElement;
    row: HTMLDivElement;
    turnKey: string;
    scrollTop: number;
    top: number;
    width: number;
    viewportHeight: number;
    controllerDistance: number;
  } | null = null;

  /** A row can span the viewport: its total height cannot locate a change
   * above or below the reader. Keep one measured, visible text anchor instead.
   * This is presentation metadata; the scroll controller still owns writes. */
  captureReadingAnchor(measuredHeights: Readonly<Record<string, number>>): void {
    const root = this.scrollElementRef.current;
    // An empty timeline has no reading position. In particular, do not flush
    // the entire Shell's pending layout just to discover this during startup.
    if (!root || this.turnElementsRef.current.size === 0) {
      this.readingAnchor = null;
      return;
    }
    // Ownership guards must run before geometry reads: cancelled/animated
    // viewports cannot publish an anchor, even when layout is dirty.
    if (this.reflowLease || this.scrollController.getState().isScrollAnimationActive) return;
    if (root.clientHeight === 0) return;
    if (-root.scrollTop <= 24) { this.readingAnchor = null; return; }
    const bounds = root.getBoundingClientRect();
    // Overview transforms and viewport resizes do not own reading correction.
    if (Math.abs(bounds.height - root.clientHeight) > 1) return;
    const anchor = this.readingAnchor;
    // A retained text anchor already locates this reader. Streaming
    // elsewhere must not query and measure every paragraph in mounted history.
    // Reuse is geometry-validated, not time-based: pending reflow still keeps
    // the pre-reflow anchor until the measurement transaction compensates it.
    if (anchor && this.turnElementsRef.current.get(anchor.turnKey) === anchor.row
      && root.scrollTop === anchor.scrollTop
      && root.clientWidth === anchor.width && root.clientHeight === anchor.viewportHeight
      && this.scrollController.getLastScrollDistanceFromBottomPx() === anchor.controllerDistance
      && Math.abs(anchor.row.offsetHeight - (measuredHeights[anchor.turnKey] ?? -1)) <= 1
      && root.contains(anchor.element) && anchor.row.contains(anchor.element)) {
      const rect = anchor.element.getBoundingClientRect();
      // A different Turn may have reflowed before its ResizeObserver receipt.
      // Even if this text moved outside the viewport, its old top is still the
      // reading position to restore. Only ownership changes select new text.
      if (rect.width > 0) return;
    }
    for (const [key, row] of this.turnElementsRef.current) {
      const box = row.getBoundingClientRect();
      if (box.bottom <= bounds.top || box.top >= bounds.bottom) continue;
      // A child may already have reflowed before its RO batch is delivered.
      // Do not replace the pre-reflow anchor with that intermediate geometry.
      if (Math.abs(row.offsetHeight - (measuredHeights[key] ?? -1)) > 1) return;
      for (const text of row.querySelectorAll<HTMLElement>('p, pre, li, h1, h2, h3, h4, h5, h6')) {
        const rect = text.getBoundingClientRect();
        if (rect.width > 0 && rect.top >= bounds.top && rect.bottom <= bounds.bottom) {
          this.readingAnchor = {
            element: text,
            row,
            turnKey: key,
            scrollTop: root.scrollTop,
            top: rect.top - bounds.top,
            width: root.clientWidth,
            viewportHeight: root.clientHeight,
            controllerDistance: this.scrollController.getLastScrollDistanceFromBottomPx(),
          };
          return;
        }
      }
    }
    this.readingAnchor = null;
  }

  readingAnchorDistance(): number | null {
    return this.readingAnchorCorrection()?.distanceFromBottomPx ?? null;
  }

  /** Return the physical base with its target so a later commit can apply only
   * the layout delta onto whatever user movement has happened since this read. */
  readingAnchorCorrection(): { distanceFromBottomPx: number; baseDistanceFromBottomPx: number } | null {
    const root = this.scrollElementRef.current, anchor = this.readingAnchor;
    if (!root || !anchor || !root.contains(anchor.element) || this.reflowLease
      || this.scrollController.getState().isScrollAnimationActive || -root.scrollTop <= 24
      || this.scrollController.getLastScrollDistanceFromBottomPx() !== anchor.controllerDistance
      || root.clientWidth !== anchor.width || root.clientHeight !== anchor.viewportHeight) return null;
    const bounds = root.getBoundingClientRect();
    if (Math.abs(bounds.height - root.clientHeight) > 1) return null;
    const physicalScrollTop = root.scrollTop;
    const textDelta = anchor.element.getBoundingClientRect().top - bounds.top - anchor.top;
    // Native touch/momentum can move the port before its scroll event reaches
    // JS. That also moves the text on screen; remove it from the reflow delta.
    const physicalDelta = physicalScrollTop - anchor.scrollTop;
    const delta = textDelta + physicalDelta;
    const baseDistanceFromBottomPx = Math.max(0, -physicalScrollTop);
    const distanceFromBottomPx = Math.max(0, baseDistanceFromBottomPx - delta);
    if (timelineDiagnosticsEnabled()) recordTimelineDiagnostic("reading-anchor-correction", {
      viewport: timelineDiagnosticId(this), before: physicalScrollTop, anchorScrollTop: anchor.scrollTop,
      controllerDistance: anchor.controllerDistance, textDelta, physicalDelta, delta, target: distanceFromBottomPx,
      touching: this.diagnosticTouching, sinceTouchEndMs: Number.isFinite(this.diagnosticLastTouchEnd) ? performance.now() - this.diagnosticLastTouchEnd : null,
    });
    return { distanceFromBottomPx, baseDistanceFromBottomPx };
  }

  constructor(initialDistanceFromBottomPx: number, contentHeights: Readonly<Record<string, number>> = {}, contentMeasurements: Readonly<Record<string, ConversationContentMeasurement>> = {}) {
    this.contentWindow.restore(contentHeights, contentMeasurements);
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
      writeDistanceFromBottomPx: (distance, behavior, reason) => {
        const element = this.scrollElementRef.current;
        if (element === null) return;
        const before = timelineDiagnosticsEnabled() ? element.scrollTop : 0;
        element.scrollTo({
          behavior: behavior === "smooth" ? "smooth" : "instant",
          top: invertedWebScrollTopForDistance(distance),
        });
        if (timelineDiagnosticsEnabled()) recordTimelineDiagnostic("scroll-write", {
          viewport: timelineDiagnosticId(this), reason: reason ?? "controller", behavior,
          before, after: element.scrollTop, requested: -distance, delta: element.scrollTop - before,
          scrollHeight: element.scrollHeight, viewportHeight: element.clientHeight,
          controllerDistance: this.scrollController.getLastScrollDistanceFromBottomPx(),
          touching: this.diagnosticTouching, sinceTouchEndMs: Number.isFinite(this.diagnosticLastTouchEnd) ? performance.now() - this.diagnosticLastTouchEnd : null,
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
    // A local reflow adjustment may precede its native scroll event. Capture
    // measurable geometry while the retiring port still belongs to this owner.
    if ((this.scrollElementRef.current?.clientHeight ?? 0) > 0) {
      this.scrollController.reportGeometry();
    }
    this.cancelReflowAnchor();
    this.cancelWindowHandoffs();
    this.scrollElementRef.current?.style.removeProperty("--thread-scroll-padding-bottom");
    this.scrollElementRef.current?.style.removeProperty("--thread-footer-height");
    this.scrollElementRef.current?.style.removeProperty("--thread-composer-occlusion-height");
    this.scrollElementRef.current?.style.removeProperty("--thread-reading-bottom-inset");
    this.scrollElementRef.current?.style.removeProperty("--thread-reading-clip-left");
    this.scrollElementRef.current?.style.removeProperty("--thread-reading-clip-right");
    this.scrollFrameDiagnosticsDispose?.();
    this.scrollFrameDiagnosticsDispose = null;
    this.scrollElementRef.current = element;
    if (element !== null) this.scrollFrameDiagnosticsDispose = observeTimelineScrollFrames(
      element, this, () => !this.disposed && this.scrollElementRef.current === element,
    );
    this.contentWindow.attach(element);
    this.rebindFooterObservation();
  };

  /**
   * This viewport owner manages footer geometry. React only attaches the element;
   * no footer height is mirrored through component state or the virtualizer.
   */
  readonly attachFooterElement = (element: HTMLElement | null): void => {
    if (this.disposed || this.footerElement === element) return;
    this.footerElement?.style.removeProperty("inset");
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
      // React detaches refs before completing the replacement window. Reading
      // layout here can flush a temporarily shorter tree and clamp scrollTop;
      // restoring the final spacers later does not undo that native movement.
      // Registration diagnostics are identity-only; geometry belongs to the
      // committed measurement batch, never to a ref callback.
      if (timelineDiagnosticsEnabled()) recordTimelineDiagnostic("turn-unmount", { viewport: timelineDiagnosticId(this), row: timelineDiagnosticId(previous) });
      this.resizeObserver?.unobserve(previous);
      this.turnElementsRef.current.delete(turnKey);
      this.newlyMountedTurns.delete(turnKey);
    }
    if (element === null) return;
    if (timelineDiagnosticsEnabled()) recordTimelineDiagnostic("turn-mount", { viewport: timelineDiagnosticId(this), row: timelineDiagnosticId(element) });
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
      if (timelineDiagnosticsEnabled()) {
        this.diagnosticTouching = true;
        recordTimelineDiagnostic("touch-start", { viewport: timelineDiagnosticId(this), scrollTop: element.scrollTop });
      }
      callbacks.onUserInput?.();
      // A contact begins user-owned movement; a pending layout snapshot must not rewind it.
      this.scrollController.cancelPendingLayoutPreservation();
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
    const clearTouch = () => {
      touchPoint = null;
      if (timelineDiagnosticsEnabled()) {
        this.diagnosticTouching = false; this.diagnosticLastTouchEnd = performance.now();
        recordTimelineDiagnostic("touch-end", { viewport: timelineDiagnosticId(this), scrollTop: element.scrollTop });
      }
    };
    const handleScroll = () => {
      if (this.scrollElementRef.current !== element || element.clientHeight === 0) return;
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
      if (timelineDiagnosticsEnabled()) recordTimelineDiagnostic("platform-scroll", {
        viewport: timelineDiagnosticId(this), scrollTop: element.scrollTop, physicalDistance,
        distance: report.distanceFromBottomPx, previous: report.previousDistanceFromBottomPx,
        origin: report.origin, scrollHeight: element.scrollHeight, viewportHeight: element.clientHeight,
        touching: this.diagnosticTouching, sinceTouchEndMs: Number.isFinite(this.diagnosticLastTouchEnd) ? now - this.diagnosticLastTouchEnd : null,
      });
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
    // Initialize once, then coalesce scrollport/window resizes.
    // Content height belongs to the virtualizer's row measurement transaction.
    // Observing its ancestor here creates a shallower, skipped RO notification
    // when a row callback synchronously commits the virtual layout.
    // A retained route has zero geometry while parked. Its observer stays
    // registered so the first measurable resize resumes the original owner.
    const publish = () => {
      if (this.disposed || this.scrollElementRef.current !== element || element.clientHeight === 0) return;
      this.projectFooterInsets();
      onChange();
    };
    publish();
    let frame: number | null = null;
    const update = () => {
      frame ??= window.requestAnimationFrame(() => {
        frame = null;
        publish();
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

  /** Pre-paint mount queue, separate from asynchronous resize records. */
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
    const lease = beginTimelineElementReflow(anchor, scrollElement, {
      durationMs: OPENCRAFT_REFLOW_PRESERVATION_MS,
      onPositionChanged: () => this.scrollController.reportGeometry(),
      onFinish: reason => this.finishReflowAnchor(lease, reason),
    });
    this.reflowLease = lease;
  }

  /** The disclosure owns both compensation and the post-layout physical base.
   * Row RO delivery may precede the anchor's RO/RAF: settle it before choosing
   * a render window, otherwise that window can unmount its own clicked row. */
  synchronizeReflowAnchor(): number | null {
    const lease = this.reflowLease, root = this.scrollElementRef.current;
    if (lease === null || root === null || this.disposed) return null;
    lease.synchronize();
    if (this.reflowLease !== lease || this.scrollElementRef.current !== root) return null;
    return normalizeInvertedWebViewportMetrics({
      contentHeightPx: root.scrollHeight, viewportHeightPx: root.clientHeight, scrollTopPx: root.scrollTop,
    }).distanceFromBottomPx;
  }

  /** One interaction owns the local anchor; old callbacks can only release their lease. */
  readonly beginReflowAnchor = (anchor: HTMLElement): TimelineReflowLease | null => {
    this.cancelReflowAnchor();
    const scrollElement = this.scrollElementRef.current;
    if (this.disposed || scrollElement === null || !scrollElement.contains(anchor)) return null;
    const lease = beginTimelineElementReflow(anchor, scrollElement, {
      onPositionChanged: () => this.scrollController.reportGeometry(),
      onFinish: reason => this.finishReflowAnchor(lease, reason),
    });
    this.reflowLease = lease;
    return lease;
  };

  private finishReflowAnchor(lease: TimelineReflowLease, reason: "settled" | "cancelled"): void {
    if (this.reflowLease !== lease) return;
    this.reflowLease = null;
    this.readingAnchor = null;
    if (reason !== "settled" || this.disposed || !this.scrollElementRef.current?.isConnected) return;
    // Publish the final physical position even if the browser emits no scroll
    // event after clamping a collapsed reverse-flow scrollport.
    this.scrollController.reportGeometry();
    this.captureReadingAnchor(this.measureMountedTurns());
  }

  private cancelReflowAnchor(): void {
    this.readingAnchor = null;
    this.reflowLease?.cancel();
    this.reflowLease = null;
  }

  getScrollSnapshot(): TurnScrollControllerSnapshot {
    return this.scrollController.getSnapshot();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelWindowHandoffs();
    this.scrollFrameDiagnosticsDispose?.();
    this.scrollFrameDiagnosticsDispose = null;
    this.contentWindow.dispose();
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
    this.footerElement?.style.removeProperty("inset");
    this.footerElement = null;
    this.footerHeightPx = null;
    this.scrollElementRef.current?.style.removeProperty("--thread-scroll-padding-bottom");
    this.scrollElementRef.current?.style.removeProperty("--thread-footer-height");
    this.scrollElementRef.current?.style.removeProperty("--thread-composer-occlusion-height");
    this.scrollElementRef.current?.style.removeProperty("--thread-reading-bottom-inset");
    this.scrollElementRef.current?.style.removeProperty("--thread-reading-clip-left");
    this.scrollElementRef.current?.style.removeProperty("--thread-reading-clip-right");
    for (const dispose of [...this.platformResources]) dispose();
    this.platformResources.clear();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.turnElementsRef.current.clear();
    this.newlyMountedTurns.clear();
    this.scrollElementRef.current = null;
    this.footerHeightListeners.clear();
    this.scrollController.dispose();
  }

  private projectFooterInsets(): void {
    const scroll = this.scrollElementRef.current;
    if (this.disposed || scroll === null || scroll.clientWidth === 0) return;
    // Physical edges follow the native scrollbar side. Overlay scrollbars
    // contribute zero; reuse the existing viewport owner and observation.
    const right = Math.max(0, scroll.offsetWidth - scroll.clientWidth - scroll.clientLeft);
    scroll.style.setProperty("--thread-reading-clip-left", `${scroll.clientLeft}px`);
    scroll.style.setProperty("--thread-reading-clip-right", `${right}px`);
    this.footerElement?.style.setProperty("inset", `auto ${right}px 0 ${scroll.clientLeft}px`);
  }

  private rebindFooterObservation(): void {
    this.footerObservationDispose?.();
    this.footerObservationDispose = null;
    this.footerHeightPx = null;
    const footer = this.footerElement;
    const scrollElement = this.scrollElementRef.current;
    if (footer === null || scrollElement === null) {
      scrollElement?.style.removeProperty("--thread-scroll-padding-bottom");
      scrollElement?.style.removeProperty("--thread-footer-height");
      scrollElement?.style.removeProperty("--thread-composer-occlusion-height");
      scrollElement?.style.removeProperty("--thread-reading-bottom-inset");
      scrollElement?.style.removeProperty("--thread-reading-clip-left");
      scrollElement?.style.removeProperty("--thread-reading-clip-right");
      this.footerElement?.style.removeProperty("inset");
      return;
    }
    this.projectFooterInsets();
    this.footerObservationDispose = observeBorderBoxHeight(footer, (heightPx) => {
      if (
        this.disposed || this.footerElement !== footer
        || this.scrollElementRef.current !== scrollElement || scrollElement.clientHeight === 0
      ) {
        return;
      }
      // Reuse the footer's paint observation, independently of scroll policy.
      // Floating file/status pills affect reservation, never the editor's bottom.
      const surfaces = footer.querySelectorAll<HTMLElement>("[data-composer-occlusion-surface]");
      const footerBottom = footer.getBoundingClientRect().bottom;
      // The shell and a non-empty attached rail paint the editing surface.
      // Floating summaries do not. Empty rails have no box and must not turn
      // their zero rect into an occlusion covering the entire viewport.
      let occlusionHeightPx = surfaces.length === 0 ? heightPx : 0;
      for (const surface of surfaces) {
        const bounds = surface.getBoundingClientRect();
        if (bounds.width > 0 && bounds.height > 0)
          occlusionHeightPx = Math.max(occlusionHeightPx, footerBottom - bounds.top);
      }
      scrollElement.style.setProperty("--thread-composer-occlusion-height", `${occlusionHeightPx}px`);
      const editor = footer.querySelector<HTMLElement>('[data-composer-occlusion-surface="editor"]');
      const editorBounds = editor?.getBoundingClientRect();
      let bottomInsetPx = 0;
      if (editor && editorBounds && editorBounds.width > 0 && editorBounds.height > 0) {
        const style = editor.ownerDocument.defaultView?.getComputedStyle(editor);
        const previewScale = Number(scrollElement.closest<HTMLElement>("[data-retained-preview-scale]")?.dataset.retainedPreviewScale ?? 1);
        const scale = Number.isFinite(previewScale) && previewScale > 0 ? previewScale : 1;
        const radius = Math.min(editorBounds.height / (2 * scale), Math.max(
          Number.parseFloat(style?.borderBottomLeftRadius ?? "") || 0,
          Number.parseFloat(style?.borderBottomRightRadius ?? "") || 0,
        ));
        // Stop transcript paint at the start of the lower arc, not at the
        // footer's top: upper corners stay real, lower corners/gaps stay quiet.
        bottomInsetPx = Math.max(0, (scrollElement.getBoundingClientRect().bottom - editorBounds.bottom) / scale + radius);
      }
      scrollElement.style.setProperty("--thread-reading-bottom-inset", `${bottomInsetPx}px`);
      const previousHeightPx = this.footerHeightPx;
      if (previousHeightPx === heightPx) return;
      this.footerHeightPx = heightPx;
      for (const listener of this.footerHeightListeners) listener();
      scrollElement.style.setProperty("--thread-footer-height", `${heightPx}px`);
      scrollElement.style.setProperty(
        "--thread-scroll-padding-bottom",
        `${footerScrollPaddingPx(heightPx)}px`,
      );
      // The first height establishes padding, not a resize compensation.
      // Short-circuit before evaluating geometry arguments after the CSS write.
      if (previousHeightPx === null || this.footerResizeViewportPreserveDisabled
        || this.scrollController.getState().isScrollAnimationActive) return;
      const compensatedDistance = footerResizeCompensation({
        currentDistanceFromBottomPx: normalizeInvertedWebViewportMetrics({
          contentHeightPx: scrollElement.scrollHeight,
          viewportHeightPx: scrollElement.clientHeight,
          scrollTopPx: scrollElement.scrollTop,
        }).distanceFromBottomPx,
        footerResizeViewportPreserveDisabled: this.footerResizeViewportPreserveDisabled,
        isScrollAnimationActive: this.scrollController.getState().isScrollAnimationActive,
        nextFooterHeightPx: heightPx,
        previousFooterHeightPx: previousHeightPx,
      });
      if (compensatedDistance !== null) {
        this.scrollController.scrollToDistanceFromBottomPx(compensatedDistance, "instant");
      }
    }, () => footer.querySelectorAll<HTMLElement>("[data-composer-occlusion-surface]"));
  }

  private ensureResizeObserver(): ResizeObserver {
    if (this.resizeObserver !== null) return this.resizeObserver;
    this.resizeObserver = new ResizeObserver((records) => {
      if (this.disposed || this.scrollElementRef.current?.clientHeight === 0) return;
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
  contentHeights: Readonly<Record<string, number>> = {},
  contentMeasurements: Readonly<Record<string, ConversationContentMeasurement>> = {},
): WebConversationViewportOwner {
  return new WebConversationViewportOwner(initialDistanceFromBottomPx, contentHeights, contentMeasurements);
}
