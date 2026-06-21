"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  type BottomAnchorBlockedReason,
  type BottomAnchorDriver,
  type BottomAnchorDriverSnapshot,
  type BottomAnchorMeasurementState,
  type BottomAnchorMode,
  type BottomAnchorRequestReason,
  type BottomAnchorUserIntent,
  createBottomAnchorDriver,
  isBottomAnchorMeasurementNearBottom,
  isOverscrolledPastBottom,
} from "./bottomAnchorDriver";
import {
  type ActiveHistoryPrependAnchor,
  deriveHistoryPrependAnchorAfterResize,
  shouldRequestOlderHistory,
} from "./historyPaging";
import {
  type ConversationScrollResumeState,
  deriveConversationScrollResumeDecision,
  persistConversationScrollResumeState,
  readConversationScrollResumeState,
} from "./routeResume";
import type { ConversationBottomAnchorReason } from "./viewportHandle";

const USER_SCROLL_ACTIVITY_RESET_MS = 180;

type ScrollableElement = Pick<
  HTMLElement,
  "clientHeight" | "clientWidth" | "scrollHeight" | "scrollTo" | "scrollTop"
> & {
  style: Pick<CSSStyleDeclaration, "scrollBehavior">;
};

interface ScheduledFrameHandle {
  cancelled: boolean;
  frameId: number | null;
  remainingFrames: number;
  callback: () => void;
}

export interface ConversationScrollControllerOptions {
  hasOlderHistory?: boolean;
  historyStartKey?: unknown;
  isLoadingOlderHistory?: boolean;
  onNearHistoryStart?: () => void;
}

export interface ConversationScrollControllerSignals {
  followSignal: string;
  layoutSignal: string;
}

export interface ConversationScrollController {
  contentRef: RefObject<HTMLDivElement | null>;
  debug: ConversationScrollControllerDebug;
  scrollRef: RefObject<HTMLElement | null>;
  followOutput: boolean;
  requestBottomAnchor: (reason: ConversationBottomAnchorReason) => void;
  prepareForViewportChange: () => void;
}

export interface ConversationScrollControllerDebug {
  followOutput: boolean;
  bottomAnchorMode: BottomAnchorMode;
  bottomAnchorBlockedReason: BottomAnchorBlockedReason | null;
  bottomAnchorPendingReason: BottomAnchorRequestReason | null;
  bottomAnchorLastFulfilledReason: BottomAnchorRequestReason | null;
  routeResumeStatus: ConversationScrollRouteResumeStatus;
  routeResumeScrollTop: number | null;
  lastFollowSignal: string;
  lastLayoutSignal: string;
}

export type ConversationScrollRouteResumeStatus =
  | "idle"
  | "pending"
  | "restored";

export function scrollElementToBottom(
  element: ScrollableElement,
  behavior: ScrollBehavior = "smooth",
): boolean {
  if (
    isOverscrolledPastBottom({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    })
  ) {
    return false;
  }

  const previousScrollBehavior = element.style.scrollBehavior;
  if (behavior === "auto") {
    element.style.scrollBehavior = "auto";
  }
  try {
    element.scrollTo({ top: element.scrollHeight, behavior });
  } finally {
    if (behavior === "auto") {
      element.style.scrollBehavior = previousScrollBehavior;
    }
  }
  return true;
}

function scheduleAnimationFrameWithDelay(input: {
  callback: () => void;
  delayFrames?: number;
}): ScheduledFrameHandle {
  const handle: ScheduledFrameHandle = {
    cancelled: false,
    frameId: null,
    remainingFrames: Math.max(0, input.delayFrames ?? 0),
    callback: input.callback,
  };

  const tick = () => {
    if (handle.cancelled) return;
    if (handle.remainingFrames > 0) {
      handle.remainingFrames -= 1;
      handle.frameId = requestAnimationFrame(tick);
      return;
    }
    handle.frameId = null;
    handle.callback();
  };

  handle.frameId = requestAnimationFrame(tick);
  return handle;
}

function cancelScheduledFrame(handle: unknown): void {
  const scheduled = handle as ScheduledFrameHandle | null;
  if (!scheduled) return;
  scheduled.cancelled = true;
  if (scheduled.frameId !== null) {
    cancelAnimationFrame(scheduled.frameId);
    scheduled.frameId = null;
  }
}

function routeKeyFrom(value: unknown): string | null {
  return value == null ? null : String(value);
}

function emptyDriverSnapshot(): BottomAnchorDriverSnapshot {
  return {
    mode: "sticky_bottom",
    pendingRequest: null,
    pendingVerification: null,
    blockedReason: null,
    measurementRevision: 0,
    lastVerifiedMeasurementRevision: 0,
    lastFulfilledReason: null,
    detachReason: null,
  };
}

export function useConversationScrollController(
  signals: ConversationScrollControllerSignals,
  options: ConversationScrollControllerOptions = {},
): ConversationScrollController {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLElement | null>(null);
  const lastKnownContentHeightRef = useRef(0);
  const lastKnownViewportHeightRef = useRef(0);
  const lastKnownViewportWidthRef = useRef(0);
  const lastKnownScrollTopRef = useRef(0);
  const latestFollowSignalRef = useRef(signals.followSignal);
  const latestLayoutSignalRef = useRef(signals.layoutSignal);
  const pendingScrollResumeStateRef =
    useRef<ConversationScrollResumeState | null>(null);
  const routeResumeStatusRef =
    useRef<ConversationScrollRouteResumeStatus>("idle");
  const routeResumeScrollTopRef = useRef<number | null>(null);
  const pendingScrollResumePersistFrameRef = useRef<number | null>(null);
  const latestScrollResumePersistStateRef =
    useRef<ConversationScrollResumeState | null>(null);
  const pendingHistoryPrependAnchorRef =
    useRef<ActiveHistoryPrependAnchor | null>(null);
  const historyStartReadyRef = useRef(false);
  const lastTouchClientYRef = useRef<number | null>(null);
  const userIntentRef = useRef<BottomAnchorUserIntent>("none");
  const userIntentResetTimeoutRef = useRef<number | null>(null);
  const optionsRef = useRef(options);
  const localAnchorSequenceRef = useRef(0);
  const driverRef = useRef<BottomAnchorDriver | null>(null);
  const driverSnapshotRef = useRef<BottomAnchorDriverSnapshot>(emptyDriverSnapshot());

  const [followOutput, setFollowOutputState] = useState(true);
  const [debug, setDebug] = useState<ConversationScrollControllerDebug>({
    followOutput: true,
    bottomAnchorMode: "sticky_bottom",
    bottomAnchorBlockedReason: null,
    bottomAnchorPendingReason: null,
    bottomAnchorLastFulfilledReason: null,
    routeResumeStatus: "idle",
    routeResumeScrollTop: null,
    lastFollowSignal: signals.followSignal,
    lastLayoutSignal: signals.layoutSignal,
  });

  optionsRef.current = options;
  latestFollowSignalRef.current = signals.followSignal;
  latestLayoutSignalRef.current = signals.layoutSignal;

  const publishScrollDebug = useCallback(
    (snapshot = driverSnapshotRef.current) => {
      const next: ConversationScrollControllerDebug = {
        followOutput: snapshot.mode === "sticky_bottom",
        bottomAnchorMode: snapshot.mode,
        bottomAnchorBlockedReason: snapshot.blockedReason,
        bottomAnchorPendingReason:
          snapshot.pendingRequest?.reason ?? snapshot.pendingVerification?.reason ?? null,
        bottomAnchorLastFulfilledReason: snapshot.lastFulfilledReason,
        routeResumeStatus: routeResumeStatusRef.current,
        routeResumeScrollTop: routeResumeScrollTopRef.current,
        lastFollowSignal: latestFollowSignalRef.current,
        lastLayoutSignal: latestLayoutSignalRef.current,
      };
      setDebug((current) =>
        current.followOutput === next.followOutput &&
        current.bottomAnchorMode === next.bottomAnchorMode &&
        current.bottomAnchorBlockedReason === next.bottomAnchorBlockedReason &&
        current.bottomAnchorPendingReason === next.bottomAnchorPendingReason &&
        current.bottomAnchorLastFulfilledReason === next.bottomAnchorLastFulfilledReason &&
        current.routeResumeStatus === next.routeResumeStatus &&
        current.routeResumeScrollTop === next.routeResumeScrollTop &&
        current.lastFollowSignal === next.lastFollowSignal &&
        current.lastLayoutSignal === next.lastLayoutSignal
          ? current
          : next,
      );
    },
    [],
  );

  const readMeasurementState = useCallback((): BottomAnchorMeasurementState => {
    const element = scrollRef.current;
    const routeKey = routeKeyFrom(optionsRef.current.historyStartKey) ?? "unscoped";
    const containerKey = `web-scroll:${routeKey}`;
    const viewportWidth = element?.clientWidth ?? lastKnownViewportWidthRef.current;
    const viewportHeight = element?.clientHeight ?? lastKnownViewportHeightRef.current;
    const contentHeight =
      contentRef.current?.scrollHeight ??
      element?.scrollHeight ??
      lastKnownContentHeightRef.current;
    const scrollTop = element?.scrollTop ?? lastKnownScrollTopRef.current;
    return {
      containerKey,
      viewportMeasuredForKey:
        viewportWidth > 0 && viewportHeight > 0 ? containerKey : null,
      contentMeasuredForKey: contentHeight > 0 ? containerKey : null,
      viewportWidth,
      viewportHeight,
      contentHeight,
      scrollTop,
      bottomInsetPx: 0,
    };
  }, []);

  const handleDriverSnapshot = useCallback(
    (snapshot: BottomAnchorDriverSnapshot) => {
      driverSnapshotRef.current = snapshot;
      const nextFollowOutput = snapshot.mode === "sticky_bottom";
      setFollowOutputState((current) =>
        current === nextFollowOutput ? current : nextFollowOutput,
      );
      publishScrollDebug(snapshot);
    },
    [publishScrollDebug],
  );

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const element = scrollRef.current;
    if (!element) return;
    if (scrollElementToBottom(element, behavior)) {
      lastKnownScrollTopRef.current = element.scrollTop;
    }
  }, []);

  if (!driverRef.current) {
    driverRef.current = createBottomAnchorDriver({
      getIsAuthoritativeHistoryReady: () => historyStartReadyRef.current,
      getMeasurementState: () => readMeasurementState(),
      isNearBottom: () => isBottomAnchorMeasurementNearBottom(readMeasurementState()),
      scrollToBottom: ({ animated }) => {
        scrollToBottom(animated ? "smooth" : "auto");
      },
      scheduleFrame: ({ callback, delayFrames }) =>
        scheduleAnimationFrameWithDelay({ callback, delayFrames }),
      cancelFrame: (handle) => cancelScheduledFrame(handle),
      getTransportBehavior: () => ({
        verificationDelayFrames: 0,
        verificationRetryMode: "rescroll",
      }),
      onSnapshotChange: handleDriverSnapshot,
    });
    driverSnapshotRef.current = driverRef.current.getSnapshot();
  }

  const driver = driverRef.current;

  const cancelUserIntentReset = useCallback(() => {
    if (userIntentResetTimeoutRef.current === null) return;
    clearTimeout(userIntentResetTimeoutRef.current);
    userIntentResetTimeoutRef.current = null;
  }, []);

  const markUserIntent = useCallback(
    (intent: BottomAnchorUserIntent) => {
      if (intent !== "none") userIntentRef.current = intent;
      cancelUserIntentReset();
      userIntentResetTimeoutRef.current = window.setTimeout(() => {
        userIntentRef.current = "none";
        userIntentResetTimeoutRef.current = null;
      }, USER_SCROLL_ACTIVITY_RESET_MS);
    },
    [cancelUserIntentReset],
  );

  const cancelPendingScrollResumePersist = useCallback(() => {
    if (pendingScrollResumePersistFrameRef.current === null) return;
    cancelAnimationFrame(pendingScrollResumePersistFrameRef.current);
    pendingScrollResumePersistFrameRef.current = null;
  }, []);

  const schedulePersistScrollResume = useCallback(
    (state: ConversationScrollResumeState) => {
      latestScrollResumePersistStateRef.current = state;
      if (pendingScrollResumePersistFrameRef.current !== null) return;
      pendingScrollResumePersistFrameRef.current = requestAnimationFrame(() => {
        pendingScrollResumePersistFrameRef.current = null;
        const latestState = latestScrollResumePersistStateRef.current;
        if (!latestState || typeof window === "undefined") return;
        persistConversationScrollResumeState(window.sessionStorage, latestState);
      });
    },
    [],
  );

  const tryRestoreScrollResume = useCallback(() => {
    const resumeState = pendingScrollResumeStateRef.current;
    const element = scrollRef.current;
    if (!resumeState || !element) return false;

    const decision = deriveConversationScrollResumeDecision({
      contentHeight: contentRef.current?.scrollHeight ?? element.scrollHeight,
      isHistoryReady: historyStartReadyRef.current,
      pendingVerification: driver.getSnapshot().pendingVerification !== null,
      resumeState,
      viewportHeight: element.clientHeight,
      viewportWidth: element.clientWidth,
    });

    if (decision.blockedReason) {
      routeResumeStatusRef.current = "pending";
      routeResumeScrollTopRef.current = resumeState.scrollTop;
      publishScrollDebug();
      return false;
    }

    pendingScrollResumeStateRef.current = null;
    if (!decision.shouldRestore || decision.scrollTop === null) {
      routeResumeStatusRef.current = "idle";
      routeResumeScrollTopRef.current = null;
      publishScrollDebug();
      return false;
    }

    element.scrollTop = decision.scrollTop;
    lastKnownScrollTopRef.current = decision.scrollTop;
    routeResumeStatusRef.current = "restored";
    routeResumeScrollTopRef.current = decision.scrollTop;
    publishScrollDebug();
    return true;
  }, [driver, publishScrollDebug]);

  useEffect(() => {
    const routeKey = routeKeyFrom(options.historyStartKey);
    driver.reset();
    historyStartReadyRef.current = false;
    pendingHistoryPrependAnchorRef.current = null;
    const resumeState =
      typeof window === "undefined"
        ? null
        : readConversationScrollResumeState(window.sessionStorage, routeKey);
    pendingScrollResumeStateRef.current =
      resumeState && !resumeState.followOutput ? resumeState : null;
    if (pendingScrollResumeStateRef.current) {
      driver.reset({ mode: "detached", detachReason: "route_restore" });
    }
    routeResumeStatusRef.current = pendingScrollResumeStateRef.current
      ? "pending"
      : "idle";
    routeResumeScrollTopRef.current =
      pendingScrollResumeStateRef.current?.scrollTop ?? null;
    publishScrollDebug();

    const frame = requestAnimationFrame(() => {
      historyStartReadyRef.current = true;
      if (tryRestoreScrollResume()) return;
      if (routeKey) {
        driver.applyRouteRequest({
          reason: "route_initial_entry",
          requestKey: `${routeKey}:route_initial_entry`,
        });
      }
      driver.notifyAuthoritativeHistoryMaybeChanged();
    });
    return () => {
      cancelAnimationFrame(frame);
      historyStartReadyRef.current = false;
    };
  }, [driver, options.historyStartKey, publishScrollDebug, tryRestoreScrollResume]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    lastKnownScrollTopRef.current = element.scrollTop;

    const handleWheel = (event: WheelEvent) => {
      markUserIntent(event.deltaY < 0 ? "scroll_up" : "scroll_down");
    };

    const handleTouchStart = (event: TouchEvent) => {
      lastTouchClientYRef.current = event.touches[0]?.clientY ?? null;
      markUserIntent("none");
    };

    const handleTouchMove = (event: TouchEvent) => {
      const nextClientY = event.touches[0]?.clientY ?? null;
      const previousClientY = lastTouchClientYRef.current;
      if (nextClientY !== null && previousClientY !== null) {
        markUserIntent(nextClientY > previousClientY + 1 ? "scroll_up" : "scroll_down");
      }
      lastTouchClientYRef.current = nextClientY;
    };

    const handleScroll = () => {
      const previousScrollTop = lastKnownScrollTopRef.current;
      const scrollDelta = element.scrollTop - previousScrollTop;
      lastKnownScrollTopRef.current = element.scrollTop;
      const measurement = readMeasurementState();
      driver.handleScrollNearBottomChange({
        nextIsNearBottom: isBottomAnchorMeasurementNearBottom(measurement),
        scrollDelta,
        userIntent: userIntentRef.current,
      });
      userIntentRef.current = "none";

      const latestSnapshot = driver.getSnapshot();
      const routeKey = routeKeyFrom(optionsRef.current.historyStartKey);
      if (routeKey && pendingScrollResumeStateRef.current === null) {
        schedulePersistScrollResume({
          routeKey,
          scrollTop: element.scrollTop,
          followOutput: latestSnapshot.mode === "sticky_bottom",
        });
      }

      const latest = optionsRef.current;
      if (
        shouldRequestOlderHistory({
          hasOlderHistory: latest.hasOlderHistory ?? false,
          isHistoryStartReady: historyStartReadyRef.current,
          isLoadingOlderHistory: latest.isLoadingOlderHistory ?? false,
          scrollTop: element.scrollTop,
        })
      ) {
        pendingHistoryPrependAnchorRef.current = {
          previousScrollHeight: element.scrollHeight,
          previousScrollTop: element.scrollTop,
        };
        latest.onNearHistoryStart?.();
      }
    };

    element.addEventListener("wheel", handleWheel, { passive: true });
    element.addEventListener("touchstart", handleTouchStart, { passive: true });
    element.addEventListener("touchmove", handleTouchMove, { passive: true });
    element.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => {
      element.removeEventListener("wheel", handleWheel);
      element.removeEventListener("touchstart", handleTouchStart);
      element.removeEventListener("touchmove", handleTouchMove);
      element.removeEventListener("scroll", handleScroll);
    };
  }, [driver, markUserIntent, readMeasurementState, schedulePersistScrollResume]);

  useEffect(() => {
    driver.prepareForStickyContentChange();
    publishScrollDebug();
  }, [driver, publishScrollDebug, signals.followSignal]);

  useEffect(() => {
    driver.prepareForStickyContentChange();
    publishScrollDebug();
  }, [driver, publishScrollDebug, signals.layoutSignal]);

  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement || typeof ResizeObserver === "undefined") return;

    const readContentHeight = () =>
      contentRef.current?.scrollHeight ?? scrollElement.scrollHeight;
    const readViewportHeight = () => scrollElement.clientHeight;
    const readViewportWidth = () => scrollElement.clientWidth;

    lastKnownContentHeightRef.current = readContentHeight();
    lastKnownViewportHeightRef.current = readViewportHeight();
    lastKnownViewportWidthRef.current = readViewportWidth();

    const observer = new ResizeObserver(() => {
      const previousContentHeight = lastKnownContentHeightRef.current;
      const previousViewportHeight = lastKnownViewportHeightRef.current;
      const previousViewportWidth = lastKnownViewportWidthRef.current;
      const contentHeight = readContentHeight();
      const viewportHeight = readViewportHeight();
      const viewportWidth = readViewportWidth();
      lastKnownContentHeightRef.current = contentHeight;
      lastKnownViewportHeightRef.current = viewportHeight;
      lastKnownViewportWidthRef.current = viewportWidth;

      const prependAnchorUpdate = deriveHistoryPrependAnchorAfterResize({
        anchor: pendingHistoryPrependAnchorRef.current,
        isLoadingOlderHistory:
          optionsRef.current.isLoadingOlderHistory ?? false,
        scrollHeight: scrollElement.scrollHeight,
      });
      if (prependAnchorUpdate.scrollTop !== null) {
        scrollElement.scrollTop = prependAnchorUpdate.scrollTop;
        lastKnownScrollTopRef.current = prependAnchorUpdate.scrollTop;
        pendingHistoryPrependAnchorRef.current = prependAnchorUpdate.nextAnchor;
      }

      if (tryRestoreScrollResume()) return;

      driver.handleViewportMetricsChange({
        previousViewportHeight,
        previousViewportWidth,
        viewportHeight,
        viewportWidth,
      });
      driver.handleContentSizeChange({
        previousContentHeight,
        contentHeight,
      });
    });

    observer.observe(scrollElement);
    const contentElement = contentRef.current;
    if (contentElement && contentElement !== scrollElement) {
      observer.observe(contentElement);
    }

    return () => {
      observer.disconnect();
    };
  }, [driver, tryRestoreScrollResume]);

  useEffect(
    () => () => {
      driver.destroy();
      cancelPendingScrollResumePersist();
      cancelUserIntentReset();
    },
    [cancelPendingScrollResumePersist, cancelUserIntentReset, driver],
  );

  return {
    contentRef,
    debug,
    scrollRef,
    followOutput,
    requestBottomAnchor: (reason) => {
      localAnchorSequenceRef.current += 1;
      const routeKey = routeKeyFrom(optionsRef.current.historyStartKey) ?? "unscoped";
      driver.requestLocalAnchor({
        reason,
        requestKey: `${routeKey}:${reason}:${localAnchorSequenceRef.current}`,
      });
    },
    prepareForViewportChange: () => {
      driver.prepareForStickyViewportChange();
    },
  };
}
