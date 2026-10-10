import { getTimelineUserMessageTargetKey, type TimelineTurnView } from "@opencraft/chat-core";
import {
  NativeTurnMeasurementRegistry,
  NativeTargetPositionTransaction,
  createNativeTurnMountPlan,
  nativeTargetReadiness,
  type NativeConversationViewportOwner,
  type NativeTurnMeasurementLease,
} from "@opencraft/timeline-host-native";
import { useTurnHistoryBackfill } from "@opencraft/timeline-react";
import {
  buildTurnLayout,
  CODEX_TURN_VIRTUALIZER_CONFIG,
  computeTurnRange,
  createTurnMeasurementTransaction,
  createTurnViewportState,
  distanceExcludingBottomPadding,
  distanceFromBottomToCenterTurn,
  distanceFromBottomToTargetWithinTurn,
  distanceFromBottomToTopTurn,
  getTurnGeometry,
  normalizeInitialScrollDistance,
  reconcileRenderedRangeForEntries,
  reconcileTurnLayoutViewport,
  serializeTurnRestoreState,
  updateTurnViewportState,
  type LatestTurnMeasurementChange,
  type TurnMeasurementTransaction,
  type VirtualizedTurnListApi,
  type VirtualizedTurnRestoreState,
  type VirtualizedTurnViewportState,
} from "@opencraft/timeline-virtualizer";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { type LayoutChangeEvent, View } from "react-native";
import {
  NativeTurnTargetContext,
  type NativeTurnTargetLayout,
} from "./native-turn-target-context";
import { selectNativeTargetScrollBehavior } from "./native-target-scroll-policy";

export interface NativeVirtualizedConversationTurnsHandle {
  afterContentSizeCommit(): void;
  cancelPositioning(): void;
  captureRestoreState(): VirtualizedTurnRestoreState | null;
  consumeContentSizeDistanceCandidate(): number | null;
  getEntryGeometry: VirtualizedTurnListApi["getEntryGeometry"];
  isGeometryCommitPending(): boolean;
  requestHistoryFill(): Promise<void>;
  updateViewport(distanceFromBottomPx: number): void;
}

export interface NativeVirtualizedConversationTurnsProps {
  readonly entries: readonly TimelineTurnView[];
  readonly timelineRevision: number;
  readonly viewportOwner: NativeConversationViewportOwner;
  readonly initialRestoreState: VirtualizedTurnRestoreState | null;
  readonly initialDistanceFromBottomPx: number;
  readonly getBottomPaddingPx: () => number;
  readonly preserveMeasuredTurnViewport: boolean;
  readonly getPendingRestoreDistanceFromBottomPx: () => number | null;
  readonly historyKey: string | null;
  readonly loadOlder?: () => void | "stop" | Promise<void | "stop">;
  readonly onLatestTurnMeasurement: (change: LatestTurnMeasurementChange) => void;
  readonly onContentLayout?: (event: LayoutChangeEvent) => void;
  readonly onApiChange?: (api: VirtualizedTurnListApi | null) => void;
  readonly onRestoreCaptureReady?: (
    capture: () => VirtualizedTurnRestoreState | null,
  ) => void;
  readonly onBeforeTargetPosition: () => void;
  readonly renderEmpty: () => ReactNode;
  readonly renderTurn: (turn: TimelineTurnView, isLatest: boolean) => ReactNode;
}

interface PendingTurnPosition {
  readonly turnKey: string;
  readonly targetKey: string | undefined;
  readonly minimumTimelineRevision: number;
  readonly align: "center" | "top";
  readonly behavior: "instant" | "smooth";
  readonly targetWasMountedAtStart: boolean;
  readonly topAlignmentInsetPx: number | undefined;
  phase: "awaiting-render" | "scrolling";
  readonly transaction: NativeTargetPositionTransaction;
  targetLayoutHeightPx: number | null;
  cancelSettlement: (() => void) | null;
  cancelFrame: (() => void) | null;
  readonly complete: (result: "positioned" | "cancelled" | "unavailable") => void;
}

interface NativeMeasuredTurnProps {
  readonly turnKey: string;
  readonly constrainedHeightPx: number | undefined;
  readonly registry: NativeTurnMeasurementRegistry;
  readonly onMeasure: (lease: NativeTurnMeasurementLease, event: LayoutChangeEvent) => void;
  readonly onRetire: (lease: NativeTurnMeasurementLease) => void;
  readonly onTargetLayout: (
    lease: NativeTurnMeasurementLease,
    targetKey: string,
    layout: NativeTurnTargetLayout | null,
  ) => void;
  readonly children: ReactNode;
}

function NativeMeasuredTurn({
  turnKey,
  constrainedHeightPx,
  registry,
  onMeasure,
  onRetire,
  onTargetLayout,
  children,
}: NativeMeasuredTurnProps) {
  const leaseRef = useRef<NativeTurnMeasurementLease | null>(null);
  const attachMeasuredView = useCallback((view: View | null) => {
    const previous = leaseRef.current;
    if (previous !== null) {
      leaseRef.current = null;
      if (registry.retire(previous)) onRetire(previous);
    }
    if (view !== null) leaseRef.current = registry.register(turnKey);
  }, [onRetire, registry, turnKey]);
  const reportTargetLayout = useCallback((
    targetKey: string,
    layout: NativeTurnTargetLayout | null,
  ) => {
    const lease = leaseRef.current;
    if (lease !== null) onTargetLayout(lease, targetKey, layout);
  }, [onTargetLayout]);

  return (
    <NativeTurnTargetContext.Provider value={reportTargetLayout}>
      <View style={constrainedHeightPx === undefined
        ? undefined
        : { height: constrainedHeightPx, overflow: "hidden" }}>
        <View ref={attachMeasuredView} onLayout={(event) => {
          const lease = leaseRef.current;
          if (lease !== null) onMeasure(lease, event);
        }}>
          {children}
        </View>
      </View>
    </NativeTurnTargetContext.Provider>
  );
}

/**
 * Native peer of Web VirtualizedConversationTurns. It owns estimates,
 * measurements, layout, render window, history fill and target positioning.
 * It never selects response follow mode or mutates response spacer geometry.
 */
export const NativeVirtualizedConversationTurns = forwardRef<
  NativeVirtualizedConversationTurnsHandle,
  NativeVirtualizedConversationTurnsProps
>(function NativeVirtualizedConversationTurns({
  entries,
  timelineRevision,
  viewportOwner,
  initialRestoreState,
  initialDistanceFromBottomPx,
  getBottomPaddingPx,
  preserveMeasuredTurnViewport,
  getPendingRestoreDistanceFromBottomPx,
  historyKey,
  loadOlder,
  onLatestTurnMeasurement,
  onContentLayout,
  onApiChange,
  onRestoreCaptureReady,
  onBeforeTargetPosition,
  renderEmpty,
  renderTurn,
}, forwardedRef) {
  const [measuredHeightsByKey, setMeasuredHeightsByKey] = useState<
    Readonly<Record<string, number>>
  >(() => initialRestoreState?.turnHeightsByKey ?? {});
  const layout = useMemo(
    () => buildTurnLayout(entries, measuredHeightsByKey),
    [entries, measuredHeightsByKey],
  );
  const [viewport, setViewport] = useState<VirtualizedTurnViewportState>(() =>
    createTurnViewportState(
      layout,
      distanceExcludingBottomPadding(
        normalizeInitialScrollDistance(initialDistanceFromBottomPx),
        getBottomPaddingPx(),
      ),
      CODEX_TURN_VIRTUALIZER_CONFIG.fallbackViewportHeightPx,
      initialRestoreState,
    ),
  );
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const previousLayoutRef = useRef(layout);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const measuredHeightsRef = useRef(measuredHeightsByKey);
  measuredHeightsRef.current = measuredHeightsByKey;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const pendingMeasurementTransactionRef =
    useRef<TurnMeasurementTransaction | null>(null);
  const measurementCommittedHeightsRef =
    useRef<Readonly<Record<string, number>> | null>(null);
  const measurementReadyTransactionRef =
    useRef<TurnMeasurementTransaction | null>(null);
  const measurementRegistryRef = useRef(new NativeTurnMeasurementRegistry());
  const pendingMeasurementBatchRef = useRef(new Map<string, {
    readonly lease: NativeTurnMeasurementLease;
    readonly heightPx: number;
  }>());
  const observedTurnHeightsRef = useRef(new Map<string, number>());
  const targetLayoutsByTurnRef = useRef(new Map<string, {
    readonly lease: NativeTurnMeasurementLease;
    readonly targets: Map<string, NativeTurnTargetLayout>;
  }>());
  const measurementFrameRef = useRef<number | null>(null);
  const viewportGeneration = viewportOwner.generation;
  const scrollController = viewportOwner.scrollController;
  const pendingPositionRef = useRef<PendingTurnPosition | null>(null);
  const [pendingPosition, setPendingPosition] = useState<PendingTurnPosition | null>(null);
  const [positioningLayoutRevision, setPositioningLayoutRevision] = useState(0);
  const cancelPositioning = useCallback(() => {
    const request = pendingPositionRef.current;
    if (request === null) return;
    pendingPositionRef.current = null;
    request.complete("cancelled");
    setPendingPosition((current) => current === request ? null : current);
  }, []);
  useEffect(() => () => cancelPositioning(), [cancelPositioning]);

  const historyBackfill = useTurnHistoryBackfill({
    historyKey,
    loadPage: loadOlder,
    readMetrics: () => viewportOwner.getMetrics(),
    afterLayout: () => new Promise<void>((resolve) => requestAnimationFrame(() => (
      requestAnimationFrame(() => resolve())
    ))),
  });
  const requestHistoryFill = historyBackfill.request;

  const updateViewport = useCallback((distanceFromBottomPx: number) => {
    if (pendingMeasurementTransactionRef.current !== null) return;
    setViewport((current) => updateTurnViewportState(
      current,
      layoutRef.current,
      distanceExcludingBottomPadding(
        Math.max(0, distanceFromBottomPx),
        getBottomPaddingPx(),
      ),
      viewportOwner.getMetrics().viewportHeightPx,
    ));
  }, [getBottomPaddingPx, viewportOwner]);

  const commitTurnMeasurements = useCallback((
    measurements: readonly {
      readonly lease: NativeTurnMeasurementLease;
      readonly heightPx: number;
    }[],
  ) => {
    if (!viewportOwner.isCurrentGeneration(viewportGeneration)) return;
    if (pendingMeasurementTransactionRef.current !== null) {
      for (const measurement of measurements) {
        if (measurementRegistryRef.current.isCurrent(measurement.lease)) {
          pendingMeasurementBatchRef.current.set(measurement.lease.turnKey, measurement);
        }
      }
      return;
    }
    const transaction = createTurnMeasurementTransaction({
      entries: entriesRef.current,
      measurements: measurementRegistryRef.current.filterCurrent(measurements)
        .map(({ lease, heightPx }) => ({ turnKey: lease.turnKey, heightPx })),
      measuredHeightsByKey: measuredHeightsRef.current,
      layout: layoutRef.current,
      viewport: viewportRef.current,
      currentDistanceFromBottomPx: scrollController.getLastScrollDistanceFromBottomPx(),
      bottomPaddingPx: getBottomPaddingPx(),
      preserveMeasuredTurnViewport,
      getPendingRestoreScrollDistanceFromBottomPx: getPendingRestoreDistanceFromBottomPx,
      previousPendingTransaction: pendingMeasurementTransactionRef.current,
    });
    if (transaction === null) return;
    if (transaction.latestTurnHeightChange !== null) {
      onLatestTurnMeasurement(transaction.latestTurnHeightChange);
    }
    measuredHeightsRef.current = transaction.measuredHeightsByKey;
    layoutRef.current = transaction.layout;
    viewportRef.current = transaction.viewport;
    measurementCommittedHeightsRef.current = transaction.measuredHeightsByKey;
    pendingMeasurementTransactionRef.current = transaction;
    if (transaction.preservePlatformScrollForNextLayout) {
      scrollController.preserveScrollPositionForNextLayout();
    }
    setMeasuredHeightsByKey(transaction.measuredHeightsByKey);
    setViewport(transaction.viewport);
  }, [
    getBottomPaddingPx,
    getPendingRestoreDistanceFromBottomPx,
    onLatestTurnMeasurement,
    preserveMeasuredTurnViewport,
    scrollController,
    viewportGeneration,
    viewportOwner,
  ]);

  const scheduleMeasurementCommit = useCallback(() => {
    if (
      measurementFrameRef.current !== null
      || pendingMeasurementTransactionRef.current !== null
      || pendingMeasurementBatchRef.current.size === 0
    ) return;
    measurementFrameRef.current = requestAnimationFrame(() => {
      measurementFrameRef.current = null;
      if (!viewportOwner.isCurrentGeneration(viewportGeneration)) return;
      if (pendingMeasurementTransactionRef.current !== null) return;
      const measurements = measurementRegistryRef.current.filterCurrent(
        [...pendingMeasurementBatchRef.current.values()],
      );
      pendingMeasurementBatchRef.current.clear();
      if (measurements.length > 0) commitTurnMeasurements(measurements);
    });
  }, [commitTurnMeasurements, viewportGeneration, viewportOwner]);

  const retireTurn = useCallback((lease: NativeTurnMeasurementLease) => {
    const pending = pendingMeasurementBatchRef.current.get(lease.turnKey);
    if (pending?.lease === lease) pendingMeasurementBatchRef.current.delete(lease.turnKey);
    observedTurnHeightsRef.current.delete(lease.turnKey);
    if (targetLayoutsByTurnRef.current.get(lease.turnKey)?.lease === lease) {
      targetLayoutsByTurnRef.current.delete(lease.turnKey);
    }
    const request = pendingPositionRef.current;
    if (request?.turnKey === lease.turnKey) {
      request.targetLayoutHeightPx = null;
      setPositioningLayoutRevision((current) => current + 1);
    }
  }, []);

  const reportTargetLayout = useCallback((
    lease: NativeTurnMeasurementLease,
    targetKey: string,
    targetLayout: NativeTurnTargetLayout | null,
  ) => {
    if (!measurementRegistryRef.current.isCurrent(lease)) return;
    let entry = targetLayoutsByTurnRef.current.get(lease.turnKey);
    if (entry?.lease !== lease) {
      entry = { lease, targets: new Map() };
      targetLayoutsByTurnRef.current.set(lease.turnKey, entry);
    }
    if (targetLayout === null) entry.targets.delete(targetKey);
    else entry.targets.set(targetKey, targetLayout);
    const request = pendingPositionRef.current;
    if (request?.turnKey === lease.turnKey && request.targetKey === targetKey) {
      setPositioningLayoutRevision((current) => current + 1);
    }
  }, []);

  const measureTurn = useCallback((lease: NativeTurnMeasurementLease, event: LayoutChangeEvent) => {
    if (!viewportOwner.isCurrentGeneration(viewportGeneration)
      || !measurementRegistryRef.current.isCurrent(lease)) return;
    const turnKey = lease.turnKey;
    const heightPx = Math.max(1, event.nativeEvent.layout.height);
    observedTurnHeightsRef.current.set(turnKey, heightPx);
    const request = pendingPositionRef.current;
    if (request?.turnKey === turnKey) {
      request.targetLayoutHeightPx = heightPx;
      setPositioningLayoutRevision((current) => current + 1);
    }
    if (Math.abs((measuredHeightsRef.current[turnKey] ?? 0) - heightPx) <= 0.5) return;
    pendingMeasurementBatchRef.current.set(turnKey, { lease, heightPx });
    scheduleMeasurementCommit();
  }, [scheduleMeasurementCommit, viewportGeneration, viewportOwner]);

  useLayoutEffect(() => {
    const previousLayout = previousLayoutRef.current;
    previousLayoutRef.current = layout;
    const measurementOwnsLayout =
      measurementCommittedHeightsRef.current === measuredHeightsByKey;
    if (measurementOwnsLayout) {
      measurementReadyTransactionRef.current =
        pendingMeasurementTransactionRef.current;
      const measurement = measurementReadyTransactionRef.current;
      if (measurement?.layoutHeightDeltaPx === 0) {
        pendingMeasurementTransactionRef.current = null;
        measurementReadyTransactionRef.current = null;
        measurementCommittedHeightsRef.current = null;
        scheduleMeasurementCommit();
      }
      return;
    }
    if (pendingMeasurementTransactionRef.current !== null) return;
    const compensated = reconcileTurnLayoutViewport({
      previousLayout,
      nextLayout: layout,
      measuredHeightsByKey,
      currentDistanceFromBottomPx: scrollController.getLastScrollDistanceFromBottomPx(),
      viewportHeightPx: viewportOwner.getMetrics().viewportHeightPx,
      bottomPaddingPx: getBottomPaddingPx(),
      preserveViewport: preserveMeasuredTurnViewport,
      layoutOwnedByMeasurement: false,
      restorePending: getPendingRestoreDistanceFromBottomPx() !== null,
    });
    if (compensated !== null) {
      viewportOwner.requestDistanceAfterNextGeometry(compensated);
      setViewport((current) => updateTurnViewportState(
        current,
        layout,
        distanceExcludingBottomPadding(compensated, getBottomPaddingPx()),
        viewportOwner.getMetrics().viewportHeightPx,
      ));
    }
  }, [
    getBottomPaddingPx,
    getPendingRestoreDistanceFromBottomPx,
    layout,
    measuredHeightsByKey,
    preserveMeasuredTurnViewport,
    scheduleMeasurementCommit,
    scrollController,
    viewportOwner,
  ]);

  const consumeContentSizeDistanceCandidate = useCallback(() => {
    const transaction = pendingMeasurementTransactionRef.current;
    if (
      transaction === null
      || measurementReadyTransactionRef.current !== transaction
    ) return null;
    pendingMeasurementTransactionRef.current = null;
    measurementReadyTransactionRef.current = null;
    measurementCommittedHeightsRef.current = null;
    return transaction.restoreScrollDistanceFromBottom
      ? null
      : transaction.scrollDistanceFromBottomPx;
  }, []);

  const afterContentSizeCommit = useCallback(() => {
    scheduleMeasurementCommit();
    if (pendingPositionRef.current !== null) {
      setPositioningLayoutRevision((current) => current + 1);
    }
    void requestHistoryFill();
  }, [requestHistoryFill, scheduleMeasurementCommit]);

  const virtualizedTurnListApi = useMemo<VirtualizedTurnListApi>(() => ({
    getEntryGeometry: (turnKey) => getTurnGeometry(layoutRef.current, turnKey),
    getViewportState: () => viewportRef.current,
    positionTarget: (options) => new Promise((resolve) => {
      cancelPositioning();
      if (options.signal?.aborted === true) {
        resolve("cancelled");
        return;
      }
      const currentLayout = layoutRef.current;
      const targetIndex = currentLayout.turnIndexByKey.get(options.turnKey);
      if (targetIndex === undefined
        && timelineRevision >= (options.minimumTimelineRevision ?? 0)) {
        resolve("unavailable");
        return;
      }
      let settled = false;
      let request: PendingTurnPosition;
      const mountedHeight = observedTurnHeightsRef.current.get(options.turnKey);
      const mountedTarget = options.targetKey === undefined
        ? null
        : targetLayoutsByTurnRef.current.get(options.turnKey)?.targets.get(options.targetKey);
      const targetWasMountedAtStart = mountedHeight !== undefined
        && (options.targetKey === undefined || mountedTarget !== undefined);
      const handleAbort = () => {
        if (pendingPositionRef.current === request) {
          pendingPositionRef.current = null;
          setPendingPosition((current) => current === request ? null : current);
        }
        request.complete("cancelled");
      };
      request = {
        turnKey: options.turnKey,
        targetKey: options.targetKey,
        minimumTimelineRevision: Math.max(0, options.minimumTimelineRevision ?? 0),
        align: options.align ?? "center",
        behavior: options.behavior ?? "instant",
        targetWasMountedAtStart,
        topAlignmentInsetPx: options.topAlignmentInsetPx,
        phase: "awaiting-render",
        transaction: new NativeTargetPositionTransaction(),
        targetLayoutHeightPx: mountedHeight ?? null,
        cancelSettlement: null,
        cancelFrame: null,
        complete: (result) => {
          if (settled) return;
          settled = true;
          request.cancelSettlement?.();
          request.cancelSettlement = null;
          request.cancelFrame?.();
          request.cancelFrame = null;
          options.signal?.removeEventListener("abort", handleAbort);
          resolve(result);
        },
      };
      options.signal?.addEventListener("abort", handleAbort, { once: true });
      pendingPositionRef.current = request;
      setPendingPosition(request);
      let lastContentHeight = viewportOwner.getMetrics().scrollHeightPx;
      let lastViewportHeight = viewportOwner.getMetrics().viewportHeightPx;
      request.cancelSettlement = scrollController.subscribe((metrics) => {
        if (pendingPositionRef.current !== request) return;
        const geometryChanged = lastContentHeight !== metrics.scrollHeightPx
          || lastViewportHeight !== metrics.viewportHeightPx;
        lastContentHeight = metrics.scrollHeightPx;
        lastViewportHeight = metrics.viewportHeightPx;
        if (geometryChanged || request.transaction.needsObservation(metrics.distanceFromBottomPx)) {
          setPositioningLayoutRevision((current) => current + 1);
        }
      });
    }),
  }), [cancelPositioning, scrollController, timelineRevision, viewportOwner]);

  useLayoutEffect(() => {
    const request = pendingPosition;
    if (request === null || pendingPositionRef.current !== request) return;
    if (timelineRevision < request.minimumTimelineRevision) return;
    const currentLayout = layoutRef.current;
    const targetIndex = currentLayout.turnIndexByKey.get(request.turnKey);
    const turn = targetIndex === undefined ? undefined : entriesRef.current[targetIndex];
    const targetKey = request.targetKey;
    const targetLayout = targetKey === undefined
      ? null
      : targetLayoutsByTurnRef.current.get(request.turnKey)?.targets.get(targetKey) ?? null;
    const measuredHeightPx = measuredHeightsByKey[request.turnKey];
    const readiness = nativeTargetReadiness({
      targetExists: turn !== undefined && (targetKey === undefined
        || turn.frames.some((frame) => getTimelineUserMessageTargetKey(frame) === targetKey)),
      observedRowHeightPx: request.targetLayoutHeightPx,
      committedRowHeightPx: measuredHeightPx,
      geometryCommitPending: pendingMeasurementTransactionRef.current !== null,
      anchorMeasured: targetKey === undefined || targetLayout !== null,
    });
    if (readiness === "unavailable") {
      pendingPositionRef.current = null;
      request.complete("unavailable");
      setPendingPosition((current) => current === request ? null : current);
      return;
    }
    // Projection proves absence; committed native layout proves readiness.
    // Elapsed frames cannot distinguish a missing target from a late child.
    if (readiness === "pending") return;
    const viewportHeightPx = viewportOwner.getMetrics().viewportHeightPx;
    const distanceFromBottomPx = targetLayout !== null
      ? distanceFromBottomToTargetWithinTurn({
          align: request.align,
          layout: currentLayout,
          targetHeightPx: targetLayout.heightPx,
          targetTopOffsetWithinTurnPx: targetLayout.topPx,
          topAlignmentInsetPx: request.topAlignmentInsetPx,
          turnKey: request.turnKey,
          viewportHeightPx,
        })
      : request.align === "top"
      ? distanceFromBottomToTopTurn({
          layout: currentLayout,
          turnKey: request.turnKey,
          topAlignmentInsetPx: request.topAlignmentInsetPx,
          viewportHeightPx,
        })
      : distanceFromBottomToCenterTurn(currentLayout, request.turnKey, viewportHeightPx);
    if (distanceFromBottomPx === null) return;
    const metrics = viewportOwner.getMetrics();
    const destinationDistance = Math.min(
      Math.max(0, metrics.scrollHeightPx - metrics.viewportHeightPx),
      distanceFromBottomPx + getBottomPaddingPx(),
    );
    // A virtual window cannot paint the intermediate rows of a remote smooth
    // scroll. Animate only an already mounted target within one viewport.
    const behavior = selectNativeTargetScrollBehavior({
      requestedBehavior: request.behavior,
      targetWasMountedAtStart: request.targetWasMountedAtStart,
      currentDistanceFromBottomPx: scrollController.getLastScrollDistanceFromBottomPx(),
      destinationDistanceFromBottomPx: destinationDistance,
      viewportHeightPx,
    });
    const step = request.transaction.advance({
      geometry: JSON.stringify([
        currentLayout.totalHeightPx, currentLayout.topOffsetsPx[targetIndex!], measuredHeightPx,
        targetLayout?.topPx, targetLayout?.heightPx,
        viewportHeightPx, metrics.scrollHeightPx, getBottomPaddingPx(),
      ]),
      destinationDistancePx: destinationDistance,
      physicalDistancePx: scrollController.getLastScrollDistanceFromBottomPx(),
      behavior,
    });
    if (step.type === "wait") return;
    if (step.type === "complete") {
      pendingPositionRef.current = null;
      request.complete("positioned");
      setPendingPosition((current) => current === request ? null : current);
      return;
    }
    if (request.phase === "awaiting-render") onBeforeTargetPosition();
    request.phase = "scrolling";
    request.cancelFrame?.();
    request.cancelFrame = null;
    viewportOwner.writeDistanceFromBottomPx(step.distancePx, step.behavior);
    if (step.behavior === "instant") {
      setViewport((current) => updateTurnViewportState(
        current, currentLayout, distanceFromBottomPx, viewportHeightPx,
      ));
      const frame = requestAnimationFrame(() => {
        request.cancelFrame = null;
        if (pendingPositionRef.current !== request) return;
        setPositioningLayoutRevision((current) => current + 1);
      });
      request.cancelFrame = () => cancelAnimationFrame(frame);
    }
  }, [getBottomPaddingPx, layout, measuredHeightsByKey, onBeforeTargetPosition,
    pendingPosition, positioningLayoutRevision, scrollController, timelineRevision, viewportOwner]);

  useEffect(() => {
    onApiChange?.(virtualizedTurnListApi);
    return () => onApiChange?.(null);
  }, [onApiChange, virtualizedTurnListApi]);

  const captureRestoreState = useCallback(() =>
    serializeTurnRestoreState(
      measuredHeightsRef.current,
      layoutRef.current.turnKeys,
      viewportRef.current.renderedRange,
    ), []);
  useLayoutEffect(() => {
    // The parent may outlive this child ref during unmount. Give it a lazy
    // capture instead of copying every measured Turn on every scroll frame.
    onRestoreCaptureReady?.(captureRestoreState);
  }, [captureRestoreState, onRestoreCaptureReady]);

  useImperativeHandle(forwardedRef, () => ({
    afterContentSizeCommit,
    cancelPositioning,
    captureRestoreState,
    consumeContentSizeDistanceCandidate,
    getEntryGeometry: virtualizedTurnListApi.getEntryGeometry,
    isGeometryCommitPending: () => pendingMeasurementTransactionRef.current !== null,
    requestHistoryFill,
    updateViewport,
  }), [
    afterContentSizeCommit,
    cancelPositioning,
    captureRestoreState,
    consumeContentSizeDistanceCandidate,
    requestHistoryFill,
    updateViewport,
    virtualizedTurnListApi.getEntryGeometry,
  ]);

  useEffect(() => () => {
    if (measurementFrameRef.current !== null) {
      cancelAnimationFrame(measurementFrameRef.current);
    }
    measurementFrameRef.current = null;
    pendingMeasurementTransactionRef.current = null;
    measurementReadyTransactionRef.current = null;
    measurementCommittedHeightsRef.current = null;
    pendingMeasurementBatchRef.current.clear();
    measurementRegistryRef.current.clear();
    targetLayoutsByTurnRef.current.clear();
  }, []);

  const renderedRange = reconcileRenderedRangeForEntries(viewport, layout);
  let targetRange = null;
  if (pendingPosition !== null && timelineRevision >= pendingPosition.minimumTimelineRevision) {
    const targetDistance = pendingPosition.align === "top"
      ? distanceFromBottomToTopTurn({
          layout,
          turnKey: pendingPosition.turnKey,
          topAlignmentInsetPx: pendingPosition.topAlignmentInsetPx,
          viewportHeightPx: viewport.viewportHeightPx,
        })
      : distanceFromBottomToCenterTurn(layout, pendingPosition.turnKey, viewport.viewportHeightPx);
    if (targetDistance !== null) {
      targetRange = computeTurnRange(
        layout, targetDistance, viewport.viewportHeightPx,
        CODEX_TURN_VIRTUALIZER_CONFIG.overscanTurnCount,
      );
    }
  }
  const mountedIndices = createNativeTurnMountPlan(renderedRange, targetRange, entries.length);
  useLayoutEffect(() => {
    const visible = new Set(mountedIndices.map((index) => entries[index]!.turnKey));
    for (const turnKey of observedTurnHeightsRef.current.keys()) {
      if (!visible.has(turnKey)) observedTurnHeightsRef.current.delete(turnKey);
    }
  }, [entries, mountedIndices]);
  if (entries.length === 0) return <>{renderEmpty()}</>;
  return (
    <View onLayout={onContentLayout} style={{ height: layout.totalHeightPx, minHeight: 1, position: "relative" }}>
      {mountedIndices.map((index) => {
        const turn = entries[index]!;
        const constrainedHeightPx = index !== entries.length - 1
          && measuredHeightsByKey[turn.turnKey] === undefined
          ? layout.heightsPx[index]
          : undefined;
        return (
          <View key={turn.turnKey} style={{ position: "absolute", top: layout.topOffsetsPx[index], left: 0, right: 0 }}>
            <NativeMeasuredTurn
              turnKey={turn.turnKey}
              constrainedHeightPx={constrainedHeightPx}
              registry={measurementRegistryRef.current}
              onMeasure={measureTurn}
              onRetire={retireTurn}
              onTargetLayout={reportTargetLayout}
            >
              {renderTurn(turn, index === entries.length - 1)}
            </NativeMeasuredTurn>
          </View>
        );
      })}
    </View>
  );
});
