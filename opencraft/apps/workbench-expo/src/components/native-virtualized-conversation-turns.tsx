import type { TimelineTurnView } from "@opencraft/chat-core";
import type { NativeConversationViewportOwner } from "@opencraft/timeline-host-native";
import { useTurnHistoryBackfill } from "@opencraft/timeline-react";
import {
  buildTurnLayout,
  CODEX_TURN_VIRTUALIZER_CONFIG,
  createTurnMeasurementTransaction,
  createTurnViewportState,
  createTurnWindowSlice,
  distanceExcludingBottomPadding,
  distanceFromBottomToCenterTurn,
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

export interface NativeVirtualizedConversationTurnsHandle {
  afterContentSizeCommit(): void;
  captureRestoreState(): VirtualizedTurnRestoreState | null;
  consumeContentSizeDistanceCandidate(): number | null;
  getEntryGeometry: VirtualizedTurnListApi["getEntryGeometry"];
  isGeometryCommitPending(): boolean;
  requestHistoryFill(): Promise<void>;
  updateViewport(distanceFromBottomPx: number): void;
}

export interface NativeVirtualizedConversationTurnsProps {
  readonly entries: readonly TimelineTurnView[];
  readonly viewportOwner: NativeConversationViewportOwner;
  readonly initialRestoreState: VirtualizedTurnRestoreState | null;
  readonly initialDistanceFromBottomPx: number;
  readonly getBottomPaddingPx: () => number;
  readonly preserveMeasuredTurnViewport: boolean;
  readonly getPendingRestoreDistanceFromBottomPx: () => number | null;
  readonly historyKey: string | null;
  readonly loadOlder?: () => void | "stop" | Promise<void | "stop">;
  readonly onLatestTurnMeasurement: (change: LatestTurnMeasurementChange) => void;
  readonly onApiChange?: (api: VirtualizedTurnListApi | null) => void;
  readonly onRestoreStateChange?: (
    state: VirtualizedTurnRestoreState | null,
  ) => void;
  readonly onBeforeTargetPosition: () => void;
  readonly renderEmpty: () => ReactNode;
  readonly renderTurn: (turn: TimelineTurnView, isLatest: boolean) => ReactNode;
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
  viewportOwner,
  initialRestoreState,
  initialDistanceFromBottomPx,
  getBottomPaddingPx,
  preserveMeasuredTurnViewport,
  getPendingRestoreDistanceFromBottomPx,
  historyKey,
  loadOlder,
  onLatestTurnMeasurement,
  onApiChange,
  onRestoreStateChange,
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
  const pendingMeasurementBatchRef = useRef(new Map<string, number>());
  const measurementFrameRef = useRef<number | null>(null);
  const viewportGeneration = viewportOwner.generation;
  const scrollController = viewportOwner.scrollController;

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
    measurements: readonly { readonly turnKey: string; readonly heightPx: number }[],
  ) => {
    if (!viewportOwner.isCurrentGeneration(viewportGeneration)) return;
    if (pendingMeasurementTransactionRef.current !== null) {
      for (const measurement of measurements) {
        pendingMeasurementBatchRef.current.set(measurement.turnKey, measurement.heightPx);
      }
      return;
    }
    const transaction = createTurnMeasurementTransaction({
      entries: entriesRef.current,
      measurements,
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
      const measurements = [...pendingMeasurementBatchRef.current].map(
        ([turnKey, heightPx]) => ({ turnKey, heightPx }),
      );
      pendingMeasurementBatchRef.current.clear();
      if (measurements.length > 0) commitTurnMeasurements(measurements);
    });
  }, [commitTurnMeasurements, viewportGeneration, viewportOwner]);

  const measureTurn = useCallback((turnKey: string, event: LayoutChangeEvent) => {
    if (!viewportOwner.isCurrentGeneration(viewportGeneration)) return;
    const heightPx = Math.max(1, event.nativeEvent.layout.height);
    if (Math.abs((measuredHeightsRef.current[turnKey] ?? 0) - heightPx) <= 0.5) return;
    pendingMeasurementBatchRef.current.set(turnKey, heightPx);
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
    void requestHistoryFill();
  }, [requestHistoryFill, scheduleMeasurementCommit]);

  const virtualizedTurnListApi = useMemo<VirtualizedTurnListApi>(() => ({
    getEntryGeometry: (turnKey) => getTurnGeometry(layoutRef.current, turnKey),
    getViewportState: () => viewportRef.current,
    positionTarget: (options) => new Promise((resolve) => {
      if (options.signal?.aborted === true) {
        resolve("cancelled");
        return;
      }
      // Descendant measurement remains platform-owned and fails closed until
      // the Native semantic-target registry can prove an exact coordinate.
      if (options.targetKey !== undefined) {
        resolve("unavailable");
        return;
      }
      const currentLayout = layoutRef.current;
      const distanceFromBottomPx = (options.align ?? "center") === "top"
        ? distanceFromBottomToTopTurn({
            layout: currentLayout,
            turnKey: options.turnKey,
            topAlignmentInsetPx: options.topAlignmentInsetPx,
            viewportHeightPx: viewportOwner.getMetrics().viewportHeightPx,
          })
        : distanceFromBottomToCenterTurn(
            currentLayout,
            options.turnKey,
            viewportOwner.getMetrics().viewportHeightPx,
          );
      if (distanceFromBottomPx === null) {
        resolve("unavailable");
        return;
      }
      onBeforeTargetPosition();
      viewportOwner.writeDistanceFromBottomPx(
        distanceFromBottomPx + getBottomPaddingPx(),
        options.behavior ?? "instant",
      );
      setViewport((current) => updateTurnViewportState(
        current,
        currentLayout,
        distanceFromBottomPx,
        viewportOwner.getMetrics().viewportHeightPx,
      ));
      requestAnimationFrame(() => resolve(
        options.signal?.aborted === true ? "cancelled" : "positioned",
      ));
    }),
  }), [getBottomPaddingPx, onBeforeTargetPosition, viewportOwner]);

  useEffect(() => {
    onApiChange?.(virtualizedTurnListApi);
    return () => onApiChange?.(null);
  }, [onApiChange, virtualizedTurnListApi]);

  useLayoutEffect(() => {
    onRestoreStateChange?.(serializeTurnRestoreState(
      measuredHeightsRef.current,
      layoutRef.current.turnKeys,
      viewportRef.current.renderedRange,
    ));
  }, [layout, measuredHeightsByKey, onRestoreStateChange, viewport]);

  useImperativeHandle(forwardedRef, () => ({
    afterContentSizeCommit,
    captureRestoreState: () => serializeTurnRestoreState(
      measuredHeightsRef.current,
      layoutRef.current.turnKeys,
      viewportRef.current.renderedRange,
    ),
    consumeContentSizeDistanceCandidate,
    getEntryGeometry: virtualizedTurnListApi.getEntryGeometry,
    isGeometryCommitPending: () => pendingMeasurementTransactionRef.current !== null,
    requestHistoryFill,
    updateViewport,
  }), [
    afterContentSizeCommit,
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
  }, []);

  const renderedRange = reconcileRenderedRangeForEntries(viewport, layout);
  const windowSlice = createTurnWindowSlice(entries, layout, renderedRange);
  if (entries.length === 0) return <>{renderEmpty()}</>;
  return (
    <View style={{ height: windowSlice.totalHeightPx, minHeight: 1, position: "relative" }}>
      <View style={{ gap: windowSlice.gapPx, marginTop: windowSlice.marginTopPx }}>
        {windowSlice.entries.map((turn, sliceIndex) => {
          const index = windowSlice.range.startIndex + sliceIndex;
          const constrainedHeightPx = index !== entries.length - 1
            && measuredHeightsByKey[turn.turnKey] === undefined
            ? layout.heightsPx[index]
            : undefined;
          return (
            <View
              key={turn.turnKey}
              style={constrainedHeightPx === undefined
                ? undefined
                : { height: constrainedHeightPx, overflow: "hidden" }}
            >
              <View onLayout={(event) => measureTurn(turn.turnKey, event)}>
                {renderTurn(turn, index === entries.length - 1)}
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
});
