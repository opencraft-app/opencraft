import {
  deriveTimelineLatestTurnActivityKey,
  deriveTimelineLatestTurnPhase,
  type TimelineTurnView,
} from "@opencraft/chat-core";
import {
  createLatestTurnPlacementSnapshot,
  CODEX_LATEST_TURN_PLACEMENT_SPRING,
  distanceAfterUnplacedLatestTurnContentResize,
  maximumResponseSpacerHeightPx,
  normalizeInitialScrollDistance,
  normalizeInvertedWebViewportMetrics,
  responseSpacerOverflowPx,
  TurnResponsePositioningController,
  isViewportPreservingTurnFollowMode,
  type LatestTurnPlacementSnapshot,
} from "@opencraft/timeline-virtualizer";
import type {
  WebConversationViewportOwner,
  WebConversationLatestTurnMeasurement,
} from "@opencraft/timeline-host-web";
import { useStableEvent } from "@opencraft/react-runtime";
import {
  animate, motion, useMotionValue,
  type AnimationPlaybackControls, type MotionValue,
} from "motion/react";
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import type { ConversationRestoreSnapshot, ConversationScrollApi } from "../conversation";
import { LatestTurnFollowContentContext } from "../latest-turn-follow-content";
import { VirtualizedConversationTurns, type WebVirtualizedTurnListApi } from "./virtualized-conversation-turns";

function distanceFromBottom(element: HTMLDivElement): number {
  return normalizeInvertedWebViewportMetrics({
    contentHeightPx: element.scrollHeight,
    viewportHeightPx: element.clientHeight,
    scrollTopPx: element.scrollTop,
  }).distanceFromBottomPx;
}

const CODEX_LATEST_TURN_SPRING = Object.freeze({
  bounce: CODEX_LATEST_TURN_PLACEMENT_SPRING.bounce,
  duration: CODEX_LATEST_TURN_PLACEMENT_SPRING.durationMs / 1_000,
  type: "spring" as const,
});

export interface ResponsePositionedTurnsApi extends ConversationScrollApi {
  /** Read/observe only: the response policy retains the mutable animation value. */
  getSpacerHeightPx(): number;
  subscribeSpacerHeight(listener: () => void): () => void;
  captureRestoreSnapshot(): Pick<ConversationRestoreSnapshot, "distanceFromBottomPx" | "turnFollow">;
}

/**
 * r3562 oO: optional owner of latest-response placement/follow and response
 * restore state. Never mounted by the natural viewport policy.
 */
export function ResponsePositionedTurns({
  entries, timelineRevision, viewportOwner, scrollElement, initialRestoreSnapshot,
  consumePendingLatestTurnSubmitPlacement, onVisibleContentReady, onContentLayoutCommitted,
  onApiChange, onResponseApiChange, renderTurn,
}: {
  readonly entries: readonly TimelineTurnView[];
  readonly timelineRevision: number;
  readonly viewportOwner: WebConversationViewportOwner;
  /** Parent scrollport attachment is a host lifecycle fact, not a Turn phase. */
  readonly scrollElement: HTMLDivElement | null;
  readonly initialRestoreSnapshot: ConversationRestoreSnapshot | null;
  readonly consumePendingLatestTurnSubmitPlacement?: () => LatestTurnPlacementSnapshot | null;
  readonly onVisibleContentReady?: () => void;
  readonly onContentLayoutCommitted?: () => void;
  readonly onApiChange: (api: WebVirtualizedTurnListApi | null) => void;
  readonly onResponseApiChange: (api: ResponsePositionedTurnsApi | null) => void;
  readonly renderTurn: (turn: TimelineTurnView, isLatest: boolean, offset: MotionValue<number> | null) => ReactNode;
}) {
  const latestTurn = entries.length === 0 ? null : entries[entries.length - 1] ?? null;
  const latestTurnKey = latestTurn?.turnKey ?? null;
  const latestTurnActivityKey = deriveTimelineLatestTurnActivityKey(latestTurn);
  const latestTurnPhase = deriveTimelineLatestTurnPhase(latestTurn);
  const isLatestTurnInProgress = latestTurn?.status === "pending" || latestTurn?.status === "streaming";
  const responseSpacerHeight = useMotionValue(0);
  const latestTurnOffset = useMotionValue(0);
  const scrollRef = viewportOwner.scrollElementRef;
  const scrollController = viewportOwner.scrollController;
  const responseSpacerElementRef = useRef<HTMLDivElement>(null);
  const observeLatestTurnFollowContent = useCallback((element: HTMLDivElement | null) => {
    if (latestTurnKey === null) return;
    return viewportOwner.observeLatestTurnFollowContent(latestTurnKey, element);
  }, [latestTurnKey, viewportOwner]);
  const restoredLatestTurn = initialRestoreSnapshot?.turnFollow?.turnKey === latestTurnKey
    ? initialRestoreSnapshot.turnFollow
    : null;
  const responsePositioningRef = useRef<TurnResponsePositioningController | null>(null);
  if (responsePositioningRef.current === null) responsePositioningRef.current = new TurnResponsePositioningController({
    distanceFromBottomPx: scrollController.getLastScrollDistanceFromBottomPx(),
    isLatestTurnInProgress,
    latestTurnPhase,
    restoredLatestTurn,
  });
  const responsePositioning = responsePositioningRef.current;
  // r3562 U/ee: first live mount is an allowance consumed by the SAME
  // Activity transition as subsequent submits, never a second placement path.
  const initialPlacementPendingRef = useRef(
    isLatestTurnInProgress
      && initialRestoreSnapshot?.distanceFromBottomPx == null
      && restoredLatestTurn === null,
  );
  const latestTurnKeyRef = useRef(latestTurnKey);
  const latestTurnActivityKeyRef = useRef(
    consumePendingLatestTurnSubmitPlacement === undefined || !initialPlacementPendingRef.current
      ? latestTurnActivityKey
      : null,
  );
  const latestTurnPhaseRef = useRef(restoredLatestTurn?.latestTurnPhase ?? latestTurnPhase);
  const latestTurnInProgressRef = useRef(restoredLatestTurn?.isLatestTurnInProgress ?? isLatestTurnInProgress);
  const restoredLatestTurnHeightBaselineRef = useRef<number | null>(
    initialRestoreSnapshot?.turnFollow?.turnKey === latestTurnKey
      && isViewportPreservingTurnFollowMode(initialRestoreSnapshot.turnFollow.followMode)
      ? initialRestoreSnapshot.turnFollow.latestTurnHeightPx
      : null,
  );
  const latestTurnHeightRef = useRef<number | null>(
    initialRestoreSnapshot?.turnFollow?.turnKey === latestTurnKey
      ? initialRestoreSnapshot.turnFollow.latestTurnHeightPx
      : null,
  );
  const latestTurnFollowContentHeightRef = useRef<number | null>(
    initialRestoreSnapshot?.turnFollow?.turnKey === latestTurnKey
      ? initialRestoreSnapshot.turnFollow.latestTurnFollowContentHeightPx
      : null,
  );
  const responseSpacerIntersectsBottomRef = useRef(false);
  const responseSpacerAnimationRef = useRef<AnimationPlaybackControls | null>(null);
  const latestTurnOffsetAnimationRef = useRef<AnimationPlaybackControls | null>(null);

  const stopResponseAnimations = useCallback(() => {
    responseSpacerAnimationRef.current?.stop();
    responseSpacerAnimationRef.current = null;
    latestTurnOffsetAnimationRef.current?.stop();
    latestTurnOffsetAnimationRef.current = null;
  }, []);

  const clearResponseSpacer = useCallback(() => {
    stopResponseAnimations();
    latestTurnOffset.set(0);
    responseSpacerHeight.set(0);
    responseSpacerIntersectsBottomRef.current = false;
  }, [latestTurnOffset, responseSpacerHeight, stopResponseAnimations]);

  const updateFooterPreservationPolicy = useCallback(() => {
    viewportOwner.setFooterResizeViewportPreserveDisabled(
      isLatestTurnInProgress
        && isViewportPreservingTurnFollowMode(responsePositioning.getFollowState().followMode),
    );
  }, [isLatestTurnInProgress, responsePositioning, viewportOwner]);

  const setFollowState = useCallback((event: Parameters<TurnResponsePositioningController["reduceFollow"]>[0]) => {
    const next = responsePositioning.reduceFollow(event);
    updateFooterPreservationPolicy();
    return next;
  }, [responsePositioning, updateFooterPreservationPolicy]);

  const shrinkResponseSpacer = useCallback((requestedHeightPx: number) => {
    const currentHeight = responseSpacerHeight.get();
    const nextHeight = requestedHeightPx <= 24
      ? 0
      : Math.min(currentHeight, Math.max(0, requestedHeightPx));
    if (currentHeight - nextHeight <= 24) return;
    const element = scrollRef.current;
    const previousDistance = element === null ? 0 : distanceFromBottom(element);
    stopResponseAnimations();
    latestTurnOffset.set(0);
    responseSpacerHeight.set(nextHeight);
    if (element === null) return;
    // Sample before changing geometry, as r3562 De does.
    const nextDistance = Math.max(0, previousDistance + nextHeight - currentHeight);
    scrollController.scrollToDistanceFromBottomPx(nextDistance, "instant");
  }, [latestTurnOffset, responseSpacerHeight, scrollController, stopResponseAnimations]);

  const handleUserScroll = useCallback((distance: number, previousDistance: number) => {
    responsePositioning.userTakeover();
    const spacerHeight = responseSpacerHeight.get();
    if (distance <= 24) {
      if (
        (spacerHeight <= 24 || responseSpacerIntersectsBottomRef.current)
        && previousDistance > 24
        && isLatestTurnInProgress
      ) {
        setFollowState({ type: "scroll_to_bottom", latestTurnPhase });
        scrollController.scrollToDistanceFromBottomPx(0, "instant");
      }
      return;
    }
    setFollowState({
      type: "scroll_distance_changed",
      distanceFromBottomPx: distance,
      latestTurnPhase,
    });
    if (
      spacerHeight > 24
      && (
        (!isLatestTurnInProgress && latestTurnPhase === "idle")
        || (isLatestTurnInProgress && distance > previousDistance)
      )
    ) shrinkResponseSpacer(spacerHeight - distance);
  }, [isLatestTurnInProgress, latestTurnPhase, responsePositioning, responseSpacerHeight, scrollController, setFollowState, shrinkResponseSpacer]);

  const handlePlatformScroll = useStableEvent((snapshot: {
    readonly distanceFromBottomPx: number;
  }) => {
    const element = scrollRef.current;
    if (element === null) return;
    const distance = snapshot.distanceFromBottomPx;
    const spacerHeight = responseSpacerHeight.get();
    if (
      distance > 24
      && isLatestTurnInProgress
      && spacerHeight > 24
      && responseSpacerOverflowPx({
        distanceFromBottomPx: distance,
        responseSpacerHeightPx: spacerHeight,
        scrollPaddingBottomPx: viewportOwner.getFooterScrollPaddingPx(),
      }) <= 24
    ) responseSpacerIntersectsBottomRef.current = true;
  });

  const updateFromElement = useStableEvent((origin: "user" | "system") => {
    scrollController.reportPlatformScroll(origin);
  });

  useLayoutEffect(
    () => scrollController.subscribe(handlePlatformScroll),
    [handlePlatformScroll, scrollController],
  );

  useLayoutEffect(
    () => scrollController.addUserScrollListener(handleUserScroll),
    [handleUserScroll, scrollController],
  );

  /**
   * Sole policy consumer for latest-Turn measurement changes. The virtualizer
   * owns coherent geometry transactions; this response wrapper owns follow state,
   * response placement and the resulting imperative scroll command.
   */
  const handleLatestTurnMeasurement = useStableEvent((change: WebConversationLatestTurnMeasurement) => {
    if (change.turnKey !== latestTurnKey) return;
    const element = scrollRef.current;
    const restoredHeightBaseline = restoredLatestTurnHeightBaselineRef.current;
    if (change.kind === "turn-height") {
      latestTurnHeightRef.current = change.heightPx;
      restoredLatestTurnHeightBaselineRef.current = null;
    } else {
      latestTurnFollowContentHeightRef.current = change.followContentHeightPx;
    }

    const compensateHeightDelta = (heightDeltaPx: number) => {
      if (element === null || heightDeltaPx === 0) return;
      const targetDistance = distanceFromBottom(element) + heightDeltaPx;
      const spacerHeight = responseSpacerHeight.get();
      if (isLatestTurnInProgress && spacerHeight > 24 && targetDistance < 0) {
        responseSpacerHeight.set(spacerHeight - targetDistance);
      }
      scrollController.scrollToDistanceFromBottomPx(Math.max(0, targetDistance), "instant");
    };

    if (
      restoredHeightBaseline !== null
      && change.kind === "turn-height"
      && Math.abs(change.heightPx - restoredHeightBaseline) > 24
    ) {
      const heightDeltaPx = change.heightPx - restoredHeightBaseline;
      if (responsePositioning.isRestorePending()) {
        responsePositioning.adjustPendingRestoreForHeightDelta(heightDeltaPx);
      }
      compensateHeightDelta(heightDeltaPx);
    }

    if (responsePositioning.getFollowState().followMode === "user_follow") {
      scrollController.scrollToDistanceFromBottomPx(0, "instant");
      return;
    }
    if (responsePositioning.getFollowState().followMode === "prework_follow" && latestTurnPhase === "prework") {
      scrollController.scrollToDistanceFromBottomPx(0, "instant");
      return;
    }

    if (
      restoredHeightBaseline === null
      && change.kind === "turn-height"
      && change.heightDeltaPx !== 0
      && responsePositioning.shouldPreserveMeasuredViewport()
    ) {
      compensateHeightDelta(change.heightDeltaPx);
    }

    const followMode = responsePositioning.getFollowState().followMode;
    if (
      (followMode !== "response_watch" && (
        followMode !== "prework_watch"
        || latestTurnPhase !== "prework"
        || responseSpacerHeight.get() <= 24
      ))
      || element === null
    ) return;
    const latestElement = change.element;
    if (latestElement === null) return;
    const overflow = latestElement.getBoundingClientRect().bottom
      - element.getBoundingClientRect().bottom
      + viewportOwner.getFooterScrollPaddingPx();
    const nextFollowState = setFollowState({
      type: "latest_turn_follow_content_changed",
      latestTurnPhase,
      followContentOverflowPx: overflow,
    });
    if (nextFollowState.followMode === "prework_follow" || nextFollowState.followMode === "user_follow") {
      responsePositioning.settleRestoreForFollowMode();
      clearResponseSpacer();
      scrollController.scrollToDistanceFromBottomPx(0, "instant");
    }
  });

  const conversationScrollApi = useMemo<ConversationScrollApi>(() => ({
    captureLatestTurnSubmitPlacement: () => {
      const element = scrollRef.current;
      if (element === null) return null;
      const placement = createLatestTurnPlacementSnapshot({
        distanceFromBottomPx: scrollController.getLastScrollDistanceFromBottomPx(),
        responseSpacerHeightPx: responseSpacerHeight.get(),
        scrollHeightPx: element.scrollHeight,
      });
      viewportOwner.setFooterResizeViewportPreserveDisabled(true);
      return placement;
    },
    releaseLatestTurnSubmitPlacementCapture: () => {
      viewportOwner.setFooterResizeViewportPreserveDisabled(false);
      updateFooterPreservationPolicy();
    },
    scrollToBottom: () => {
      responsePositioning.userTakeover();
      if (isLatestTurnInProgress) {
        clearResponseSpacer();
        setFollowState({ type: "scroll_to_bottom", latestTurnPhase });
        scrollController.scrollToDistanceFromBottomPx(0, "instant");
      } else if (latestTurnPhase === "idle" && responseSpacerHeight.get() > 24) {
        clearResponseSpacer();
        scrollController.scrollToDistanceFromBottomPx(0, "instant");
      } else {
        scrollController.scrollToBottom();
      }
    },
  }), [clearResponseSpacer, isLatestTurnInProgress, latestTurnPhase, responsePositioning, responseSpacerHeight, scrollController, setFollowState, updateFooterPreservationPolicy]);

  // r3562 ScrollLayout publishes this bit in the controller context. Crossing
  // its 24px boundary changes that context and renews the response observer.
  // Do not substitute button visibility: that additionally excludes spacer.
  // This is the controller's read-only React context projection (r3562 Se),
  // not another distance owner. Preserve normal React publication timing;
  // useSyncExternalStore would impose external-store publication semantics.
  const [isScrolledFromBottom, setIsScrolledFromBottom] = useState(false);
  useLayoutEffect(() => scrollController.subscribe((snapshot) => {
    setIsScrolledFromBottom(snapshot.isScrolledFromBottom);
  }), [scrollController]);

  useLayoutEffect(updateFooterPreservationPolicy, [updateFooterPreservationPolicy]);

  const restoreInitialPosition = useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;
    if (responsePositioning.getFollowState().followMode === "prework_follow") {
      responsePositioning.settleRestoreForFollowMode();
      return;
    }
    const requestedDistance = responsePositioning.attemptRestore(distanceFromBottom(element));
    if (requestedDistance !== null) {
      scrollController.scrollToDistanceFromBottomPx(requestedDistance, "instant");
      responsePositioning.attemptRestore(distanceFromBottom(element));
    }
  }, [responsePositioning, scrollController]);

  /**
   * r3562 oO/Ye: parent response policy, after the virtualizer child's layout
   * effects. It never inspects the child's layout or measurement transaction.
   */
  const updateLatestTurnLifecycle = useStableEvent((element: HTMLDivElement): void => {
    const previousLatestTurnActivityKey = latestTurnActivityKeyRef.current;
    const previousLatestTurnPhase = latestTurnPhaseRef.current;
    latestTurnKeyRef.current = latestTurnKey;
    latestTurnActivityKeyRef.current = latestTurnActivityKey;
    latestTurnPhaseRef.current = latestTurnPhase;

    const previousInProgress = latestTurnInProgressRef.current;
    latestTurnInProgressRef.current = isLatestTurnInProgress;

    if (latestTurnActivityKey === null) {
      setFollowState({ type: "latest_turn_removed" });
      clearResponseSpacer();
      return;
    }
    if (previousLatestTurnActivityKey !== latestTurnActivityKey) {
      const allowInitialPlacement = initialPlacementPendingRef.current;
      initialPlacementPendingRef.current = false;
      const placement = consumePendingLatestTurnSubmitPlacement?.() ?? null;
      // Replica identity alone is not a local submit. Return only from this
      // policy: the virtualizer must still reconcile its own layout change.
      if (consumePendingLatestTurnSubmitPlacement !== undefined && placement === null && !allowInitialPlacement) {
        return;
      }
      setFollowState({ type: "latest_turn_placed", watchForOverflow: placement?.shouldPlaceLatestTurn === true });
      if (!(placement?.shouldPlaceLatestTurn ?? true)) {
        clearResponseSpacer();
        if (placement !== null) {
          // Signed delta: removing old spacer/content can shrink scrollHeight.
          scrollController.scrollToDistanceFromBottomPx(
            distanceAfterUnplacedLatestTurnContentResize({
              nextScrollHeightPx: element.scrollHeight,
              placement,
            }),
            "instant",
          );
        }
        // r3562 returns here; don't let a simultaneous phase transition take
        // back the reading position explicitly preserved by this submission.
        return;
      }
      const maximumSpacer = maximumResponseSpacerHeightPx({
        scrollElementHeightPx: element.clientHeight,
        scrollPaddingBottomPx: viewportOwner.getFooterScrollPaddingPx(),
      });
      const currentSpacer = responseSpacerHeight.get();
      stopResponseAnimations();
      responseSpacerIntersectsBottomRef.current = false;
      latestTurnOffset.set(currentSpacer);
      scrollController.scrollToDistanceFromBottomPx(1, "instant");
      latestTurnOffsetAnimationRef.current = animate(latestTurnOffset, 0, CODEX_LATEST_TURN_SPRING);
      if (currentSpacer !== maximumSpacer) {
        responseSpacerAnimationRef.current = animate(responseSpacerHeight, maximumSpacer, CODEX_LATEST_TURN_SPRING);
      }
    }
    const phaseTransition = responsePositioning.transitionLatestTurnPhase(
      previousLatestTurnPhase,
      latestTurnPhase,
    );
    updateFooterPreservationPolicy();
    if (phaseTransition.transferFollowToFinalAnswer) {
      clearResponseSpacer();
      scrollController.scrollToDistanceFromBottomPx(0, "instant");
    }
    // Completion stops movement; it does not own disposal of response space.
    if (previousInProgress && !isLatestTurnInProgress) {
      stopResponseAnimations();
      latestTurnOffset.set(0);
    }
  });

  useLayoutEffect(() => {
    const element = scrollElement;
    if (element === null) return;
    updateLatestTurnLifecycle(element);
    restoreInitialPosition();
    updateFromElement("system");
  }, [scrollElement, isLatestTurnInProgress, latestTurnActivityKey, latestTurnKey, latestTurnPhase, restoreInitialPosition, updateFromElement, updateLatestTurnLifecycle]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const update = () => {
      const clientHeightPx = element.clientHeight;
      const spacer = responseSpacerHeight.get();
      if (spacer > 24) {
        const maximum = maximumResponseSpacerHeightPx({
          scrollElementHeightPx: clientHeightPx,
          scrollPaddingBottomPx: viewportOwner.getFooterScrollPaddingPx(),
        });
        if (Math.abs(Math.min(spacer, maximum) - spacer) > 24) {
          shrinkResponseSpacer(maximum);
        }
      }
      restoreInitialPosition();
      updateFromElement("system");
    };
    const release = viewportOwner.observeViewportGeometry(update);
    return release;
  }, [responseSpacerHeight, restoreInitialPosition, shrinkResponseSpacer, updateFromElement, viewportOwner]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    const spacer = responseSpacerElementRef.current;
    if (element === null || spacer === null || typeof IntersectionObserver === "undefined") return;
    return viewportOwner.observeResponseSpacer(spacer, (record) => {
      if (latestTurnInProgressRef.current) {
        responseSpacerIntersectsBottomRef.current = Math.max(
          0,
          record.intersectionRect.height - viewportOwner.getFooterScrollPaddingPx(),
        ) <= 24;
      } else {
        shrinkResponseSpacer(Math.min(
          record.intersectionRect.height,
          responseSpacerHeight.get() - distanceFromBottom(element),
        ));
      }
    });
  }, [isScrolledFromBottom, responseSpacerHeight, shrinkResponseSpacer, viewportOwner]);

  const getPendingRestoreScrollDistanceFromBottomPx = useStableEvent(() => {
    return responsePositioning.getPendingRestoreDistanceFromBottomPx(responseSpacerHeight.get());
  });

  const captureRestoreSnapshot = useStableEvent(() => {
    const element = scrollRef.current;
    const normalized = responsePositioning.captureRestorePosition({
      distanceFromBottomPx: element === null
        ? scrollController.getLastScrollDistanceFromBottomPx()
        : distanceFromBottom(element),
      latestTurnPhase: latestTurnPhaseRef.current,
      responseSpacerHeightPx: responseSpacerHeight.get(),
      scrollPaddingBottomPx: viewportOwner.getFooterScrollPaddingPx(),
    });
    const currentLatestTurnKey = latestTurnKeyRef.current;
    return {
      distanceFromBottomPx: normalized.distanceFromBottomPx,
      turnFollow: currentLatestTurnKey === null ? null : {
        turnKey: currentLatestTurnKey,
        isLatestTurnInProgress: latestTurnInProgressRef.current,
        latestTurnPhase: latestTurnPhaseRef.current,
        followMode: normalized.scrollState.followMode,
        latestTurnHeightPx: isViewportPreservingTurnFollowMode(normalized.scrollState.followMode)
          ? latestTurnHeightRef.current
          : null,
        latestTurnFollowContentHeightPx: latestTurnFollowContentHeightRef.current,
      },
    };
  });
  const responseApi = useMemo<ResponsePositionedTurnsApi>(() => ({
    ...conversationScrollApi,
    getSpacerHeightPx: () => responseSpacerHeight.get(),
    subscribeSpacerHeight: (listener) => responseSpacerHeight.on("change", listener),
    captureRestoreSnapshot,
  }), [conversationScrollApi, responseSpacerHeight, captureRestoreSnapshot]);
  useLayoutEffect(() => {
    onResponseApiChange(responseApi);
    return () => onResponseApiChange(null);
  }, [onResponseApiChange, responseApi]);
  useEffect(() => () => {
    stopResponseAnimations();
    viewportOwner.setFooterResizeViewportPreserveDisabled(false);
  }, [stopResponseAnimations, viewportOwner]);

  const getBottomScrollPaddingPx = useCallback(() => responseSpacerHeight.get(), [responseSpacerHeight]);
  const onBeforeTargetPosition = useCallback(() => {
    responsePositioning.userTakeover();
    responsePositioning.resetFollowToStatic();
    updateFooterPreservationPolicy();
  }, [responsePositioning, updateFooterPreservationPolicy]);
  return <>
    <VirtualizedConversationTurns
      entries={entries}
      timelineRevision={timelineRevision}
      viewportOwner={viewportOwner}
      initialRestoreState={initialRestoreSnapshot?.virtualizedTurnList ?? null}
      initialDistanceFromBottomPx={normalizeInitialScrollDistance(initialRestoreSnapshot?.distanceFromBottomPx)}
      getBottomScrollPaddingPx={getBottomScrollPaddingPx}
      preserveMeasuredTurnViewport={!isLatestTurnInProgress}
      getPendingRestoreScrollDistanceFromBottomPx={getPendingRestoreScrollDistanceFromBottomPx}
      restoreScrollDistanceFromBottomPx={restoreInitialPosition}
      onLatestTurnMeasurement={handleLatestTurnMeasurement}
      onApiChange={onApiChange}
      onBeforeTargetPosition={onBeforeTargetPosition}
      onVisibleContentReady={onVisibleContentReady}
      onContentLayoutCommitted={onContentLayoutCommitted}
      renderTurn={(turn, isLatest) => (
        <LatestTurnFollowContentContext.Provider value={isLatest ? observeLatestTurnFollowContent : undefined}>
          {renderTurn(turn, isLatest, isLatest ? latestTurnOffset : null)}
        </LatestTurnFollowContentContext.Provider>
      )}
    />
    <motion.div aria-hidden="true" className="thread-response-spacer"
      ref={responseSpacerElementRef} style={{ height: responseSpacerHeight }} />
  </>;
}
