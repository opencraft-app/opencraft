export const BOTTOM_ANCHOR_NEAR_BOTTOM_THRESHOLD_PX = 180;
export const BOTTOM_ANCHOR_AT_BOTTOM_THRESHOLD_PX = 1;
export const BOTTOM_ANCHOR_USER_SCROLL_AWAY_DELTA_PX = 24;
export const BOTTOM_ANCHOR_MAX_VERIFICATION_RETRIES = 3;

export type BottomAnchorMode = "sticky_bottom" | "detached";

export type BottomAnchorRequestReason =
  | "route_initial_entry"
  | "route_resume"
  | "message_sent"
  | "jump_to_bottom"
  | "viewport_changed"
  | "content_mutated";

export type BottomAnchorDetachReason = "user_scroll" | "route_restore";

export type BottomAnchorBlockedReason =
  | "waiting_for_history_readiness"
  | "waiting_for_measurable_viewport"
  | "waiting_for_measurable_content"
  | "waiting_for_resume_extent"
  | "waiting_for_post_layout_verification";

export type BottomAnchorUserIntent = "none" | "scroll_up" | "scroll_down";

export interface BottomAnchorRequest {
  id: number;
  reason: BottomAnchorRequestReason;
  requestKey: string;
  source: "route" | "local" | "maintenance";
  measurementRevisionAtCreated: number;
}

export interface BottomAnchorVerification {
  requestId: number | null;
  reason: BottomAnchorRequestReason;
  retries: number;
}

export interface BottomAnchorMeasurementState {
  containerKey: string;
  viewportMeasuredForKey: string | null;
  contentMeasuredForKey: string | null;
  viewportWidth: number;
  viewportHeight: number;
  contentHeight: number;
  scrollTop: number;
  bottomInsetPx: number;
}

export interface BottomAnchorDriverSnapshot {
  mode: BottomAnchorMode;
  pendingRequest: BottomAnchorRequest | null;
  pendingVerification: BottomAnchorVerification | null;
  blockedReason: BottomAnchorBlockedReason | null;
  measurementRevision: number;
  lastVerifiedMeasurementRevision: number;
  lastFulfilledReason: BottomAnchorRequestReason | null;
  detachReason: BottomAnchorDetachReason | null;
}

export interface BottomAnchorTransportBehavior {
  verificationDelayFrames: number;
  verificationRetryMode: "rescroll" | "recheck";
}

export interface BottomAnchorRouteRequestInput {
  reason: Extract<BottomAnchorRequestReason, "route_initial_entry" | "route_resume">;
  requestKey: string;
}

export interface BottomAnchorLocalRequestInput {
  reason: Extract<BottomAnchorRequestReason, "message_sent" | "jump_to_bottom">;
  requestKey: string;
}

export interface BottomAnchorSizeChangeInput {
  previousContentHeight: number;
  contentHeight: number;
}

export interface BottomAnchorViewportChangeInput {
  previousViewportWidth: number;
  viewportWidth: number;
  previousViewportHeight: number;
  viewportHeight: number;
}

export interface BottomAnchorScrollChangeInput {
  nextIsNearBottom: boolean;
  scrollDelta: number;
  userIntent: BottomAnchorUserIntent;
}

export interface BottomAnchorScrollRequest {
  reason: BottomAnchorRequestReason;
  animated: boolean;
}

export interface CreateBottomAnchorDriverInput {
  getIsAuthoritativeHistoryReady: () => boolean;
  getMeasurementState: () => BottomAnchorMeasurementState;
  isNearBottom: () => boolean;
  scrollToBottom: (request: BottomAnchorScrollRequest) => void;
  scheduleFrame: (request: {
    callback: () => void;
    delayFrames?: number;
  }) => unknown;
  cancelFrame: (handle: unknown) => void;
  getTransportBehavior?: () => BottomAnchorTransportBehavior;
  onSnapshotChange?: (snapshot: BottomAnchorDriverSnapshot) => void;
}

export interface BottomAnchorDriver {
  getSnapshot: () => BottomAnchorDriverSnapshot;
  reset: (input?: { mode?: BottomAnchorMode; detachReason?: BottomAnchorDetachReason | null }) => void;
  destroy: () => void;
  applyRouteRequest: (request: BottomAnchorRouteRequestInput | null) => void;
  requestLocalAnchor: (request: BottomAnchorLocalRequestInput) => void;
  detachByUser: (reason?: BottomAnchorDetachReason) => void;
  handleViewportMetricsChange: (input: BottomAnchorViewportChangeInput) => void;
  handleContentSizeChange: (input: BottomAnchorSizeChangeInput) => void;
  prepareForStickyViewportChange: () => void;
  prepareForStickyContentChange: () => void;
  handleScrollNearBottomChange: (input: BottomAnchorScrollChangeInput) => void;
  notifyAuthoritativeHistoryMaybeChanged: () => void;
  reevaluate: (animated?: boolean) => void;
}

const DEFAULT_TRANSPORT_BEHAVIOR: BottomAnchorTransportBehavior = {
  verificationDelayFrames: 0,
  verificationRetryMode: "rescroll",
};

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

export function getBottomAnchorDistanceFromBottom(
  measurement: Pick<
    BottomAnchorMeasurementState,
    "bottomInsetPx" | "contentHeight" | "scrollTop" | "viewportHeight"
  >,
): number {
  return (
    measurement.contentHeight +
    Math.max(0, measurement.bottomInsetPx) -
    (measurement.scrollTop + measurement.viewportHeight)
  );
}

export function isBottomAnchorMeasurementNearBottom(
  measurement: Pick<
    BottomAnchorMeasurementState,
    "bottomInsetPx" | "contentHeight" | "scrollTop" | "viewportHeight"
  >,
  threshold = BOTTOM_ANCHOR_NEAR_BOTTOM_THRESHOLD_PX,
): boolean {
  const distance = getBottomAnchorDistanceFromBottom(measurement);
  return Number.isFinite(distance) && distance <= threshold;
}

export function isBottomAnchorMeasurementAtBottom(
  measurement: Pick<
    BottomAnchorMeasurementState,
    "bottomInsetPx" | "contentHeight" | "scrollTop" | "viewportHeight"
  >,
): boolean {
  const distance = getBottomAnchorDistanceFromBottom(measurement);
  return Number.isFinite(distance) && distance <= BOTTOM_ANCHOR_AT_BOTTOM_THRESHOLD_PX;
}

export function isOverscrolledPastBottom({
  clientHeight,
  scrollHeight,
  scrollTop,
}: {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}): boolean {
  if (![clientHeight, scrollHeight, scrollTop].every(isFiniteNumber)) {
    return false;
  }
  return scrollHeight - clientHeight - scrollTop < 0;
}

function deriveBlockedReason(input: {
  isAuthoritativeHistoryReady: boolean;
  measurement: BottomAnchorMeasurementState;
  pendingVerification: BottomAnchorVerification | null;
  request: BottomAnchorRequest | null;
}): BottomAnchorBlockedReason | null {
  if (input.request?.source === "route" && !input.isAuthoritativeHistoryReady) {
    return "waiting_for_history_readiness";
  }
  if (
    !isPositiveFinite(input.measurement.viewportHeight) ||
    !isPositiveFinite(input.measurement.viewportWidth) ||
    input.measurement.viewportMeasuredForKey !== input.measurement.containerKey
  ) {
    return "waiting_for_measurable_viewport";
  }
  if (
    !isPositiveFinite(input.measurement.contentHeight) ||
    input.measurement.contentMeasuredForKey !== input.measurement.containerKey
  ) {
    return "waiting_for_measurable_content";
  }
  if (
    input.pendingVerification &&
    input.request &&
    input.pendingVerification.requestId === input.request.id
  ) {
    return "waiting_for_post_layout_verification";
  }
  return null;
}

function isPartialVirtualizedMeasurement(
  measurement: Pick<BottomAnchorMeasurementState, "containerKey">,
): boolean {
  return measurement.containerKey.includes("web-partial-virtualized");
}

function requiresPostLayoutMeasurementRevision(input: {
  measurement: BottomAnchorMeasurementState;
  measurementRevision: number;
  request: BottomAnchorRequest | null;
}): boolean {
  return (
    input.request?.source === "route" &&
    isPartialVirtualizedMeasurement(input.measurement) &&
    input.measurementRevision <= input.request.measurementRevisionAtCreated
  );
}

function shouldRetry(input: {
  mode: BottomAnchorMode;
  retries: number;
}): boolean {
  return (
    input.mode === "sticky_bottom" &&
    input.retries < BOTTOM_ANCHOR_MAX_VERIFICATION_RETRIES
  );
}

function shouldRestickOnViewportChange(input: {
  mode: BottomAnchorMode;
  previousViewportWidth: number;
  viewportWidth: number;
  previousViewportHeight: number;
  viewportHeight: number;
}): boolean {
  if (input.mode !== "sticky_bottom") return false;
  return (
    (isPositiveFinite(input.previousViewportHeight) &&
      isPositiveFinite(input.viewportHeight) &&
      input.previousViewportHeight !== input.viewportHeight) ||
    (isPositiveFinite(input.previousViewportWidth) &&
      isPositiveFinite(input.viewportWidth) &&
      input.previousViewportWidth !== input.viewportWidth)
  );
}

function shouldRestickOnContentChange(input: {
  mode: BottomAnchorMode;
  previousContentHeight: number;
  contentHeight: number;
}): boolean {
  return (
    input.mode === "sticky_bottom" &&
    isFiniteNumber(input.previousContentHeight) &&
    isFiniteNumber(input.contentHeight) &&
    input.contentHeight > input.previousContentHeight
  );
}

export function createBottomAnchorDriver(
  input: CreateBottomAnchorDriverInput,
): BottomAnchorDriver {
  let requestSequence = 0;
  let mode: BottomAnchorMode = "sticky_bottom";
  let pendingRequest: BottomAnchorRequest | null = null;
  let pendingVerification: BottomAnchorVerification | null = null;
  let blockedReason: BottomAnchorBlockedReason | null = null;
  let measurementRevision = 0;
  let lastVerifiedMeasurementRevision = 0;
  let lastFulfilledReason: BottomAnchorRequestReason | null = null;
  let detachReason: BottomAnchorDetachReason | null = null;
  let attemptHandle: unknown = null;
  let verificationHandle: unknown = null;
  let lastRouteRequestKey: string | null = null;

  const snapshot = (): BottomAnchorDriverSnapshot => ({
    mode,
    pendingRequest,
    pendingVerification,
    blockedReason,
    measurementRevision,
    lastVerifiedMeasurementRevision,
    lastFulfilledReason,
    detachReason,
  });

  const publish = () => {
    input.onSnapshotChange?.(snapshot());
  };

  const setBlockedReason = (next: BottomAnchorBlockedReason | null) => {
    if (blockedReason === next) return;
    blockedReason = next;
    publish();
  };

  const setMode = (nextMode: BottomAnchorMode, nextDetachReason: BottomAnchorDetachReason | null) => {
    if (mode === nextMode && detachReason === nextDetachReason) return;
    mode = nextMode;
    detachReason = nextDetachReason;
    if (nextMode === "detached") {
      lastVerifiedMeasurementRevision = measurementRevision;
    }
    publish();
  };

  const markMeasurementChanged = () => {
    measurementRevision += 1;
  };

  const markMeasurementVerified = () => {
    lastVerifiedMeasurementRevision = measurementRevision;
  };

  const cancelAttempt = () => {
    if (attemptHandle) {
      input.cancelFrame(attemptHandle);
      attemptHandle = null;
    }
    if (verificationHandle) {
      input.cancelFrame(verificationHandle);
      verificationHandle = null;
    }
    pendingVerification = null;
  };

  const cancelRequest = () => {
    pendingRequest = null;
    cancelAttempt();
    setBlockedReason(null);
  };

  const currentTransportBehavior = () =>
    input.getTransportBehavior?.() ?? DEFAULT_TRANSPORT_BEHAVIOR;

  const currentBlockedReason = () =>
    deriveBlockedReason({
      isAuthoritativeHistoryReady: input.getIsAuthoritativeHistoryReady(),
      measurement: input.getMeasurementState(),
      pendingVerification,
      request: pendingRequest,
    });

  const scheduleVerification = (
    verification: BottomAnchorVerification,
    delayFramesOverride?: number,
  ) => {
    if (verificationHandle) input.cancelFrame(verificationHandle);
    const behavior = currentTransportBehavior();
    verificationHandle = input.scheduleFrame({
      delayFrames: delayFramesOverride ?? behavior.verificationDelayFrames,
      callback: () => {
        verificationHandle = null;
        const verificationBlockedReason = deriveBlockedReason({
          isAuthoritativeHistoryReady: input.getIsAuthoritativeHistoryReady(),
          measurement: input.getMeasurementState(),
          pendingVerification: null,
          request: pendingRequest,
        });
        if (verificationBlockedReason) {
          pendingVerification = verification;
          setBlockedReason(verificationBlockedReason);
          return;
        }
        if (
          requiresPostLayoutMeasurementRevision({
            measurement: input.getMeasurementState(),
            measurementRevision,
            request: pendingRequest,
          })
        ) {
          pendingVerification = verification;
          setBlockedReason("waiting_for_post_layout_verification");
          return;
        }

        if (input.isNearBottom()) {
          pendingVerification = null;
          markMeasurementVerified();
          if (pendingRequest?.id === verification.requestId) {
            lastFulfilledReason = pendingRequest.reason;
            pendingRequest = null;
          } else {
            lastFulfilledReason = verification.reason;
          }
          setBlockedReason(null);
          publish();
          return;
        }

        if (!shouldRetry({ mode, retries: verification.retries })) {
          pendingVerification = null;
          setBlockedReason(null);
          return;
        }

        pendingVerification = {
          ...verification,
          retries: verification.retries + 1,
        };

        if (behavior.verificationRetryMode === "recheck") {
          setBlockedReason("waiting_for_post_layout_verification");
          scheduleVerification(pendingVerification);
          return;
        }

        runAttempt(false);
      },
    });
  };

  function runAttempt(animated: boolean) {
    const request = pendingRequest;
    const reason = request?.reason ?? pendingVerification?.reason ?? "content_mutated";
    pendingVerification = {
      requestId: request?.id ?? null,
      reason,
      retries: pendingVerification?.retries ?? 0,
    };
    input.scrollToBottom({ reason, animated });
    scheduleVerification(pendingVerification);
    setBlockedReason(currentBlockedReason());
  }

  const evaluate = (animated: boolean) => {
    if (attemptHandle) return;
    attemptHandle = input.scheduleFrame({
      callback: () => {
        attemptHandle = null;
        const nextBlockedReason = currentBlockedReason();
        setBlockedReason(nextBlockedReason);
        if (nextBlockedReason) return;
        if (pendingRequest || (mode === "sticky_bottom" && pendingVerification)) {
          runAttempt(animated);
        }
      },
    });
  };

  const createRequest = (
    request: BottomAnchorRouteRequestInput | BottomAnchorLocalRequestInput,
    source: BottomAnchorRequest["source"],
  ) => {
    cancelAttempt();
    requestSequence += 1;
    pendingRequest = {
      id: requestSequence,
      reason: request.reason,
      requestKey: request.requestKey,
      source,
      measurementRevisionAtCreated: measurementRevision,
    };
    pendingVerification = null;
    setMode("sticky_bottom", null);
    evaluate(request.reason === "jump_to_bottom");
    publish();
  };

  const createMaintenanceRequest = (reason: Extract<BottomAnchorRequestReason, "viewport_changed" | "content_mutated">) => {
    if (mode !== "sticky_bottom") return;
    if (!pendingRequest) {
      pendingVerification = {
        requestId: null,
        reason,
        retries: 0,
      };
      if (attemptHandle) {
        input.cancelFrame(attemptHandle);
        attemptHandle = null;
      }
      runAttempt(false);
      return;
    }
    evaluate(false);
  };

  const driver: BottomAnchorDriver = {
    getSnapshot: snapshot,
    reset(resetInput = {}) {
      lastRouteRequestKey = null;
      pendingRequest = null;
      pendingVerification = null;
      blockedReason = null;
      measurementRevision = 0;
      lastVerifiedMeasurementRevision = 0;
      lastFulfilledReason = null;
      cancelAttempt();
      mode = resetInput.mode ?? "sticky_bottom";
      detachReason = resetInput.detachReason ?? (mode === "detached" ? "route_restore" : null);
      publish();
    },
    destroy() {
      cancelAttempt();
    },
    applyRouteRequest(request) {
      if (!request) return;
      if (lastRouteRequestKey === request.requestKey) return;
      lastRouteRequestKey = request.requestKey;
      createRequest(request, "route");
    },
    requestLocalAnchor(request) {
      createRequest(request, "local");
    },
    detachByUser(reason = "user_scroll") {
      if (mode === "detached") return;
      cancelRequest();
      setMode("detached", reason);
    },
    handleViewportMetricsChange(change) {
      if (
        change.previousViewportWidth !== change.viewportWidth ||
        change.previousViewportHeight !== change.viewportHeight
      ) {
        markMeasurementChanged();
      }
      if (shouldRestickOnViewportChange({ mode, ...change })) {
        createMaintenanceRequest("viewport_changed");
        return;
      }
      if (pendingRequest) evaluate(false);
    },
    handleContentSizeChange(change) {
      if (change.previousContentHeight !== change.contentHeight) {
        markMeasurementChanged();
      }
      if (pendingRequest && pendingVerification) {
        scheduleVerification(pendingVerification, 0);
        setBlockedReason(currentBlockedReason());
        return;
      }
      if (shouldRestickOnContentChange({ mode, ...change })) {
        createMaintenanceRequest("content_mutated");
        return;
      }
      if (pendingRequest) evaluate(false);
    },
    prepareForStickyViewportChange() {
      if (mode !== "sticky_bottom") return;
      markMeasurementChanged();
      createMaintenanceRequest("viewport_changed");
    },
    prepareForStickyContentChange() {
      if (mode !== "sticky_bottom") return;
      markMeasurementChanged();
      createMaintenanceRequest("content_mutated");
    },
    handleScrollNearBottomChange(change) {
      if (change.nextIsNearBottom) {
        markMeasurementVerified();
      }
      if (mode === "detached" && isBottomAnchorMeasurementAtBottom(input.getMeasurementState())) {
        setMode("sticky_bottom", null);
        return;
      }

      const hasUnverifiedStickyMeasurementChange =
        measurementRevision !== lastVerifiedMeasurementRevision;
      const userScrolledAway =
        change.userIntent === "scroll_up" ||
        (hasUnverifiedStickyMeasurementChange &&
          Math.abs(change.scrollDelta) >= BOTTOM_ANCHOR_USER_SCROLL_AWAY_DELTA_PX);

      if (
        mode === "sticky_bottom" &&
        !change.nextIsNearBottom &&
        !pendingRequest &&
        !pendingVerification &&
        userScrolledAway
      ) {
        driver.detachByUser("user_scroll");
        return;
      }

      if (
        mode === "sticky_bottom" &&
        !change.nextIsNearBottom &&
        hasUnverifiedStickyMeasurementChange &&
        !pendingRequest &&
        !pendingVerification
      ) {
        pendingVerification = {
          requestId: null,
          reason: "content_mutated",
          retries: 0,
        };
        evaluate(false);
        return;
      }

      if (change.nextIsNearBottom && pendingRequest) {
        evaluate(false);
      }
    },
    notifyAuthoritativeHistoryMaybeChanged() {
      if (pendingRequest || pendingVerification) evaluate(false);
    },
    reevaluate(animated = false) {
      evaluate(animated);
    },
  };

  return driver;
}
