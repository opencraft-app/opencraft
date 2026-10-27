import { timelineTurnRenderKey, type TimelineTurnView } from "@opencraft/chat-core";
import {
  buildTurnLayout,
  OPENCRAFT_TURN_VIRTUALIZER_CONFIG,
  computeTurnRange,
  createTurnMeasurementTransaction,
  createTurnViewportState,
  createTurnWindowSlice,
  distanceExcludingBottomPadding,
  distanceFromBottomToCenterTurn,
  distanceFromBottomToTargetWithinTurn,
  distanceFromBottomToTopTurn,
  getTurnGeometry,
  reconcileRenderedRangeForEntries,
  reconcileTurnLayoutViewport,
  rekeyTurnMeasurements,
  serializeTurnRestoreState,
  updateTurnViewportState,
  type TurnMeasurementTransaction,
  type VirtualizedTurnRestoreState,
  type VirtualizedTurnListApi,
  type VirtualizedTurnViewportState,
} from "@opencraft/timeline-virtualizer";
import type {
  WebConversationViewportOwner,
  WebConversationLatestTurnMeasurement,
} from "@opencraft/timeline-host-web";
import { useStableEvent } from "@opencraft/react-runtime";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

export interface WebVirtualizedTurnListApi extends VirtualizedTurnListApi {
  cancelPositioning(): void;
  captureRestoreSnapshot(): {
    readonly distanceFromBottomPx: number;
    readonly virtualizedTurnList: VirtualizedTurnRestoreState | null;
  };
}

export interface VirtualizedConversationTurnsProps {
  readonly entries: readonly TimelineTurnView[];
  readonly timelineRevision: number;
  readonly viewportOwner: WebConversationViewportOwner;
  readonly initialRestoreState: VirtualizedTurnRestoreState | null;
  readonly initialDistanceFromBottomPx: number;
  readonly getBottomScrollPaddingPx?: () => number;
  readonly preserveMeasuredTurnViewport: boolean;
  /** Natural scrolling keeps mounted content in flow while measurements catch up. */
  readonly expandToMountedContent?: boolean;
  readonly getPendingRestoreScrollDistanceFromBottomPx?: () => number | null;
  readonly restoreScrollDistanceFromBottomPx?: () => void;
  readonly onLatestTurnMeasurement?: (
    measurement: WebConversationLatestTurnMeasurement,
  ) => void;
  readonly onApiChange: (api: WebVirtualizedTurnListApi | null) => void;
  readonly onBeforeTargetPosition?: () => void;
  readonly onVisibleContentReady?: () => void;
  readonly visibleContentReadyKey?: object;
  /** History fill consumes committed list geometry, not ancestor DOM resizes. */
  readonly onContentLayoutCommitted?: () => void;
  readonly renderTurn: (
    entry: TimelineTurnView,
    isLatest: boolean,
  ) => ReactNode;
}

interface PendingScrollRequest {
  readonly align: "center" | "top";
  readonly behavior: "instant" | "smooth";
  cancelSettlement: (() => void) | null;
  readonly complete: (
    result: "positioned" | "cancelled" | "unavailable",
  ) => void;
  readonly minimumTimelineRevision: number;
  phase: "awaiting-render" | "scrolling";
  readonly targetKey?: string;
  readonly topAlignmentInsetPx?: number;
  readonly turnKey: string;
}

function MeasuredTurnRow({
  turnKey,
  constrainedHeightPx,
  observeTurn,
  children,
}: {
  readonly turnKey: string;
  readonly constrainedHeightPx: number | undefined;
  readonly observeTurn: (
    turnKey: string,
    element: HTMLDivElement | null,
  ) => void;
  readonly children: ReactNode;
}) {
  const attach = useCallback(
    (element: HTMLDivElement | null) => observeTurn(turnKey, element),
    [observeTurn, turnKey],
  );
  return (
    <div
      className="thread-virtualizer-row"
      style={
        constrainedHeightPx === undefined
          ? undefined
          : { height: constrainedHeightPx, overflow: "hidden" }
      }
    >
      <div data-virtualized-turn-content="" ref={attach}>
        {children}
      </div>
    </div>
  );
}

/**
 * Child owner of measured heights, virtual layout, render window
 * and targeting. It has no Activity identity, submit snapshot, follow mode,
 * response animation or provider state. Response policy lives in its parent.
 */
const noResponsePadding = () => 0;

export function VirtualizedConversationTurns({
  entries,
  timelineRevision,
  viewportOwner,
  initialRestoreState,
  initialDistanceFromBottomPx,
  getBottomScrollPaddingPx = noResponsePadding,
  preserveMeasuredTurnViewport,
  expandToMountedContent = false,
  getPendingRestoreScrollDistanceFromBottomPx,
  restoreScrollDistanceFromBottomPx,
  onLatestTurnMeasurement,
  onApiChange,
  onBeforeTargetPosition,
  onVisibleContentReady,
  visibleContentReadyKey,
  onContentLayoutCommitted,
  renderTurn,
}: VirtualizedConversationTurnsProps) {
  const scrollRef = viewportOwner.scrollElementRef;
  const rowElements = viewportOwner.turnElementsRef;
  const scrollController = viewportOwner.scrollController;
  const virtualizerSpacerRef = useRef<HTMLDivElement>(null);
  const [storedMeasuredHeightsByKey, setMeasuredHeightsByKey] = useState<
    Readonly<Record<string, number>>
  >(() => initialRestoreState?.turnHeightsByKey ?? {});
  const committedEntriesRef = useRef(entries);
  const measuredHeightsByKey = useMemo(() => rekeyTurnMeasurements(
    committedEntriesRef.current, entries, storedMeasuredHeightsByKey, timelineTurnRenderKey,
  ), [entries, storedMeasuredHeightsByKey]);
  useLayoutEffect(() => {
    committedEntriesRef.current = entries;
    if (measuredHeightsByKey !== storedMeasuredHeightsByKey)
      setMeasuredHeightsByKey(measuredHeightsByKey);
  }, [entries, measuredHeightsByKey, storedMeasuredHeightsByKey]);
  const layout = useMemo(
    () => buildTurnLayout(entries, measuredHeightsByKey),
    [entries, measuredHeightsByKey],
  );
  const [viewport, setViewport] = useState<VirtualizedTurnViewportState>(() =>
    createTurnViewportState(
      layout,
      distanceExcludingBottomPadding(
        initialDistanceFromBottomPx,
        getBottomScrollPaddingPx(),
      ),
      OPENCRAFT_TURN_VIRTUALIZER_CONFIG.fallbackViewportHeightPx,
      initialRestoreState,
    ),
  );
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const previousLayout = useRef(layout);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const measuredHeightsRef = useRef(measuredHeightsByKey);
  measuredHeightsRef.current = measuredHeightsByKey;
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  // Post-commit notification only. It cannot take over measurement, response
  // follow, or scroll compensation; those complete in the layout transaction.
  useEffect(() => {
    onContentLayoutCommitted?.();
  }, [layout.totalHeightPx, entries.length, onContentLayoutCommitted]);
  const pendingMeasurementTransactionRef =
    useRef<TurnMeasurementTransaction | null>(null);
  const measurementCommittedHeightsRef = useRef<Readonly<
    Record<string, number>
  > | null>(null);
  const pendingScrollRequestRef = useRef<PendingScrollRequest | null>(null);
  const [pendingScrollRequest, setPendingScrollRequest] =
    useState<PendingScrollRequest | null>(null);
  const visibleContentReadyRef = useRef<unknown>(Symbol("unpainted"));
  const cancelPendingTargetPosition = useCallback(() => {
    const request = pendingScrollRequestRef.current;
    if (request === null) return;
    pendingScrollRequestRef.current = null;
    request.complete("cancelled");
    setPendingScrollRequest((current) =>
      current === request ? null : current,
    );
  }, []);
  useEffect(
    () => () => cancelPendingTargetPosition(),
    [cancelPendingTargetPosition],
  );

  const updateVirtualViewport = useCallback(
    (distance: number, element: HTMLDivElement) => {
      // An in-flight measurement owns the coherent layout/window pair.
      if (pendingMeasurementTransactionRef.current !== null) return;
      const virtualDistance = distanceExcludingBottomPadding(
        distance,
        getBottomScrollPaddingPx(),
      );
      setViewport((current) =>
        updateTurnViewportState(
          current,
          layoutRef.current,
          virtualDistance,
          element.clientHeight,
        ),
      );
    },
    [getBottomScrollPaddingPx],
  );

  useLayoutEffect(
    () =>
      scrollController.subscribe((snapshot) => {
        const element = scrollRef.current;
        if (element !== null)
          updateVirtualViewport(snapshot.distanceFromBottomPx, element);
      }),
    [scrollController, updateVirtualViewport],
  );

  // Register before the first child measurement, not in the parent's later
  // layout effect. DOM resources stay with the platform owner.
  useLayoutEffect(() => {
    viewportOwner.setLatestTurnMeasurementListener(onLatestTurnMeasurement ?? null);
    return () => viewportOwner.setLatestTurnMeasurementListener(null);
  }, [onLatestTurnMeasurement, viewportOwner]);

  const virtualizedTurnListApi = useMemo<WebVirtualizedTurnListApi>(
    () => ({
      cancelPositioning: cancelPendingTargetPosition,
      captureRestoreSnapshot: () => ({
        // Cleanup can interrupt flushSync before the layout effect applies
        // compensation. Save the position belonging to these measured heights.
        distanceFromBottomPx:
          pendingMeasurementTransactionRef.current?.scrollDistanceFromBottomPx
          ?? scrollController.getLastScrollDistanceFromBottomPx(),
        virtualizedTurnList: serializeTurnRestoreState(
          measuredHeightsRef.current,
          layoutRef.current.turnKeys,
          viewportRef.current.renderedRange,
        ),
      }),
      getEntryGeometry: (turnKey) =>
        getTurnGeometry(layoutRef.current, turnKey),
      getViewportState: () => viewportRef.current,
      positionTarget: (options) =>
        new Promise((resolve) => {
          cancelPendingTargetPosition();
          if (options.signal?.aborted === true) {
            resolve("cancelled");
            return;
          }
          let settled = false;
          let request: PendingScrollRequest;
          const handleAbort = () => {
            if (pendingScrollRequestRef.current === request)
              pendingScrollRequestRef.current = null;
            setPendingScrollRequest((current) =>
              current === request ? null : current,
            );
            request.complete("cancelled");
          };
          request = {
            align: options.align ?? "center",
            behavior: options.behavior ?? "instant",
            cancelSettlement: null,
            complete: (result) => {
              if (settled) return;
              settled = true;
              request.cancelSettlement?.();
              request.cancelSettlement = null;
              options.signal?.removeEventListener("abort", handleAbort);
              resolve(result);
            },
            minimumTimelineRevision: Math.max(
              0,
              options.minimumTimelineRevision ?? 0,
            ),
            phase: "awaiting-render",
            targetKey: options.targetKey,
            topAlignmentInsetPx: options.topAlignmentInsetPx,
            turnKey: options.turnKey,
          };
          options.signal?.addEventListener("abort", handleAbort, {
            once: true,
          });
          pendingScrollRequestRef.current = request;
          setPendingScrollRequest(request);
        }),
    }),
    [cancelPendingTargetPosition, scrollController],
  );

  useLayoutEffect(() => {
    onApiChange?.(virtualizedTurnListApi);
    return () => onApiChange?.(null);
  }, [onApiChange, virtualizedTurnListApi]);

  const finishTurnMeasurementTransaction = useStableEvent(
    (transaction: TurnMeasurementTransaction) => {
      if (transaction.latestTurnHeightChange !== null) {
        viewportOwner.publishLatestTurnHeightChange(
          transaction.latestTurnHeightChange,
        );
      }
      if (transaction.restoreScrollDistanceFromBottom) {
        restoreScrollDistanceFromBottomPx?.();
      } else if (transaction.scrollDistanceFromBottomPx !== null) {
        scrollController.compensateScrollToDistanceFromBottomPx(
          transaction.scrollDistanceFromBottomPx,
        );
      }
    },
  );

  const commitTurnMeasurements = useStableEvent(
    (
      measurements: readonly {
        readonly turnKey: string;
        readonly heightPx: number;
      }[],
      synchronous = true,
    ) => {
      const transaction = createTurnMeasurementTransaction({
        entries: entriesRef.current,
        measurements,
        measuredHeightsByKey: measuredHeightsRef.current,
        layout: layoutRef.current,
        viewport: viewportRef.current,
        currentDistanceFromBottomPx:
          scrollController.getLastScrollDistanceFromBottomPx(),
        bottomPaddingPx: getBottomScrollPaddingPx(),
        preserveMeasuredTurnViewport,
        getPendingRestoreScrollDistanceFromBottomPx: getPendingRestoreScrollDistanceFromBottomPx ?? null,
        previousPendingTransaction: pendingMeasurementTransactionRef.current,
      });
      if (transaction === null) return;
      measuredHeightsRef.current = transaction.measuredHeightsByKey;
      layoutRef.current = transaction.layout;
      viewportRef.current = transaction.viewport;
      measurementCommittedHeightsRef.current = transaction.measuredHeightsByKey;

      if (transaction.preservePlatformScrollForNextLayout) {
        scrollController.preserveScrollPositionForNextLayout();
      }

      const commit = () => {
        setMeasuredHeightsByKey(transaction.measuredHeightsByKey);
        setViewport(transaction.viewport);
      };

      if (
        transaction.canUseLatestTurnFastPath &&
        virtualizerSpacerRef.current !== null
      ) {
        virtualizerSpacerRef.current.style[expandToMountedContent ? "minHeight" : "height"] = `${transaction.layout.totalHeightPx}px`;
        commit();
        finishTurnMeasurementTransaction(transaction);
      } else {
        pendingMeasurementTransactionRef.current = transaction;
        if (synchronous) flushSync(commit);
        else commit();
      }
    },
  );
  useLayoutEffect(() => {
    const measurements = viewportOwner.measureNewlyMountedTurns();
    if (measurements.length > 0) commitTurnMeasurements(measurements, false);
  });
  // Conversation passes no latestTurnSynchronousMeasurementKey (the
  // response wrapper's synchronouslyMeasureLatestTurnUpdates is false).
  // A Turn object change is not permission to measure a transitional tree:
  // AnimatePresence may still contain outgoing work beside the new answer.
  // Newly mounted rows are measured above; existing rows commit via the row
  // observer or an explicit renderer measurement request, not every render.
  useLayoutEffect(() => {
    const transaction = pendingMeasurementTransactionRef.current;
    if (
      transaction === null ||
      transaction.measuredHeightsByKey !== measuredHeightsByKey
    )
      return;
    pendingMeasurementTransactionRef.current = null;
    finishTurnMeasurementTransaction(transaction);
  }, [finishTurnMeasurementTransaction, measuredHeightsByKey]);
  useLayoutEffect(() => {
    viewportOwner.setMeasurementListener(({ generation, measurements }) => {
      if (!viewportOwner.isCurrentGeneration(generation)) return;
      commitTurnMeasurements(measurements);
    });
    return () => viewportOwner.setMeasurementListener(null);
  }, [commitTurnMeasurements, viewportOwner]);
  const observeTurn = viewportOwner.observeTurn;

  useLayoutEffect(() => {
    if (pendingMeasurementTransactionRef.current !== null) return;
    const previous = previousLayout.current;
    previousLayout.current = layout;
    const measurementOwnsLayout =
      measurementCommittedHeightsRef.current === measuredHeightsByKey;
    if (measurementOwnsLayout) measurementCommittedHeightsRef.current = null;
    const element = scrollRef.current;
    if (element === null || pendingScrollRequest !== null) return;
    const distance = reconcileTurnLayoutViewport({
      previousLayout: previous,
      nextLayout: layout,
      measuredHeightsByKey,
      currentDistanceFromBottomPx:
        scrollController.getLastScrollDistanceFromBottomPx(),
      viewportHeightPx: element.clientHeight,
      bottomPaddingPx: getBottomScrollPaddingPx(),
      preserveViewport: preserveMeasuredTurnViewport,
      layoutOwnedByMeasurement: measurementOwnsLayout,
      restorePending: (getPendingRestoreScrollDistanceFromBottomPx?.() ?? null) !== null,
    });
    if (distance !== null)
      scrollController.compensateScrollToDistanceFromBottomPx(distance);
  }, [
    getBottomScrollPaddingPx,
    getPendingRestoreScrollDistanceFromBottomPx,
    layout,
    measuredHeightsByKey,
    pendingScrollRequest,
    preserveMeasuredTurnViewport,
    scrollController,
  ]);

  // Same-count identity handoffs and measurements change the layout too.
  // They cannot wait for a platform scroll event to refresh the window.
  useLayoutEffect(() => {
    if (
      pendingScrollRequest !== null ||
      pendingMeasurementTransactionRef.current !== null
    )
      return;
    const element = scrollRef.current;
    if (element !== null)
      updateVirtualViewport(
        viewportRef.current.distanceFromBottomPx + getBottomScrollPaddingPx(),
        element,
      );
    restoreScrollDistanceFromBottomPx?.();
  }, [
    layout,
    getBottomScrollPaddingPx,
    pendingScrollRequest,
    restoreScrollDistanceFromBottomPx,
    updateVirtualViewport,
  ]);

  useLayoutEffect(() => {
    const request = pendingScrollRequest;
    const element = scrollRef.current;
    if (request === null || element === null) return;
    if (request.phase === "scrolling") return;
    if (timelineRevision < request.minimumTimelineRevision) return;
    const immediateMeasurements = viewportOwner.measureMountedTurns();
    let changed = false;
    for (const [turnKey, height] of Object.entries(immediateMeasurements)) {
      if (Math.abs((measuredHeightsRef.current[turnKey] ?? 0) - height) > 0.5)
        changed = true;
    }
    if (changed) {
      commitTurnMeasurements(
        Object.entries(immediateMeasurements).map(([turnKey, heightPx]) => ({
          turnKey,
          heightPx,
        })),
        false,
      );
      return;
    }
    const currentLayout = layoutRef.current;
    const turnElement = viewportOwner.getTurnElement(request.turnKey);
    // A navigation request is a renderer transaction, not an estimated layout
    // command. Pending state mounts the remote Turn offscreen. Until the exact
    // Turn and requested Item both exist in the committed DOM, keep waiting;
    // completing against the 280px estimate makes the first click inaccurate.
    if (turnElement === null) {
      pendingScrollRequestRef.current = null;
      request.complete("unavailable");
      setPendingScrollRequest((current) =>
        current === request ? null : current,
      );
      return;
    }
    const targetElement =
      request.targetKey === undefined
        ? turnElement
        : ([
            ...turnElement.querySelectorAll<HTMLElement>(
              "[data-content-search-unit-key]",
            ),
          ].find(
            (candidate) =>
              candidate.dataset.contentSearchUnitKey === request.targetKey,
          ) ?? null);
    if (targetElement === null) {
      pendingScrollRequestRef.current = null;
      request.complete("unavailable");
      setPendingScrollRequest((current) =>
        current === request ? null : current,
      );
      return;
    }
    const turnRect = turnElement.getBoundingClientRect();
    const targetRect = targetElement.getBoundingClientRect();
    const distance = distanceFromBottomToTargetWithinTurn({
      align: request.align,
      layout: currentLayout,
      targetHeightPx: targetRect.height,
      targetTopOffsetWithinTurnPx: targetRect.top - turnRect.top,
      topAlignmentInsetPx: request.topAlignmentInsetPx,
      turnKey: request.turnKey,
      viewportHeightPx: element.clientHeight,
    });
    if (distance === null) return;
    // The model ends at the virtualizer spacer. Natural conversation layout
    // can place content padding/footer below it; include that measured tail so
    // a historical prompt is not clipped above the viewport after positioning.
    const spacerRect = virtualizerSpacerRef.current?.getBoundingClientRect();
    const surfaceRect = virtualizerSpacerRef.current?.closest(".thread-scroll-surface")?.getBoundingClientRect();
    const contentTailPx = spacerRect && surfaceRect ? Math.max(0, surfaceRect.bottom - spacerRect.bottom) : 0;
    const destinationDistance = Math.min(
      Math.max(0, element.scrollHeight - element.clientHeight),
      distance + Math.max(getBottomScrollPaddingPx(), contentTailPx),
    );
    onBeforeTargetPosition?.();
    const finishPositioning = () => {
      queueMicrotask(() => {
        if (pendingScrollRequestRef.current !== request) return;
        pendingScrollRequestRef.current = null;
        request.complete("positioned");
        setPendingScrollRequest((current) =>
          current === request ? null : current,
        );
      });
    };
    if (request.behavior === "smooth") {
      request.phase = "scrolling";
      request.cancelSettlement = scrollController.subscribe((metrics) => {
        if (Math.abs(metrics.distanceFromBottomPx - destinationDistance) <= 1)
          finishPositioning();
      });
    }
    scrollController.scrollToDistanceFromBottomPx(
      destinationDistance,
      request.behavior,
      "user",
    );
    updateVirtualViewport(destinationDistance, element);
    if (request.behavior === "instant") finishPositioning();
  }, [
    commitTurnMeasurements,
    layout,
    pendingScrollRequest,
    scrollController,
    timelineRevision,
    updateVirtualViewport,
  ]);

  useEffect(() => {
    if (
      onVisibleContentReady === undefined ||
      visibleContentReadyRef.current === visibleContentReadyKey ||
      pendingScrollRequest !== null ||
      (entries.length > 0 && rowElements.current.size === 0)
    )
      return;
    let secondFrame: number | null = null;
    const firstFrame = window.requestAnimationFrame(() => {
      restoreScrollDistanceFromBottomPx?.();
      secondFrame = window.requestAnimationFrame(() => {
        if (
          visibleContentReadyRef.current === visibleContentReadyKey ||
          pendingScrollRequestRef.current !== null ||
          (entriesRef.current.length > 0 && rowElements.current.size === 0)
        )
          return;
        visibleContentReadyRef.current = visibleContentReadyKey;
        onVisibleContentReady();
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
    };
  }, [
    entries.length,
    onVisibleContentReady,
    visibleContentReadyKey,
    pendingScrollRequest,
    restoreScrollDistanceFromBottomPx,
    viewport.renderedRange,
  ]);

  let renderedRange = viewport.renderedRange;
  if (pendingScrollRequest !== null) {
    const targetDistance =
      pendingScrollRequest.align === "top"
        ? distanceFromBottomToTopTurn({
            layout,
            turnKey: pendingScrollRequest.turnKey,
            topAlignmentInsetPx: pendingScrollRequest.topAlignmentInsetPx,
            viewportHeightPx: viewport.viewportHeightPx,
          })
        : distanceFromBottomToCenterTurn(
            layout,
            pendingScrollRequest.turnKey,
            viewport.viewportHeightPx,
          );
    if (targetDistance !== null) {
      renderedRange = computeTurnRange(
        layout,
        targetDistance,
        viewport.viewportHeightPx,
        OPENCRAFT_TURN_VIRTUALIZER_CONFIG.overscanTurnCount,
      );
    }
  } else {
    renderedRange = reconcileRenderedRangeForEntries(viewport, layout);
  }
  const windowSlice = createTurnWindowSlice(entries, layout, renderedRange);

  return (
    <div
      className="thread-virtualizer-spacer"
      ref={virtualizerSpacerRef}
      // Measured virtual space is a floor. Mounted content can grow before its
      // ResizeObserver transaction arrives; it must still push the footer down.
      style={expandToMountedContent ? { minHeight: windowSlice.totalHeightPx } : { height: windowSlice.totalHeightPx }}
    >
      <div
        className="thread-virtualizer-window"
        style={{ gap: windowSlice.gapPx, marginTop: windowSlice.marginTopPx }}
      >
        {windowSlice.entries.map((turn, sliceIndex) => {
          const index = windowSlice.range.startIndex + sliceIndex;
          const isLatest = index === entries.length - 1;
          const constrained =
            !isLatest && measuredHeightsByKey[turn.turnKey] === undefined
              ? layout.heightsPx[index]
              : undefined;
          return (
            <MeasuredTurnRow
              key={timelineTurnRenderKey(turn)}
              turnKey={turn.turnKey}
              constrainedHeightPx={constrained}
              observeTurn={observeTurn}
            >
              {renderTurn(turn, isLatest)}
            </MeasuredTurnRow>
          );
        })}
      </div>
    </div>
  );
}
