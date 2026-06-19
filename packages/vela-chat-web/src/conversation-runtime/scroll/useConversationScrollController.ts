"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  type BottomAnchorRouteBlockedReason,
  deriveBottomAnchorFollowState,
  deriveBottomAnchorRouteReadiness,
  shouldCancelPendingStickForUserScrollIntent,
  shouldRestickOnContentSizeChange,
  shouldRetryBottomStickAfterSettle,
  shouldRestickOnViewportSizeChange,
} from "./bottomAnchor";
import {
  deriveScrollTopAfterHistoryPrepend,
  shouldRequestOlderHistory,
} from "./historyPaging";
import {
  type ConversationScrollResumeState,
  deriveConversationScrollResumeDecision,
  persistConversationScrollResumeState,
  readConversationScrollResumeState,
} from "./routeResume";

const USER_SCROLL_ACTIVITY_RESET_MS = 180;
const BOTTOM_STICK_SETTLE_RETRY_MS = 200;

export interface ConversationScrollControllerOptions {
  hasOlderHistory?: boolean;
  historyStartKey?: unknown;
  isLoadingOlderHistory?: boolean;
  onNearHistoryStart?: () => void;
}

export interface ConversationScrollController {
  contentRef: RefObject<HTMLDivElement | null>;
  debug: ConversationScrollControllerDebug;
  scrollRef: RefObject<HTMLElement | null>;
  followOutput: boolean;
  forceScrollToBottom: () => void;
  prepareForViewportChange: () => void;
}

export interface ConversationScrollControllerDebug {
  followOutput: boolean;
  bottomAnchorBlockedReason: BottomAnchorRouteBlockedReason | null;
  routeResumeStatus: ConversationScrollRouteResumeStatus;
  routeResumeScrollTop: number | null;
}

export type ConversationScrollRouteResumeStatus =
  | "idle"
  | "pending"
  | "restored";

export function useConversationScrollController(
  dependency: unknown,
  options: ConversationScrollControllerOptions = {},
): ConversationScrollController {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLElement | null>(null);
  const followOutputRef = useRef(true);
  const lastKnownContentHeightRef = useRef(0);
  const lastKnownViewportHeightRef = useRef(0);
  const lastKnownViewportWidthRef = useRef(0);
  const lastKnownScrollTopRef = useRef(0);
  const lastBottomAnchorBlockedReasonRef =
    useRef<BottomAnchorRouteBlockedReason | null>(null);
  const pendingScrollResumeStateRef =
    useRef<ConversationScrollResumeState | null>(null);
  const routeResumeStatusRef =
    useRef<ConversationScrollRouteResumeStatus>("idle");
  const routeResumeScrollTopRef = useRef<number | null>(null);
  const lastTouchClientYRef = useRef<number | null>(null);
  const pendingFrameRef = useRef<number | null>(null);
  const pendingSettleTimeoutRef = useRef<number | null>(null);
  const pendingScrollResumePersistFrameRef = useRef<number | null>(null);
  const latestScrollResumePersistStateRef =
    useRef<ConversationScrollResumeState | null>(null);
  const pendingHistoryPrependAnchorRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const pendingUserScrollUpIntentRef = useRef(false);
  const historyStartReadyRef = useRef(false);
  const userScrollActiveRef = useRef(false);
  const userScrollActivityTimeoutRef = useRef<number | null>(null);
  const optionsRef = useRef(options);
  const [followOutput, setFollowOutputState] = useState(true);
  const [debug, setDebug] = useState<ConversationScrollControllerDebug>({
    followOutput: true,
    bottomAnchorBlockedReason: null,
    routeResumeStatus: "idle",
    routeResumeScrollTop: null,
  });

  optionsRef.current = options;

  const publishScrollDebug = useCallback(
    (override: Partial<ConversationScrollControllerDebug> = {}) => {
      const next = {
        followOutput: followOutputRef.current,
        bottomAnchorBlockedReason: lastBottomAnchorBlockedReasonRef.current,
        routeResumeStatus: routeResumeStatusRef.current,
        routeResumeScrollTop: routeResumeScrollTopRef.current,
        ...override,
      };
      setDebug((current) =>
        current.followOutput === next.followOutput &&
        current.bottomAnchorBlockedReason === next.bottomAnchorBlockedReason &&
        current.routeResumeStatus === next.routeResumeStatus &&
        current.routeResumeScrollTop === next.routeResumeScrollTop
          ? current
          : next,
      );
    },
    [],
  );

  const setFollowOutput = useCallback((value: boolean) => {
    if (followOutputRef.current === value) return;
    followOutputRef.current = value;
    setFollowOutputState(value);
    publishScrollDebug({ followOutput: value });
  }, [publishScrollDebug]);

  const cancelUserScrollActivityReset = useCallback(() => {
    if (userScrollActivityTimeoutRef.current === null) return;
    clearTimeout(userScrollActivityTimeoutRef.current);
    userScrollActivityTimeoutRef.current = null;
  }, []);

  const markUserScrollActivity = useCallback(
    (input: { scrollUpIntent?: boolean } = {}) => {
      userScrollActiveRef.current = true;
      if (input.scrollUpIntent) pendingUserScrollUpIntentRef.current = true;
      cancelUserScrollActivityReset();
      userScrollActivityTimeoutRef.current = window.setTimeout(() => {
        userScrollActiveRef.current = false;
        userScrollActivityTimeoutRef.current = null;
      }, USER_SCROLL_ACTIVITY_RESET_MS);
    },
    [cancelUserScrollActivityReset],
  );

  const cancelPendingFrame = useCallback(() => {
    if (pendingFrameRef.current === null) return;
    cancelAnimationFrame(pendingFrameRef.current);
    pendingFrameRef.current = null;
  }, []);

  const cancelPendingSettleRetry = useCallback(() => {
    if (pendingSettleTimeoutRef.current === null) return;
    clearTimeout(pendingSettleTimeoutRef.current);
    pendingSettleTimeoutRef.current = null;
  }, []);

  const cancelPendingScrollResumePersist = useCallback(() => {
    if (pendingScrollResumePersistFrameRef.current === null) return;
    cancelAnimationFrame(pendingScrollResumePersistFrameRef.current);
    pendingScrollResumePersistFrameRef.current = null;
  }, []);

  const cancelPendingStickToBottom = useCallback(() => {
    cancelPendingFrame();
    cancelPendingSettleRetry();
  }, [cancelPendingFrame, cancelPendingSettleRetry]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior });
    lastKnownScrollTopRef.current = element.scrollTop;
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
      pendingVerification: pendingSettleTimeoutRef.current !== null,
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
  }, [publishScrollDebug]);

  const scheduleStickToBottom = useCallback(() => {
    const element = scrollRef.current;
    const contentHeight = contentRef.current?.scrollHeight ?? element?.scrollHeight ?? 0;
    const requestKey = optionsRef.current.historyStartKey;
    const { blockedReason, canAttempt } = deriveBottomAnchorRouteReadiness({
      contentHeight,
      isHistoryReady: historyStartReadyRef.current,
      pendingVerification: pendingSettleTimeoutRef.current !== null,
      requestKey: requestKey == null ? null : String(requestKey),
      viewportHeight: element?.clientHeight ?? 0,
      viewportWidth: element?.clientWidth ?? 0,
    });
    lastBottomAnchorBlockedReasonRef.current = blockedReason;
    publishScrollDebug({ bottomAnchorBlockedReason: blockedReason });
    if (!canAttempt) {
      return;
    }

    cancelPendingFrame();
    pendingFrameRef.current = requestAnimationFrame(() => {
      pendingFrameRef.current = null;
      if (followOutputRef.current) scrollToBottom("auto");
    });
    if (pendingSettleTimeoutRef.current !== null) return;
    pendingSettleTimeoutRef.current = window.setTimeout(() => {
      pendingSettleTimeoutRef.current = null;
      const element = scrollRef.current;
      if (
        element &&
        shouldRetryBottomStickAfterSettle({
          clientHeight: element.clientHeight,
          followOutput: followOutputRef.current,
          scrollHeight: element.scrollHeight,
          scrollTop: element.scrollTop,
        })
      ) {
        scrollToBottom("auto");
      }
    }, BOTTOM_STICK_SETTLE_RETRY_MS);
  }, [cancelPendingFrame, publishScrollDebug, scrollToBottom]);

  useEffect(() => {
    cancelPendingStickToBottom();
    historyStartReadyRef.current = false;
    pendingHistoryPrependAnchorRef.current = null;
    const routeKey =
      options.historyStartKey == null ? null : String(options.historyStartKey);
    const resumeState =
      typeof window === "undefined"
        ? null
        : readConversationScrollResumeState(window.sessionStorage, routeKey);
    pendingScrollResumeStateRef.current =
      resumeState && !resumeState.followOutput ? resumeState : null;
    routeResumeStatusRef.current = pendingScrollResumeStateRef.current
      ? "pending"
      : "idle";
    routeResumeScrollTopRef.current =
      pendingScrollResumeStateRef.current?.scrollTop ?? null;
    followOutputRef.current = !pendingScrollResumeStateRef.current;
    setFollowOutputState(followOutputRef.current);
    publishScrollDebug();
    const frame = requestAnimationFrame(() => {
      historyStartReadyRef.current = true;
      if (tryRestoreScrollResume()) return;
      if (followOutputRef.current) scheduleStickToBottom();
    });
    return () => {
      cancelAnimationFrame(frame);
      historyStartReadyRef.current = false;
    };
  }, [
    cancelPendingStickToBottom,
    options.historyStartKey,
    publishScrollDebug,
    scheduleStickToBottom,
    tryRestoreScrollResume,
  ]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    lastKnownScrollTopRef.current = element.scrollTop;

    const handleWheel = (event: WheelEvent) => {
      const scrollUpIntent = event.deltaY < 0;
      if (shouldCancelPendingStickForUserScrollIntent({ scrollUpIntent })) {
        cancelPendingStickToBottom();
      }
      markUserScrollActivity({ scrollUpIntent });
    };

    const handleTouchStart = (event: TouchEvent) => {
      lastTouchClientYRef.current = event.touches[0]?.clientY ?? null;
      markUserScrollActivity();
    };

    const handleTouchMove = (event: TouchEvent) => {
      const nextClientY = event.touches[0]?.clientY ?? null;
      const previousClientY = lastTouchClientYRef.current;
      if (nextClientY !== null && previousClientY !== null) {
        const scrollUpIntent = nextClientY > previousClientY + 1;
        if (shouldCancelPendingStickForUserScrollIntent({ scrollUpIntent })) {
          cancelPendingStickToBottom();
        }
        markUserScrollActivity({
          scrollUpIntent,
        });
      } else {
        markUserScrollActivity();
      }
      lastTouchClientYRef.current = nextClientY;
    };

    const handleScroll = () => {
      const nextBottomAnchorState = deriveBottomAnchorFollowState({
        clientHeight: element.clientHeight,
        followOutput: followOutputRef.current,
        pendingUserScrollUpIntent: pendingUserScrollUpIntentRef.current,
        previousScrollTop: lastKnownScrollTopRef.current,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
        userScrollActive: userScrollActiveRef.current,
      });
      pendingUserScrollUpIntentRef.current =
        nextBottomAnchorState.pendingUserScrollUpIntent;
      setFollowOutput(nextBottomAnchorState.followOutput);
      lastKnownScrollTopRef.current = element.scrollTop;
      const routeKey =
        optionsRef.current.historyStartKey == null
          ? null
          : String(optionsRef.current.historyStartKey);
      if (routeKey && pendingScrollResumeStateRef.current === null) {
        schedulePersistScrollResume({
          routeKey,
          scrollTop: element.scrollTop,
          followOutput: nextBottomAnchorState.followOutput,
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
          scrollHeight: element.scrollHeight,
          scrollTop: element.scrollTop,
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
  }, [
    cancelPendingStickToBottom,
    markUserScrollActivity,
    schedulePersistScrollResume,
    setFollowOutput,
  ]);

  useEffect(() => {
    if (followOutputRef.current) scheduleStickToBottom();
  }, [dependency, scheduleStickToBottom]);

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

      const pendingHistoryPrependAnchor = pendingHistoryPrependAnchorRef.current;
      if (
        pendingHistoryPrependAnchor &&
        scrollElement.scrollHeight > pendingHistoryPrependAnchor.scrollHeight
      ) {
        const nextScrollTop = deriveScrollTopAfterHistoryPrepend({
          previousScrollHeight: pendingHistoryPrependAnchor.scrollHeight,
          previousScrollTop: pendingHistoryPrependAnchor.scrollTop,
          scrollHeight: scrollElement.scrollHeight,
        });
        scrollElement.scrollTop = nextScrollTop;
        lastKnownScrollTopRef.current = nextScrollTop;
        pendingHistoryPrependAnchorRef.current = null;
      }

      if (tryRestoreScrollResume()) return;

      if (
        shouldRestickOnContentSizeChange({
          contentHeight,
          followOutput: followOutputRef.current,
          previousContentHeight,
        }) ||
        shouldRestickOnViewportSizeChange({
          followOutput: followOutputRef.current,
          previousViewportHeight,
          previousViewportWidth,
          viewportHeight,
          viewportWidth,
        })
      ) {
        scheduleStickToBottom();
      }
    });

    observer.observe(scrollElement);
    const contentElement = contentRef.current;
    if (contentElement && contentElement !== scrollElement) {
      observer.observe(contentElement);
    }

    return () => {
      observer.disconnect();
    };
  }, [scheduleStickToBottom, tryRestoreScrollResume]);

  useEffect(
    () => () => {
      cancelPendingStickToBottom();
      cancelPendingScrollResumePersist();
      cancelUserScrollActivityReset();
    },
    [
      cancelPendingScrollResumePersist,
      cancelPendingStickToBottom,
      cancelUserScrollActivityReset,
    ],
  );

  return {
    contentRef,
    debug,
    scrollRef,
    followOutput,
    forceScrollToBottom: () => {
      setFollowOutput(true);
      scrollToBottom("auto");
    },
    prepareForViewportChange: () => {
      if (followOutputRef.current) scheduleStickToBottom();
    },
  };
}
