import {
  deriveTimelineLatestTurnActivityKey,
  deriveTimelineLatestTurnPhase,
  type TimelineTurnView,
} from "@opencraft/chat-core";
import { NativeConversationViewportOwner, nativeFollowContentOverflowPx } from "@opencraft/timeline-host-native";
import {
  OPENCRAFT_LATEST_TURN_PLACEMENT_SPRING,
  createLatestTurnPlacementSnapshot,
  distanceAfterUnplacedLatestTurnContentResize,
  isViewportPreservingTurnFollowMode,
  maximumResponseSpacerHeightPx,
  normalizeInitialScrollDistance,
  responseSpacerOverflowPx,
  resolveTimelineViewportPolicy,
  TurnResponsePositioningController,
  type LatestTurnMeasurementChange,
  type LatestTurnPlacementSnapshot,
  type TurnConversationScrollApi,
  type TurnFollowRestoreState,
  type VirtualizedTurnListApi,
  type VirtualizedTurnRestoreState,
} from "@opencraft/timeline-virtualizer";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import {
  Animated,
  Platform,
  ScrollView,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  View,
  type ViewStyle,
} from "react-native";

import {
  NativeVirtualizedConversationTurns,
  type NativeVirtualizedConversationTurnsHandle,
} from "./native-virtualized-conversation-turns";

export interface WorkbenchConversationRestoreSnapshot {
  readonly distanceFromBottomPx: number;
  readonly virtualizedTurnList: VirtualizedTurnRestoreState | null;
  readonly turnFollow?: TurnFollowRestoreState | null;
}

export interface NativeResponsePositionedTurnsProps {
  readonly entries: readonly TimelineTurnView[];
  readonly timelineRevision: number;
  readonly historyKey: string | null;
  readonly footerScrollPaddingPx: number;
  readonly initialRestoreSnapshot: WorkbenchConversationRestoreSnapshot | null;
  readonly onRestoreSnapshotChange?: (
    snapshot: WorkbenchConversationRestoreSnapshot,
  ) => void;
  readonly onLoadOlder?: () => void | "stop" | Promise<void | "stop">;
  readonly onConversationScrollApiChange?: (
    api: TurnConversationScrollApi | null,
  ) => void;
  readonly consumePendingLatestTurnSubmitPlacement?: () =>
    LatestTurnPlacementSnapshot | null;
  readonly onVirtualizedTurnListApiChange?: (
    api: VirtualizedTurnListApi | null,
  ) => void;
  readonly renderEmpty: () => ReactNode;
  readonly renderTurn: (
    turn: TimelineTurnView,
    isLatest: boolean,
    latestTurnOffset: Animated.Value,
    onLatestFollowContentLayout: ((event: LayoutChangeEvent) => void) | null,
  ) => ReactNode;
  readonly scrollStyle?: StyleProp<ViewStyle>;
  readonly scrollContentStyle?: StyleProp<ViewStyle>;
  readonly contentStyle?: StyleProp<ViewStyle>;
}

/**
 * Native peer of Web ResponsePositionedTurns. It owns latest-answer identity,
 * follow/restore mode, response spacer and placement animation. Virtual list
 * measurement and windowing stay behind its child API.
 */
export function NativeResponsePositionedTurns({
  entries,
  timelineRevision,
  historyKey,
  footerScrollPaddingPx,
  initialRestoreSnapshot,
  onRestoreSnapshotChange,
  onLoadOlder,
  onConversationScrollApiChange,
  consumePendingLatestTurnSubmitPlacement,
  onVirtualizedTurnListApiChange,
  renderEmpty,
  renderTurn,
  scrollStyle,
  scrollContentStyle,
  contentStyle,
}: NativeResponsePositionedTurnsProps) {
  const viewportPolicy = resolveTimelineViewportPolicy({
    kind: Platform.OS === "web" ? "browser" : "native",
    platform: Platform.OS === "ios"
      ? "ios"
      : Platform.OS === "android"
        ? "android"
        : "linux",
  });
  const latestTurn = entries.at(-1) ?? null;
  const latestTurnKey = latestTurn?.turnKey ?? null;
  const latestTurnActivityKey = deriveTimelineLatestTurnActivityKey(latestTurn);
  const latestTurnPhase = deriveTimelineLatestTurnPhase(latestTurn);
  const isLatestTurnInProgress =
    latestTurn?.status === "pending" || latestTurn?.status === "streaming";
  const initialDistanceFromBottomPx = normalizeInitialScrollDistance(
    initialRestoreSnapshot?.distanceFromBottomPx,
  );
  const restoredLatestTurn =
    initialRestoreSnapshot?.turnFollow?.turnKey === latestTurnKey
      ? initialRestoreSnapshot.turnFollow
      : null;
  const responsePositioningRef =
    useRef<TurnResponsePositioningController | null>(null);
  if (responsePositioningRef.current === null) {
    responsePositioningRef.current = new TurnResponsePositioningController({
      distanceFromBottomPx: initialDistanceFromBottomPx,
      isLatestTurnInProgress,
      latestTurnPhase,
      restoredLatestTurn,
    });
  }
  const responsePositioning = responsePositioningRef.current;
  const scrollRef = useRef<ScrollView>(null);
  const virtualizerRef = useRef<NativeVirtualizedConversationTurnsHandle>(null);
  const virtualizerRestoreCaptureRef = useRef<(() => VirtualizedTurnRestoreState | null) | null>(null);
  const initialVirtualizerRestoreStateRef = useRef(initialRestoreSnapshot?.virtualizedTurnList ?? null);
  const footerPaddingRef = useRef(footerScrollPaddingPx);
  footerPaddingRef.current = footerScrollPaddingPx;
  const latestTurnKeyRef = useRef(latestTurnKey);
  const latestTurnActivityKeyRef = useRef(latestTurnActivityKey);
  const latestTurnPhaseRef = useRef(latestTurnPhase);
  const latestTurnInProgressRef = useRef(isLatestTurnInProgress);
  const didRestoreRef = useRef(false);
  const pendingNonPlacementRef =
    useRef<ReturnType<typeof createLatestTurnPlacementSnapshot> | null>(null);
  const responseSpacerHeightRef = useRef(0);
  const responseSpacerIntersectsBottomRef = useRef(false);
  const latestTurnFollowContentHeightRef = useRef<number | null>(
    initialRestoreSnapshot?.turnFollow?.turnKey === latestTurnKey
      ? initialRestoreSnapshot.turnFollow.latestTurnFollowContentHeightPx
      : null,
  );
  const latestTurnHeightRef = useRef<number | null>(
    initialRestoreSnapshot?.turnFollow?.turnKey === latestTurnKey
      ? initialRestoreSnapshot.turnFollow.latestTurnHeightPx
      : null,
  );
  const restoredLatestTurnHeightBaselineRef = useRef<number | null>(
    initialRestoreSnapshot?.turnFollow?.turnKey === latestTurnKey
      && isViewportPreservingTurnFollowMode(
        initialRestoreSnapshot.turnFollow.followMode,
      )
      ? initialRestoreSnapshot.turnFollow.latestTurnHeightPx
      : null,
  );
  const latestTurnFollowContentBottomRef = useRef<number | null>(null);
  const virtualizerTopOffsetRef = useRef<number | null>(null);
  const responseSpacerHeight = useRef(new Animated.Value(0)).current;
  const latestTurnOffset = useRef(new Animated.Value(0)).current;
  const viewportOwnerRef = useRef<NativeConversationViewportOwner | null>(null);
  if (viewportOwnerRef.current === null) {
    viewportOwnerRef.current = new NativeConversationViewportOwner({
      initialDistanceFromBottomPx,
    });
  }
  const viewportOwner = viewportOwnerRef.current;
  const viewportGeneration = viewportOwner.generation;
  const scrollController = viewportOwner.scrollController;
  const attachScrollView = useCallback((scrollView: ScrollView | null) => {
    scrollRef.current = scrollView;
    viewportOwner.attachScrollWriter(scrollView === null
      ? null
      : ({ topOffsetPx, animated }) => {
          scrollView.scrollTo({ y: topOffsetPx, animated });
        });
  }, [viewportOwner]);

  useLayoutEffect(() => {
    viewportOwner.setUserInputListener(() => {
      responsePositioning.userTakeover();
      virtualizerRef.current?.cancelPositioning();
    });
    return () => viewportOwner.setUserInputListener(null);
  }, [responsePositioning, viewportOwner]);

  useEffect(() => {
    const subscription = responseSpacerHeight.addListener(({ value }) => {
      responseSpacerHeightRef.current = Math.max(0, value);
    });
    return () => responseSpacerHeight.removeListener(subscription);
  }, [responseSpacerHeight]);

  const applyDistance = useCallback((distanceFromBottomPx: number) => {
    viewportOwner.writeDistanceFromBottomPx(distanceFromBottomPx, "instant");
  }, [viewportOwner]);
  const updateVirtualViewport = useCallback((distanceFromBottomPx: number) => {
    virtualizerRef.current?.updateViewport(distanceFromBottomPx);
  }, []);
  const getBottomPaddingPx = useCallback(
    () => responseSpacerHeightRef.current,
    [],
  );
  const getPendingRestoreDistanceFromBottomPx = useCallback(
    () => responsePositioning.getPendingRestoreDistanceFromBottomPx(
      responseSpacerHeightRef.current,
    ),
    [responsePositioning],
  );

  const stopResponseAnimations = useCallback(() => {
    responseSpacerHeight.stopAnimation();
    latestTurnOffset.stopAnimation();
  }, [latestTurnOffset, responseSpacerHeight]);
  const clearResponseSpacer = useCallback(() => {
    const changedGeometry = responseSpacerHeightRef.current > 0;
    stopResponseAnimations();
    latestTurnOffset.setValue(0);
    responseSpacerHeightRef.current = 0;
    responseSpacerIntersectsBottomRef.current = false;
    responseSpacerHeight.setValue(0);
    return changedGeometry;
  }, [latestTurnOffset, responseSpacerHeight, stopResponseAnimations]);
  const clearResponseSpacerAndScrollBottom = useCallback(() => {
    if (clearResponseSpacer()) {
      viewportOwner.requestDistanceAfterNextGeometry(0);
    } else applyDistance(0);
  }, [applyDistance, clearResponseSpacer, viewportOwner]);
  const shrinkResponseSpacer = useCallback((requestedHeightPx: number) => {
    const current = responseSpacerHeightRef.current;
    const next = requestedHeightPx <= 24
      ? 0
      : Math.min(current, Math.max(0, requestedHeightPx));
    if (current - next <= 24) return;
    stopResponseAnimations();
    latestTurnOffset.setValue(0);
    responseSpacerHeightRef.current = next;
    responseSpacerHeight.setValue(next);
    viewportOwner.requestDistanceAfterNextGeometry(Math.max(
      0,
      scrollController.getLastScrollDistanceFromBottomPx() + next - current,
    ));
  }, [
    latestTurnOffset,
    responseSpacerHeight,
    scrollController,
    stopResponseAnimations,
    viewportOwner,
  ]);
  const reduceFollow = useCallback((
    event: Parameters<TurnResponsePositioningController["reduceFollow"]>[0],
  ) => {
    const next = responsePositioning.reduceFollow(event);
    viewportOwner.setFooterResizeViewportPreserveDisabled(
      isLatestTurnInProgress
        && isViewportPreservingTurnFollowMode(next.followMode),
    );
    return next;
  }, [isLatestTurnInProgress, responsePositioning, viewportOwner]);

  const handleLatestTurnHeightMeasurement = useCallback((
    change: LatestTurnMeasurementChange,
  ) => {
    if (change.turnKey !== latestTurnKey) return;
    const restoredHeightBaseline = restoredLatestTurnHeightBaselineRef.current;
    latestTurnHeightRef.current = change.heightPx;
    restoredLatestTurnHeightBaselineRef.current = null;
    const compensateHeightDelta = (heightDeltaPx: number) => {
      if (heightDeltaPx === 0) return;
      const targetDistancePx =
        scrollController.getLastScrollDistanceFromBottomPx() + heightDeltaPx;
      const spacerHeightPx = responseSpacerHeightRef.current;
      if (
        isLatestTurnInProgress
        && spacerHeightPx > 24
        && targetDistancePx < 0
      ) {
        const nextSpacerHeightPx = spacerHeightPx - targetDistancePx;
        stopResponseAnimations();
        responseSpacerHeightRef.current = nextSpacerHeightPx;
        responseSpacerHeight.setValue(nextSpacerHeightPx);
      }
      viewportOwner.requestDistanceAfterNextGeometry(
        Math.max(0, targetDistancePx),
      );
    };
    if (
      restoredHeightBaseline !== null
      && Math.abs(change.heightPx - restoredHeightBaseline) > 24
    ) {
      const heightDeltaPx = change.heightPx - restoredHeightBaseline;
      if (responsePositioning.isRestorePending()) {
        responsePositioning.adjustPendingRestoreForHeightDelta(heightDeltaPx);
      }
      compensateHeightDelta(heightDeltaPx);
    }
    const followMode = responsePositioning.getFollowState().followMode;
    if (
      followMode === "user_follow"
      || (followMode === "prework_follow" && latestTurnPhase === "prework")
    ) {
      viewportOwner.requestDistanceAfterNextGeometry(0);
      return;
    }
    if (
      restoredHeightBaseline === null
      && change.heightDeltaPx !== 0
      && responsePositioning.shouldPreserveMeasuredViewport()
    ) compensateHeightDelta(change.heightDeltaPx);
  }, [
    isLatestTurnInProgress,
    latestTurnKey,
    latestTurnPhase,
    responsePositioning,
    responseSpacerHeight,
    scrollController,
    stopResponseAnimations,
    viewportOwner,
  ]);

  const considerFollowContentOverflow = useCallback(() => {
    if (!viewportOwner.isCurrentGeneration(viewportGeneration)) return;
    const followMode = responsePositioning.getFollowState().followMode;
    if (
      latestTurnKey === null
      || latestTurnFollowContentBottomRef.current === null
      || virtualizerTopOffsetRef.current === null
      || (followMode !== "response_watch" && (
        latestTurnPhase !== "prework"
        || followMode !== "prework_watch"
        || responseSpacerHeightRef.current <= 24
      ))
    ) return;
    const latestGeometry = virtualizerRef.current?.getEntryGeometry(latestTurnKey);
    if (latestGeometry === null || latestGeometry === undefined) return;
    const metrics = viewportOwner.getPlatformMetrics();
    const followContentOverflowPx = nativeFollowContentOverflowPx({
      virtualizerTopPx: virtualizerTopOffsetRef.current,
      latestTurnTopPx: latestGeometry.startPx,
      contentBottomWithinTurnPx: latestTurnFollowContentBottomRef.current,
      viewportTopPx: metrics.topOffsetPx,
      viewportHeightPx: metrics.viewportHeightPx,
      footerPaddingPx: footerPaddingRef.current,
    });
    const next = reduceFollow({
      type: "latest_turn_follow_content_changed",
      latestTurnPhase,
      followContentOverflowPx,
    });
    if (next.followMode === "prework_follow" || next.followMode === "user_follow") {
      responsePositioning.settleRestoreForFollowMode();
      clearResponseSpacerAndScrollBottom();
    }
  }, [
    clearResponseSpacerAndScrollBottom,
    latestTurnKey,
    latestTurnPhase,
    reduceFollow,
    responsePositioning,
    viewportGeneration,
    viewportOwner,
  ]);
  const handleLatestTurnFollowContentLayout = useCallback((
    event: LayoutChangeEvent,
  ) => {
    const { height, y } = event.nativeEvent.layout;
    latestTurnFollowContentHeightRef.current = Math.max(0, height);
    latestTurnFollowContentBottomRef.current = Math.max(0, y + height);
    considerFollowContentOverflow();
  }, [considerFollowContentOverflow]);
  const handleVirtualizerContentLayout = useCallback((event: LayoutChangeEvent) => {
    virtualizerTopOffsetRef.current = event.nativeEvent.layout.y;
    considerFollowContentOverflow();
  }, [considerFollowContentOverflow]);

  const handleUserScroll = useCallback((
    distanceFromBottomPx: number,
    previousDistanceFromBottomPx: number,
  ) => {
    responsePositioning.userTakeover();
    if (
      distanceFromBottomPx <= 24
      && previousDistanceFromBottomPx > 24
      && isLatestTurnInProgress
      && (
        responseSpacerHeightRef.current <= 24
        || responseSpacerIntersectsBottomRef.current
      )
    ) {
      reduceFollow({ type: "scroll_to_bottom", latestTurnPhase });
    } else if (distanceFromBottomPx > 24) {
      reduceFollow({
        type: "scroll_distance_changed",
        distanceFromBottomPx,
        latestTurnPhase,
      });
      if (
        responseSpacerHeightRef.current > 24
        && (
          (!isLatestTurnInProgress && latestTurnPhase === "idle")
          || (
            isLatestTurnInProgress
            && distanceFromBottomPx > previousDistanceFromBottomPx
          )
        )
      ) {
        shrinkResponseSpacer(
          responseSpacerHeightRef.current - distanceFromBottomPx,
        );
      }
    }
    if (viewportOwner.getPlatformMetrics().topOffsetPx <= 64) {
      void virtualizerRef.current?.requestHistoryFill();
    }
  }, [
    isLatestTurnInProgress,
    latestTurnPhase,
    reduceFollow,
    responsePositioning,
    shrinkResponseSpacer,
    viewportOwner,
  ]);

  useLayoutEffect(() => {
    const releaseViewport = scrollController.subscribe((snapshot) => {
      updateVirtualViewport(snapshot.distanceFromBottomPx);
      if (
        snapshot.distanceFromBottomPx > 24
        && isLatestTurnInProgress
        && responseSpacerHeightRef.current > 24
        && responseSpacerOverflowPx({
          distanceFromBottomPx: snapshot.distanceFromBottomPx,
          responseSpacerHeightPx: responseSpacerHeightRef.current,
          scrollPaddingBottomPx: footerPaddingRef.current,
        }) <= 24
      ) responseSpacerIntersectsBottomRef.current = true;
    });
    const releaseUserScroll =
      scrollController.addUserScrollListener(handleUserScroll);
    return () => {
      releaseViewport();
      releaseUserScroll();
    };
  }, [
    handleUserScroll,
    isLatestTurnInProgress,
    scrollController,
    updateVirtualViewport,
  ]);

  const handleScroll = useCallback((
    event: NativeSyntheticEvent<NativeScrollEvent>,
  ) => {
    if (!viewportOwner.isCurrentGeneration(viewportGeneration)) return;
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    viewportOwner.reportPlatformScroll({
      contentHeightPx: contentSize.height,
      viewportHeightPx: layoutMeasurement.height,
      topOffsetPx: contentOffset.y,
    });
  }, [viewportGeneration, viewportOwner]);
  const handleViewportLayout = useCallback((event: LayoutChangeEvent) => {
    if (!viewportOwner.isCurrentGeneration(viewportGeneration)) return;
    const viewportHeightPx = event.nativeEvent.layout.height;
    viewportOwner.reportViewportHeight(viewportHeightPx);
    const spacerHeightPx = responseSpacerHeightRef.current;
    if (spacerHeightPx > 24) {
      const maximumSpacerHeightPx = maximumResponseSpacerHeightPx({
        scrollElementHeightPx: viewportHeightPx,
        scrollPaddingBottomPx: footerPaddingRef.current,
      });
      if (
        Math.abs(
          Math.min(spacerHeightPx, maximumSpacerHeightPx) - spacerHeightPx,
        ) > 24
      ) shrinkResponseSpacer(maximumSpacerHeightPx);
    }
    updateVirtualViewport(
      scrollController.getLastScrollDistanceFromBottomPx(),
    );
    considerFollowContentOverflow();
  }, [
    considerFollowContentOverflow,
    scrollController,
    shrinkResponseSpacer,
    updateVirtualViewport,
    viewportGeneration,
    viewportOwner,
  ]);

  const handleContentSizeChange = useCallback((_width: number, height: number) => {
    if (!viewportOwner.isCurrentGeneration(viewportGeneration)) return;
    viewportOwner.commitContentGeometry(
      height,
      ({ inheritedDistanceFromBottomPx, metrics }) => {
        let requestedDistance = inheritedDistanceFromBottomPx;
        const nonPlacement = pendingNonPlacementRef.current;
        if (nonPlacement !== null && height !== nonPlacement.scrollHeightPx) {
          pendingNonPlacementRef.current = null;
          requestedDistance = distanceAfterUnplacedLatestTurnContentResize({
            nextScrollHeightPx: height,
            placement: nonPlacement,
          });
        }
        if (!didRestoreRef.current) {
          didRestoreRef.current = true;
          requestedDistance = initialDistanceFromBottomPx;
        }
        if (
          responsePositioning.getFollowState().followMode === "prework_follow"
        ) {
          responsePositioning.settleRestoreForFollowMode();
        } else {
          const restoreRequest = responsePositioning.attemptRestore(
            metrics.distanceFromBottomPx,
          );
          if (restoreRequest !== null) requestedDistance = restoreRequest;
        }
        const measurementDistance =
          virtualizerRef.current?.consumeContentSizeDistanceCandidate() ?? null;
        if (requestedDistance === null && measurementDistance !== null) {
          requestedDistance = measurementDistance;
        }
        if (
          requestedDistance === null
          && responsePositioning.ownsFollowPosition(
            latestTurnPhaseRef.current,
          )
        ) requestedDistance = 0;
        return requestedDistance;
      },
    );
    virtualizerRef.current?.afterContentSizeCommit();
  }, [
    initialDistanceFromBottomPx,
    responsePositioning,
    viewportGeneration,
    viewportOwner,
  ]);

  const onBeforeTargetPosition = useCallback(() => {
    responsePositioning.userTakeover();
    responsePositioning.resetFollowToStatic();
  }, [responsePositioning]);
  const handleVirtualizerRestoreCaptureReady = useCallback((
    capture: () => VirtualizedTurnRestoreState | null,
  ) => {
    virtualizerRestoreCaptureRef.current = capture;
  }, []);

  const conversationScrollApi = useMemo<TurnConversationScrollApi>(() => ({
    captureLatestTurnSubmitPlacement: () => {
      viewportOwner.setFooterResizeViewportPreserveDisabled(true);
      return createLatestTurnPlacementSnapshot({
        distanceFromBottomPx:
          scrollController.getLastScrollDistanceFromBottomPx(),
        responseSpacerHeightPx: responseSpacerHeightRef.current,
        scrollHeightPx: viewportOwner.getMetrics().scrollHeightPx,
      });
    },
    releaseLatestTurnSubmitPlacementCapture: () => {
      viewportOwner.setFooterResizeViewportPreserveDisabled(
        isLatestTurnInProgress
          && isViewportPreservingTurnFollowMode(
            responsePositioning.getFollowState().followMode,
          ),
      );
    },
    scrollToBottom: () => {
      responsePositioning.userTakeover();
      if (isLatestTurnInProgress) {
        clearResponseSpacerAndScrollBottom();
        reduceFollow({ type: "scroll_to_bottom", latestTurnPhase });
      } else if (
        latestTurnPhase === "idle"
        && responseSpacerHeightRef.current > 24
      ) clearResponseSpacerAndScrollBottom();
      else scrollController.scrollToBottom();
    },
  }), [
    clearResponseSpacerAndScrollBottom,
    isLatestTurnInProgress,
    latestTurnPhase,
    reduceFollow,
    responsePositioning,
    scrollController,
    viewportOwner,
  ]);
  useEffect(() => {
    onConversationScrollApiChange?.(conversationScrollApi);
    return () => onConversationScrollApiChange?.(null);
  }, [conversationScrollApi, onConversationScrollApiChange]);

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      const previousLatestTurnActivityKey = latestTurnActivityKeyRef.current;
      const previousLatestTurnPhase = latestTurnPhaseRef.current;
      const previousInProgress = latestTurnInProgressRef.current;
      latestTurnKeyRef.current = latestTurnKey;
      latestTurnActivityKeyRef.current = latestTurnActivityKey;
      latestTurnPhaseRef.current = latestTurnPhase;
      latestTurnInProgressRef.current = isLatestTurnInProgress;
      let ownsLatestTurnPolicy = true;
      let phaseTransitionOwnsPosition = false;
      if (previousLatestTurnActivityKey !== latestTurnActivityKey) {
        const placement =
          consumePendingLatestTurnSubmitPlacement?.() ?? null;
        if (
          latestTurnKey !== null
          && consumePendingLatestTurnSubmitPlacement !== undefined
          && placement === null
        ) ownsLatestTurnPolicy = false;
        else {
          reduceFollow(latestTurnKey === null
            ? { type: "latest_turn_removed" }
            : { type: "latest_turn_placed", watchForOverflow: placement?.shouldPlaceLatestTurn === true });
          if (latestTurnKey === null) clearResponseSpacer();
          else if (!(placement?.shouldPlaceLatestTurn ?? true)) {
            pendingNonPlacementRef.current = placement;
          } else {
            const maximumSpacer = maximumResponseSpacerHeightPx({
              scrollElementHeightPx:
                viewportOwner.getMetrics().viewportHeightPx,
              scrollPaddingBottomPx: footerPaddingRef.current,
            });
            const currentSpacer = responseSpacerHeightRef.current;
            responseSpacerIntersectsBottomRef.current = false;
            latestTurnOffset.setValue(currentSpacer);
            applyDistance(1);
            const placementSpring = {
              damping: OPENCRAFT_LATEST_TURN_PLACEMENT_SPRING.damping,
              mass: OPENCRAFT_LATEST_TURN_PLACEMENT_SPRING.mass,
              overshootClamping: true,
              stiffness: OPENCRAFT_LATEST_TURN_PLACEMENT_SPRING.stiffness,
              useNativeDriver: false,
            } as const;
            Animated.parallel([
              Animated.spring(latestTurnOffset, {
                ...placementSpring,
                toValue: 0,
              }),
              Animated.spring(responseSpacerHeight, {
                ...placementSpring,
                toValue: maximumSpacer,
              }),
            ]).start();
          }
        }
      }
      if (ownsLatestTurnPolicy && previousLatestTurnPhase !== latestTurnPhase) {
        const phaseTransition = responsePositioning.transitionLatestTurnPhase(
          previousLatestTurnPhase,
          latestTurnPhase,
        );
        viewportOwner.setFooterResizeViewportPreserveDisabled(
          isLatestTurnInProgress
            && isViewportPreservingTurnFollowMode(
              phaseTransition.followState.followMode,
            ),
        );
        if (phaseTransition.transferFollowToFinalAnswer) {
          clearResponseSpacerAndScrollBottom();
          phaseTransitionOwnsPosition = true;
        }
      }
      if (previousInProgress && !isLatestTurnInProgress) {
        stopResponseAnimations();
        latestTurnOffset.setValue(0);
      }
      if (
        ownsLatestTurnPolicy
        && !phaseTransitionOwnsPosition
        && responsePositioning.ownsFollowPosition(latestTurnPhase)
      ) {
        if (virtualizerRef.current?.isGeometryCommitPending() === true) {
          viewportOwner.requestDistanceAfterNextGeometry(0);
        } else {
          applyDistance(0);
          updateVirtualViewport(0);
        }
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [
    applyDistance,
    clearResponseSpacer,
    clearResponseSpacerAndScrollBottom,
    consumePendingLatestTurnSubmitPlacement,
    isLatestTurnInProgress,
    latestTurnActivityKey,
    latestTurnKey,
    latestTurnOffset,
    latestTurnPhase,
    reduceFollow,
    responsePositioning,
    responseSpacerHeight,
    stopResponseAnimations,
    updateVirtualViewport,
    viewportOwner,
  ]);

  const restoreCallbackRef = useRef(onRestoreSnapshotChange);
  restoreCallbackRef.current = onRestoreSnapshotChange;
  useEffect(() => () => {
    const normalized = responsePositioning.captureRestorePosition({
      distanceFromBottomPx:
        scrollController.getLastScrollDistanceFromBottomPx(),
      latestTurnPhase: latestTurnPhaseRef.current,
      responseSpacerHeightPx: responseSpacerHeightRef.current,
      scrollPaddingBottomPx: footerPaddingRef.current,
    });
    const currentLatestTurnKey = latestTurnKeyRef.current;
    const captureVirtualizer = virtualizerRef.current?.captureRestoreState
      ?? virtualizerRestoreCaptureRef.current;
    restoreCallbackRef.current?.({
      distanceFromBottomPx: normalized.distanceFromBottomPx,
      virtualizedTurnList: captureVirtualizer === null
        ? initialVirtualizerRestoreStateRef.current
        : captureVirtualizer(),
      turnFollow: currentLatestTurnKey === null
        ? null
        : {
            turnKey: currentLatestTurnKey,
            isLatestTurnInProgress: latestTurnInProgressRef.current,
            latestTurnPhase: latestTurnPhaseRef.current,
            followMode: normalized.scrollState.followMode,
            latestTurnHeightPx: isViewportPreservingTurnFollowMode(
              normalized.scrollState.followMode,
            )
              ? latestTurnHeightRef.current
              : null,
            latestTurnFollowContentHeightPx:
              latestTurnFollowContentHeightRef.current,
          },
    });
    viewportOwner.dispose();
  }, [responsePositioning, scrollController, viewportOwner]);

  useLayoutEffect(() => {
    viewportOwner.reportFooterScrollPadding(footerScrollPaddingPx);
    considerFollowContentOverflow();
  }, [considerFollowContentOverflow, footerScrollPaddingPx, viewportOwner]);

  return (
    <ScrollView
      ref={attachScrollView}
      alwaysBounceVertical={viewportPolicy.localElasticEffect}
      automaticallyAdjustKeyboardInsets={false}
      bounces={viewportPolicy.localElasticEffect}
      contentContainerStyle={[
        scrollContentStyle,
        { paddingBottom: footerScrollPaddingPx },
      ]}
      keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
      keyboardShouldPersistTaps="handled"
      onContentSizeChange={handleContentSizeChange}
      onLayout={handleViewportLayout}
      onMomentumScrollBegin={() => viewportOwner.beginMomentum()}
      onMomentumScrollEnd={() => viewportOwner.endMomentum()}
      onScrollBeginDrag={() => viewportOwner.beginUserGesture()}
      onScrollEndDrag={() => viewportOwner.endUserGesture()}
      onScroll={handleScroll}
      onTouchStart={() => viewportOwner.noteUserTouch()}
      onTouchEnd={() => viewportOwner.endUserTouch()}
      onTouchCancel={() => viewportOwner.endUserTouch()}
      overScrollMode={viewportPolicy.threadOverscroll === "none" ? "never" : "auto"}
      scrollEventThrottle={16}
      showsVerticalScrollIndicator={false}
      style={scrollStyle}
    >
      <View style={contentStyle}>
        <NativeVirtualizedConversationTurns
          ref={virtualizerRef}
          entries={entries}
          timelineRevision={timelineRevision}
          getBottomPaddingPx={getBottomPaddingPx}
          getPendingRestoreDistanceFromBottomPx={
            getPendingRestoreDistanceFromBottomPx
          }
          historyKey={historyKey}
          initialDistanceFromBottomPx={initialDistanceFromBottomPx}
          initialRestoreState={
            initialRestoreSnapshot?.virtualizedTurnList ?? null
          }
          loadOlder={onLoadOlder}
          onApiChange={onVirtualizedTurnListApiChange}
          onBeforeTargetPosition={onBeforeTargetPosition}
          onLatestTurnMeasurement={handleLatestTurnHeightMeasurement}
          onContentLayout={handleVirtualizerContentLayout}
          onRestoreCaptureReady={handleVirtualizerRestoreCaptureReady}
          preserveMeasuredTurnViewport={!isLatestTurnInProgress}
          renderEmpty={renderEmpty}
          renderTurn={(turn, isLatest) => renderTurn(
            turn,
            isLatest,
            latestTurnOffset,
            isLatest ? handleLatestTurnFollowContentLayout : null,
          )}
          viewportOwner={viewportOwner}
        />
        <Animated.View
          pointerEvents="none"
          style={{ height: responseSpacerHeight }}
        />
      </View>
    </ScrollView>
  );
}
