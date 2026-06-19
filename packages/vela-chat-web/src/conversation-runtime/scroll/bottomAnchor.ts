export const NEAR_BOTTOM_THRESHOLD_PX = 180;
export const AT_BOTTOM_THRESHOLD_PX = 1;
export const USER_SCROLL_DELTA_EPSILON = 1;

export interface BottomAnchorFollowInput {
  clientHeight: number;
  followOutput: boolean;
  pendingUserScrollUpIntent?: boolean;
  previousScrollTop: number;
  scrollHeight: number;
  scrollTop: number;
  userScrollActive: boolean;
}

export interface BottomAnchorFollowState {
  distanceFromBottom: number;
  followOutput: boolean;
  isAtBottom: boolean;
  isNearBottom: boolean;
  pendingUserScrollUpIntent: boolean;
}

export interface BottomAnchorContentSizeChangeInput {
  contentHeight: number;
  followOutput: boolean;
  previousContentHeight: number;
}

export interface BottomAnchorViewportSizeChangeInput {
  followOutput: boolean;
  previousViewportHeight: number;
  previousViewportWidth: number;
  viewportHeight: number;
  viewportWidth: number;
}

export interface BottomAnchorUserScrollIntentInput {
  scrollUpIntent: boolean;
}

export interface BottomAnchorSettleRetryInput {
  clientHeight: number;
  followOutput: boolean;
  scrollHeight: number;
  scrollTop: number;
}

export type BottomAnchorRouteBlockedReason =
  | "missing_route_request"
  | "waiting_for_history_readiness"
  | "waiting_for_measurable_viewport"
  | "waiting_for_measurable_content"
  | "waiting_for_post_layout_verification";

export interface BottomAnchorRouteReadinessInput {
  contentHeight: number;
  isHistoryReady: boolean;
  pendingVerification: boolean;
  requestKey?: string | null;
  viewportHeight: number;
  viewportWidth: number;
}

export interface BottomAnchorRouteReadiness {
  blockedReason: BottomAnchorRouteBlockedReason | null;
  canAttempt: boolean;
}

export function deriveBottomAnchorFollowState({
  clientHeight,
  followOutput,
  pendingUserScrollUpIntent = false,
  previousScrollTop,
  scrollHeight,
  scrollTop,
  userScrollActive,
}: BottomAnchorFollowInput): BottomAnchorFollowState {
  const distanceFromBottom = scrollHeight - clientHeight - scrollTop;
  if (
    ![
      clientHeight,
      distanceFromBottom,
      previousScrollTop,
      scrollHeight,
      scrollTop,
    ].every(Number.isFinite)
  ) {
    return {
      distanceFromBottom: 0,
      followOutput: true,
      isAtBottom: true,
      isNearBottom: true,
      pendingUserScrollUpIntent: false,
    };
  }

  const isAtBottom = distanceFromBottom <= AT_BOTTOM_THRESHOLD_PX;
  const isNearBottom = distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_PX;
  const scrolledUp =
    scrollTop < previousScrollTop - USER_SCROLL_DELTA_EPSILON;

  if (!followOutput) {
    return {
      distanceFromBottom,
      followOutput: isAtBottom,
      isAtBottom,
      isNearBottom,
      pendingUserScrollUpIntent: false,
    };
  }

  if (isAtBottom) {
    return {
      distanceFromBottom,
      followOutput: true,
      isAtBottom,
      isNearBottom,
      pendingUserScrollUpIntent: false,
    };
  }

  const userMovedAway = (pendingUserScrollUpIntent || userScrollActive) && scrolledUp;
  return {
    distanceFromBottom,
    followOutput: !userMovedAway,
    isAtBottom,
    isNearBottom,
    pendingUserScrollUpIntent: pendingUserScrollUpIntent && !userMovedAway,
  };
}

export function shouldRestickOnContentSizeChange({
  contentHeight,
  followOutput,
  previousContentHeight,
}: BottomAnchorContentSizeChangeInput): boolean {
  if (!followOutput) return false;
  if (![contentHeight, previousContentHeight].every(Number.isFinite)) {
    return false;
  }

  return contentHeight > previousContentHeight;
}

export function shouldRestickOnViewportSizeChange({
  followOutput,
  previousViewportHeight,
  previousViewportWidth,
  viewportHeight,
  viewportWidth,
}: BottomAnchorViewportSizeChangeInput): boolean {
  if (!followOutput) return false;
  if (
    ![
      previousViewportHeight,
      previousViewportWidth,
      viewportHeight,
      viewportWidth,
    ].every((value) => Number.isFinite(value) && value > 0)
  ) {
    return false;
  }

  return (
    previousViewportHeight !== viewportHeight ||
    previousViewportWidth !== viewportWidth
  );
}

export function shouldCancelPendingStickForUserScrollIntent({
  scrollUpIntent,
}: BottomAnchorUserScrollIntentInput): boolean {
  return scrollUpIntent;
}

export function shouldRetryBottomStickAfterSettle({
  clientHeight,
  followOutput,
  scrollHeight,
  scrollTop,
}: BottomAnchorSettleRetryInput): boolean {
  if (!followOutput) return false;
  if (![clientHeight, scrollHeight, scrollTop].every(Number.isFinite)) {
    return false;
  }

  const distanceFromBottom = scrollHeight - clientHeight - scrollTop;
  return distanceFromBottom > NEAR_BOTTOM_THRESHOLD_PX;
}

export function deriveBottomAnchorRouteReadiness({
  contentHeight,
  isHistoryReady,
  pendingVerification,
  requestKey,
  viewportHeight,
  viewportWidth,
}: BottomAnchorRouteReadinessInput): BottomAnchorRouteReadiness {
  if (!requestKey) {
    return { blockedReason: "missing_route_request", canAttempt: false };
  }
  if (!isHistoryReady) {
    return {
      blockedReason: "waiting_for_history_readiness",
      canAttempt: false,
    };
  }
  if (
    ![viewportHeight, viewportWidth].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  ) {
    return {
      blockedReason: "waiting_for_measurable_viewport",
      canAttempt: false,
    };
  }
  if (!Number.isFinite(contentHeight) || contentHeight <= 0) {
    return {
      blockedReason: "waiting_for_measurable_content",
      canAttempt: false,
    };
  }
  if (pendingVerification) {
    return {
      blockedReason: "waiting_for_post_layout_verification",
      canAttempt: false,
    };
  }

  return { blockedReason: null, canAttempt: true };
}
