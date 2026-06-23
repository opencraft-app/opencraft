"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { VelaClientStateStore } from "../../../../vela-chat-host-state/src";
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
  shouldRequestInitialBottomAnchorAfterResumeAttempt,
} from "./routeResume";
import {
  type ConversationScrollResumeWriter,
  createConversationScrollResumeWriter,
  deriveConversationScrollLeaveSnapshot,
  shouldPersistConversationScrollResumeSnapshot,
  shouldWriteConversationScrollLeaveSnapshot,
} from "./scrollResumePersistence";
import {
  readConversationScrollAnchorSnapshot,
  getConversationScrollAnchorRestoreTarget,
} from "./scrollAnchor";
import {
  applyConversationScrollWrite,
  type ConversationScrollRouteResumeStatus,
  type ConversationScrollWrite,
  type ConversationScrollWriteApplication,
  type ConversationScrollWriteBlockedBy,
  type ConversationScrollWriteSource,
} from "./scrollWrite";
import type { ConversationBottomAnchorReason } from "./viewportHandle";

const USER_SCROLL_ACTIVITY_RESET_MS = 180;
const ROUTE_RESUME_CONFIRMATION_MAX_ATTEMPTS = 8;
const ROUTE_RESUME_CONFIRMATION_REQUIRED_STABLE_FRAMES = 2;
const ROUTE_RESUME_CONFIRMATION_TOLERANCE_PX = 2;

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

interface RouteResumeVerification {
  attempts: number;
  frameId: number | null;
  stableFrames: number;
  targetScrollTop: number;
}

export interface ConversationScrollControllerOptions {
  clientStateStore?: VelaClientStateStore | null;
  hasOlderHistory?: boolean;
  historyStartKey?: unknown;
  isHistoryReady?: boolean;
  isLoadingOlderHistory?: boolean;
  onNearHistoryStart?: () => void;
  transportKey?: "web-scroll" | "web-partial-virtualized";
}

export interface ConversationScrollControllerSignals {
  followSignal: string;
  layoutSignal: string;
}

export interface ConversationScrollController {
  contentRef: RefObject<HTMLDivElement | null>;
  debug: ConversationScrollControllerDebug;
  initialScrollTop: number | null;
  scrollRef: RefObject<HTMLElement | null>;
  followOutput: boolean;
  commitScrollResumeNow: (input?: {
    scrollTop?: number;
    userIntent?: BottomAnchorUserIntent;
  }) => void;
  markUserScrollIntent: (intent: BottomAnchorUserIntent) => void;
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
  lastScrollWrite: ConversationScrollControllerDebugWrite | null;
  lastFollowSignal: string;
  lastLayoutSignal: string;
}

export interface ConversationScrollControllerDebugWrite {
  action: "apply" | "suppress";
  blockedBy: ConversationScrollWriteBlockedBy | null;
  nextScrollTop: number;
  previousScrollTop: number;
  reason: string;
  source: ConversationScrollWriteSource;
}

export type { ConversationScrollRouteResumeStatus } from "./scrollWrite";

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

function scrollDebugWritesEqual(
  left: ConversationScrollControllerDebugWrite | null,
  right: ConversationScrollControllerDebugWrite | null,
) {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.action === right.action &&
    left.blockedBy === right.blockedBy &&
    left.nextScrollTop === right.nextScrollTop &&
    left.previousScrollTop === right.previousScrollTop &&
    left.reason === right.reason &&
    left.source === right.source
  );
}

function debugWriteFromApplication(
  application: ConversationScrollWriteApplication,
): ConversationScrollControllerDebugWrite {
  return {
    action: application.decision.action,
    blockedBy: application.decision.blockedBy,
    nextScrollTop: application.nextScrollTop,
    previousScrollTop: application.previousScrollTop,
    reason: application.decision.write.reason,
    source: application.decision.write.source,
  };
}

function readInitialRouteScrollTop(
  options: ConversationScrollControllerOptions,
): number | null {
  const routeKey = routeKeyFrom(options.historyStartKey);
  if (!routeKey) return null;
  const resumeState = options.clientStateStore?.conversationScroll.read(routeKey) ?? null;
  if (!resumeState || resumeState.followOutput) return null;
  return Number.isFinite(resumeState.scrollTop) ? resumeState.scrollTop : null;
}

export function useConversationScrollController(
  signals: ConversationScrollControllerSignals,
  options: ConversationScrollControllerOptions = {},
): ConversationScrollController {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLElement | null>(null);
  const lastKnownContentHeightRef = useRef(0);
  const lastKnownScrollAnchorRef = useRef<{
    anchor: ConversationScrollResumeState["anchor"];
    routeKey: string;
    scrollTop: number;
  } | null>(null);
  const lastKnownViewportHeightRef = useRef(0);
  const lastKnownViewportWidthRef = useRef(0);
  const lastKnownScrollTopRef = useRef(0);
  const hasObservedScrollEventForRouteRef = useRef(false);
  const latestFollowSignalRef = useRef(signals.followSignal);
  const latestLayoutSignalRef = useRef(signals.layoutSignal);
  const pendingScrollResumeStateRef =
    useRef<ConversationScrollResumeState | null>(null);
  const routeResumeStatusRef =
    useRef<ConversationScrollRouteResumeStatus>("idle");
  const routeResumeScrollTopRef = useRef<number | null>(null);
  const routeResumeVerificationRef =
    useRef<RouteResumeVerification | null>(null);
  const scrollResumeWriterRef =
    useRef<ConversationScrollResumeWriter<number> | null>(null);
  const pendingHistoryPrependAnchorRef =
    useRef<ActiveHistoryPrependAnchor | null>(null);
  const lastScrollWriteRef =
    useRef<ConversationScrollControllerDebugWrite | null>(null);
  const historyStartReadyRef = useRef(false);
  const historyReadyActivationFrameRef = useRef<number | null>(null);
  const lastTouchClientYRef = useRef<number | null>(null);
  const userIntentRef = useRef<BottomAnchorUserIntent>("none");
  const userIntentResetTimeoutRef = useRef<number | null>(null);
  const optionsRef = useRef(options);
  const localAnchorSequenceRef = useRef(0);
  const driverRef = useRef<BottomAnchorDriver | null>(null);
  const driverSnapshotRef = useRef<BottomAnchorDriverSnapshot>(emptyDriverSnapshot());
  const initialRouteScrollRef = useRef<{
    routeKey: string | null;
    scrollTop: number | null;
  }>({
    routeKey: null,
    scrollTop: null,
  });

  const [followOutput, setFollowOutputState] = useState(true);
  const [debug, setDebug] = useState<ConversationScrollControllerDebug>({
    followOutput: true,
    bottomAnchorMode: "sticky_bottom",
    bottomAnchorBlockedReason: null,
    bottomAnchorPendingReason: null,
    bottomAnchorLastFulfilledReason: null,
    routeResumeStatus: "idle",
    routeResumeScrollTop: null,
    lastScrollWrite: null,
    lastFollowSignal: signals.followSignal,
    lastLayoutSignal: signals.layoutSignal,
  });

  optionsRef.current = options;
  latestFollowSignalRef.current = signals.followSignal;
  latestLayoutSignalRef.current = signals.layoutSignal;
  const currentRouteKey = routeKeyFrom(options.historyStartKey);
  if (initialRouteScrollRef.current.routeKey !== currentRouteKey) {
    initialRouteScrollRef.current = {
      routeKey: currentRouteKey,
      scrollTop: readInitialRouteScrollTop(options),
    };
  }

  if (!scrollResumeWriterRef.current) {
    scrollResumeWriterRef.current = createConversationScrollResumeWriter({
      cancelFrame: (frameId) => cancelAnimationFrame(frameId),
      scheduleFrame: (callback) => requestAnimationFrame(callback),
      write: (state) => {
        optionsRef.current.clientStateStore?.conversationScroll.write(
          state.routeKey,
          state,
        );
      },
    });
  }

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
        lastScrollWrite: lastScrollWriteRef.current,
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
        scrollDebugWritesEqual(current.lastScrollWrite, next.lastScrollWrite) &&
        current.lastFollowSignal === next.lastFollowSignal &&
        current.lastLayoutSignal === next.lastLayoutSignal
          ? current
          : next,
      );
    },
    [],
  );

  const readMeasurementStateForRoute = useCallback(
    (routeKeyOverride?: string | null): BottomAnchorMeasurementState => {
      const element = scrollRef.current;
      const routeKey =
        routeKeyOverride ??
        routeKeyFrom(optionsRef.current.historyStartKey) ??
        "unscoped";
      const transportKey = optionsRef.current.transportKey ?? "web-scroll";
      const containerKey = `${transportKey}:${routeKey}`;
      const viewportWidth =
        element?.clientWidth ?? lastKnownViewportWidthRef.current;
      const viewportHeight =
        element?.clientHeight ?? lastKnownViewportHeightRef.current;
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
    },
    [],
  );

  const readMeasurementState = useCallback(
    (): BottomAnchorMeasurementState => readMeasurementStateForRoute(),
    [readMeasurementStateForRoute],
  );

  const readRouteLeaveMeasurementStateForRoute = useCallback(
    (routeKeyOverride: string | null): BottomAnchorMeasurementState => {
      const element = scrollRef.current;
      const routeKey =
        routeKeyOverride ??
        routeKeyFrom(optionsRef.current.historyStartKey) ??
        "unscoped";
      const transportKey = optionsRef.current.transportKey ?? "web-scroll";
      const containerKey = `${transportKey}:${routeKey}`;
      const viewportWidth =
        lastKnownViewportWidthRef.current || element?.clientWidth || 0;
      const viewportHeight =
        lastKnownViewportHeightRef.current || element?.clientHeight || 0;
      const contentHeight =
        lastKnownContentHeightRef.current ||
        contentRef.current?.scrollHeight ||
        element?.scrollHeight ||
        0;
      const scrollTop = hasObservedScrollEventForRouteRef.current
        ? lastKnownScrollTopRef.current
        : element?.scrollTop ?? lastKnownScrollTopRef.current;

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
    },
    [],
  );

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

  const applyScrollWrite = useCallback(
    (element: ScrollableElement, write: ConversationScrollWrite) => {
      const application = applyConversationScrollWrite({
        element,
        phase: { routeResumeStatus: routeResumeStatusRef.current },
        write,
      });
      lastScrollWriteRef.current = debugWriteFromApplication(application);
      if (application.applied) {
        lastKnownScrollTopRef.current = application.nextScrollTop;
      }
      publishScrollDebug();
      return application;
    },
    [publishScrollDebug],
  );

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const element = scrollRef.current;
    if (!element) return;
    const application = applyScrollWrite(element, {
      behavior,
      reason: "bottom_follow",
      scrollTop: element.scrollHeight,
      source: "bottom_follow",
    });
    if (!application.applied) return;
  }, [applyScrollWrite]);

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

  const flushPendingScrollResumePersist = useCallback(() => {
    scrollResumeWriterRef.current?.flush();
  }, []);

  const cancelRouteResumeVerification = useCallback(() => {
    const verification = routeResumeVerificationRef.current;
    if (verification?.frameId !== null && verification?.frameId !== undefined) {
      cancelAnimationFrame(verification.frameId);
    }
    routeResumeVerificationRef.current = null;
  }, []);

  const cancelPendingRouteResumeForUserScroll = useCallback(
    (input: { scrollTop: number; userIntent: BottomAnchorUserIntent }) => {
      if (input.userIntent === "none") return false;
      if (!pendingScrollResumeStateRef.current) return false;
      if (routeResumeStatusRef.current !== "pending") return false;
      const routeResumeScrollTop = routeResumeScrollTopRef.current;
      if (
        routeResumeScrollTop !== null &&
        Math.abs(input.scrollTop - routeResumeScrollTop) <=
          ROUTE_RESUME_CONFIRMATION_TOLERANCE_PX
      ) {
        return false;
      }

      pendingScrollResumeStateRef.current = null;
      cancelRouteResumeVerification();
      routeResumeStatusRef.current = "idle";
      routeResumeScrollTopRef.current = null;
      publishScrollDebug();
      return true;
    },
    [cancelRouteResumeVerification, publishScrollDebug],
  );

  const schedulePersistScrollResume = useCallback(
    (state: ConversationScrollResumeState) => {
      scrollResumeWriterRef.current?.schedule(state);
    },
    [],
  );

  const readCurrentScrollAnchor = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return null;
    return readConversationScrollAnchorSnapshot({
      container: element,
      content: contentRef.current,
    });
  }, []);

  const captureScrollAnchorForRoute = useCallback(
    (input: { routeKey: string; scrollTop: number }) => {
      const anchor = readCurrentScrollAnchor();
      lastKnownScrollAnchorRef.current = anchor
        ? {
            anchor,
            routeKey: input.routeKey,
            scrollTop: input.scrollTop,
          }
        : null;
      return anchor;
    },
    [readCurrentScrollAnchor],
  );

  const readCapturedScrollAnchorForRoute = useCallback(
    (input: { routeKey: string | null; scrollTop: number }) => {
      const captured = lastKnownScrollAnchorRef.current;
      if (!input.routeKey || !captured || captured.routeKey !== input.routeKey) {
        return null;
      }
      if (Math.abs(captured.scrollTop - input.scrollTop) > 2) return null;
      return captured.anchor ?? null;
    },
    [],
  );

  const shouldPersistScrollResume = useCallback(() => {
    return shouldPersistConversationScrollResumeSnapshot({
      hasPendingResumeState: pendingScrollResumeStateRef.current !== null,
      isHistoryReady: historyStartReadyRef.current,
      routeKey: routeKeyFrom(optionsRef.current.historyStartKey),
    });
  }, []);

  const persistScrollResumeSnapshot = useCallback(
    (input: { followOutput: boolean; flush?: boolean; scrollTop: number }) => {
      if (!shouldPersistScrollResume()) return;
      const routeKey = routeKeyFrom(optionsRef.current.historyStartKey);
      if (!routeKey) return;
      const scrollAnchor = !input.followOutput
        ? captureScrollAnchorForRoute({
            routeKey,
            scrollTop: input.scrollTop,
          })
        : null;
      schedulePersistScrollResume({
        routeKey,
        scrollTop: input.scrollTop,
        followOutput: input.followOutput,
        ...(!input.followOutput && scrollAnchor ? { anchor: scrollAnchor } : {}),
      });
      if (input.flush) flushPendingScrollResumePersist();
    },
    [
      flushPendingScrollResumePersist,
      captureScrollAnchorForRoute,
      schedulePersistScrollResume,
      shouldPersistScrollResume,
    ],
  );

  const persistRouteLeaveScrollResumeSnapshot = useCallback(
    (routeKey: string | null) => {
      flushPendingScrollResumePersist();
      const measurement = readRouteLeaveMeasurementStateForRoute(routeKey);
      const state = deriveConversationScrollLeaveSnapshot({
        hasPendingResumeState: pendingScrollResumeStateRef.current !== null,
        isHistoryReady: historyStartReadyRef.current,
        measurement,
        routeKey,
        scrollAnchor: readCapturedScrollAnchorForRoute({
          routeKey,
          scrollTop: measurement.scrollTop,
        }),
      });
      if (!state) return;
      const existingState = routeKey
        ? optionsRef.current.clientStateStore?.conversationScroll.read(routeKey) ?? null
        : null;
      if (
        !shouldWriteConversationScrollLeaveSnapshot({
          existingState,
          nextState: state,
        })
      ) {
        return;
      }
      schedulePersistScrollResume(state);
      flushPendingScrollResumePersist();
    },
    [
      flushPendingScrollResumePersist,
      readRouteLeaveMeasurementStateForRoute,
      readCapturedScrollAnchorForRoute,
      schedulePersistScrollResume,
    ],
  );

  const completeRouteResumeVerification = useCallback(
    (targetScrollTop: number) => {
      pendingScrollResumeStateRef.current = null;
      routeResumeVerificationRef.current = null;
      routeResumeStatusRef.current = "restored";
      routeResumeScrollTopRef.current = targetScrollTop;
      publishScrollDebug();
    },
    [publishScrollDebug],
  );

  const scheduleRouteResumeConfirmation = useCallback(
    (targetScrollTop: number) => {
      const scheduleNextFrame = () => {
        const active = routeResumeVerificationRef.current;
        if (!active || active.frameId !== null) return;

        active.frameId = requestAnimationFrame(() => {
          const verification = routeResumeVerificationRef.current;
          if (!verification) return;
          verification.frameId = null;

          const element = scrollRef.current;
          if (!pendingScrollResumeStateRef.current || !element) {
            routeResumeVerificationRef.current = null;
            return;
          }

          const target = verification.targetScrollTop;
          const resumeState = pendingScrollResumeStateRef.current;
          const anchorTarget =
            resumeState && element
              ? getConversationScrollAnchorRestoreTarget({
                  anchor: resumeState.anchor,
                  container: element,
                  content: contentRef.current,
                })
              : null;
          const effectiveTarget = anchorTarget ?? target;
          if (effectiveTarget !== target) {
            applyScrollWrite(element, {
              reason: "route_resume_anchor_confirmation",
              scrollTop: effectiveTarget,
              source: "route_resume_confirmation",
            });
            routeResumeStatusRef.current = "pending";
            routeResumeScrollTopRef.current = effectiveTarget;
            routeResumeVerificationRef.current = {
              ...verification,
              frameId: null,
              stableFrames: 0,
              targetScrollTop: effectiveTarget,
            };
            publishScrollDebug();
            scheduleNextFrame();
            return;
          }
          if (
            Math.abs(element.scrollTop - effectiveTarget) <=
            ROUTE_RESUME_CONFIRMATION_TOLERANCE_PX
          ) {
            const stableFrames = verification.stableFrames + 1;
            lastKnownScrollTopRef.current = element.scrollTop;
            if (
              stableFrames >=
              ROUTE_RESUME_CONFIRMATION_REQUIRED_STABLE_FRAMES
            ) {
              completeRouteResumeVerification(effectiveTarget);
              return;
            }

            routeResumeVerificationRef.current = {
              ...verification,
              stableFrames,
            };
            scheduleNextFrame();
            return;
          }

          applyScrollWrite(element, {
            reason: "route_resume_confirmation",
            scrollTop: effectiveTarget,
            source: "route_resume_confirmation",
          });

          const attempts = verification.attempts + 1;
          if (attempts >= ROUTE_RESUME_CONFIRMATION_MAX_ATTEMPTS) {
            completeRouteResumeVerification(effectiveTarget);
            return;
          }

          routeResumeStatusRef.current = "pending";
          routeResumeScrollTopRef.current = effectiveTarget;
          routeResumeVerificationRef.current = {
            attempts,
            frameId: null,
            stableFrames: 0,
            targetScrollTop: effectiveTarget,
          };
          publishScrollDebug();
          scheduleNextFrame();
        });
      };

      const active = routeResumeVerificationRef.current;
      if (
        active &&
        active.targetScrollTop !== targetScrollTop &&
        active.frameId !== null
      ) {
        cancelAnimationFrame(active.frameId);
      }
      routeResumeVerificationRef.current = {
        attempts: active?.targetScrollTop === targetScrollTop ? active.attempts : 0,
        frameId: active?.targetScrollTop === targetScrollTop ? active.frameId : null,
        stableFrames:
          active?.targetScrollTop === targetScrollTop ? active.stableFrames : 0,
        targetScrollTop,
      };
      scheduleNextFrame();
    },
    [applyScrollWrite, completeRouteResumeVerification, publishScrollDebug],
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

    if (!decision.shouldRestore || decision.scrollTop === null) {
      pendingScrollResumeStateRef.current = null;
      cancelRouteResumeVerification();
      routeResumeStatusRef.current = "idle";
      routeResumeScrollTopRef.current = null;
      publishScrollDebug();
      return false;
    }

    applyScrollWrite(element, {
      reason: "route_resume",
      scrollTop: decision.scrollTop,
      source: "route_resume",
    });
    const anchorTarget = getConversationScrollAnchorRestoreTarget({
      anchor: resumeState.anchor,
      container: element,
      content: contentRef.current,
    });
    if (anchorTarget !== null && Math.abs(anchorTarget - element.scrollTop) > 0.5) {
      applyScrollWrite(element, {
        reason: "route_resume_anchor",
        scrollTop: anchorTarget,
        source: "route_resume",
      });
    }
    const targetScrollTop = anchorTarget ?? decision.scrollTop;
    routeResumeStatusRef.current = "pending";
    routeResumeScrollTopRef.current = targetScrollTop;
    driver.reset({ mode: "detached", detachReason: "route_restore" });
    scheduleRouteResumeConfirmation(targetScrollTop);
    publishScrollDebug();
    return true;
  }, [
    applyScrollWrite,
    cancelRouteResumeVerification,
    driver,
    publishScrollDebug,
    scheduleRouteResumeConfirmation,
  ]);

  const cancelHistoryReadyActivation = useCallback(() => {
    if (historyReadyActivationFrameRef.current === null) return;
    cancelAnimationFrame(historyReadyActivationFrameRef.current);
    historyReadyActivationFrameRef.current = null;
  }, []);

  const scheduleHistoryReadyActivation = useCallback(
    (routeKey: string | null) => {
      cancelHistoryReadyActivation();
      historyReadyActivationFrameRef.current = requestAnimationFrame(() => {
        historyReadyActivationFrameRef.current = null;
        if (routeKey !== routeKeyFrom(optionsRef.current.historyStartKey)) return;
        if (optionsRef.current.isHistoryReady === false) return;

        historyStartReadyRef.current = true;
        const didRestore = tryRestoreScrollResume();
        if (
          routeKey &&
          shouldRequestInitialBottomAnchorAfterResumeAttempt({
            didRestore,
            hasPendingResumeState: pendingScrollResumeStateRef.current !== null,
          })
        ) {
          driver.applyRouteRequest({
            reason: "route_initial_entry",
            requestKey: `${routeKey}:route_initial_entry`,
          });
        }
        driver.notifyAuthoritativeHistoryMaybeChanged();
      });
    },
    [cancelHistoryReadyActivation, driver, tryRestoreScrollResume],
  );

  useLayoutEffect(() => {
    const routeKey = routeKeyFrom(options.historyStartKey);
    cancelHistoryReadyActivation();
    cancelRouteResumeVerification();
    driver.reset();
    historyStartReadyRef.current = false;
    hasObservedScrollEventForRouteRef.current = false;
    lastKnownScrollAnchorRef.current = null;
    pendingHistoryPrependAnchorRef.current = null;
    const resumeState = routeKey
      ? options.clientStateStore?.conversationScroll.read(routeKey) ?? null
      : null;
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

    if (optionsRef.current.isHistoryReady !== false) {
      scheduleHistoryReadyActivation(routeKey);
    }
    return () => {
      cancelHistoryReadyActivation();
      cancelRouteResumeVerification();
      persistRouteLeaveScrollResumeSnapshot(routeKey);
      historyStartReadyRef.current = false;
      flushPendingScrollResumePersist();
    };
  }, [
    driver,
    cancelHistoryReadyActivation,
    cancelRouteResumeVerification,
    flushPendingScrollResumePersist,
    options.historyStartKey,
    persistRouteLeaveScrollResumeSnapshot,
    publishScrollDebug,
    scheduleHistoryReadyActivation,
  ]);

  useLayoutEffect(() => {
    if (options.isHistoryReady === false) {
      cancelHistoryReadyActivation();
      return;
    }
    if (historyStartReadyRef.current) return;
    scheduleHistoryReadyActivation(routeKeyFrom(options.historyStartKey));
  }, [
    cancelHistoryReadyActivation,
    options.historyStartKey,
    options.isHistoryReady,
    scheduleHistoryReadyActivation,
  ]);

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

    const handleScroll = (source: "event" | "sync") => {
      if (source === "event") {
        hasObservedScrollEventForRouteRef.current = true;
      }
      const previousScrollTop = lastKnownScrollTopRef.current;
      const scrollDelta = element.scrollTop - previousScrollTop;
      const userIntent = userIntentRef.current;
      lastKnownScrollTopRef.current = element.scrollTop;
      const measurement = readMeasurementState();
      if (source === "event") {
        cancelPendingRouteResumeForUserScroll({
          scrollTop: element.scrollTop,
          userIntent,
        });
      }
      driver.handleScrollNearBottomChange({
        nextIsNearBottom: isBottomAnchorMeasurementNearBottom(measurement),
        scrollDelta,
        userIntent,
      });

      persistScrollResumeSnapshot({
        scrollTop: element.scrollTop,
        followOutput: isBottomAnchorMeasurementNearBottom(measurement),
      });

      const latest = optionsRef.current;
      if (
        shouldRequestOlderHistory({
          hasOlderHistory: latest.hasOlderHistory ?? false,
          isHistoryStartReady: historyStartReadyRef.current,
          isLoadingOlderHistory: latest.isLoadingOlderHistory ?? false,
          requestIntent: userIntent,
          scrollTop: element.scrollTop,
        })
      ) {
        pendingHistoryPrependAnchorRef.current = {
          previousScrollHeight: element.scrollHeight,
          previousScrollTop: element.scrollTop,
        };
        latest.onNearHistoryStart?.();
      }
      userIntentRef.current = "none";
    };

    element.addEventListener("wheel", handleWheel, { passive: true });
    element.addEventListener("touchstart", handleTouchStart, { passive: true });
    element.addEventListener("touchmove", handleTouchMove, { passive: true });
    const handleScrollEvent = () => handleScroll("event");

    element.addEventListener("scroll", handleScrollEvent, { passive: true });
    handleScroll("sync");
    return () => {
      element.removeEventListener("wheel", handleWheel);
      element.removeEventListener("touchstart", handleTouchStart);
      element.removeEventListener("touchmove", handleTouchMove);
      element.removeEventListener("scroll", handleScrollEvent);
    };
  }, [
    cancelPendingRouteResumeForUserScroll,
    driver,
    markUserIntent,
    persistScrollResumeSnapshot,
    readMeasurementState,
  ]);

  useLayoutEffect(() => {
    if (tryRestoreScrollResume()) return;
    driver.prepareForStickyContentChange();
    publishScrollDebug();
  }, [driver, publishScrollDebug, signals.followSignal, tryRestoreScrollResume]);

  useLayoutEffect(() => {
    if (tryRestoreScrollResume()) return;
    driver.prepareForStickyContentChange();
    publishScrollDebug();
  }, [driver, publishScrollDebug, signals.layoutSignal, tryRestoreScrollResume]);

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

    const resizeObserver = new ResizeObserver(() => {
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
        applyScrollWrite(scrollElement, {
          reason: "history_prepend_anchor",
          scrollTop: prependAnchorUpdate.scrollTop,
          source: "history_prepend",
        });
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

    resizeObserver.observe(scrollElement);
    const contentElement = contentRef.current;
    if (contentElement && contentElement !== scrollElement) {
      resizeObserver.observe(contentElement);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, [applyScrollWrite, driver, tryRestoreScrollResume]);

  useEffect(
    () => () => {
      flushPendingScrollResumePersist();
      driver.destroy();
      scrollResumeWriterRef.current?.cancel();
      cancelHistoryReadyActivation();
      cancelRouteResumeVerification();
      cancelUserIntentReset();
    },
    [
      cancelHistoryReadyActivation,
      cancelRouteResumeVerification,
      cancelUserIntentReset,
      driver,
      flushPendingScrollResumePersist,
    ],
  );

  return {
    contentRef,
    debug,
    initialScrollTop: initialRouteScrollRef.current.scrollTop,
    scrollRef,
    followOutput,
    commitScrollResumeNow: (input = {}) => {
      const element = scrollRef.current;
      if (!element) return;
      const nextScrollTop = input.scrollTop ?? element.scrollTop;
      const previousScrollTop = lastKnownScrollTopRef.current;
      const userIntent = input.userIntent ?? userIntentRef.current;
      lastKnownScrollTopRef.current = nextScrollTop;
      driver.handleScrollNearBottomChange({
        nextIsNearBottom: isBottomAnchorMeasurementNearBottom(readMeasurementState()),
        scrollDelta: nextScrollTop - previousScrollTop,
        userIntent,
      });
      persistScrollResumeSnapshot({
        scrollTop: nextScrollTop,
        followOutput: driver.getSnapshot().mode === "sticky_bottom",
        flush: true,
      });
      userIntentRef.current = "none";
    },
    markUserScrollIntent: markUserIntent,
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
