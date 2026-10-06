/**
 * Renderer-neutral restoration of the latest-Turn follow state machine owned
 * by Codex Desktop's LocalConversationThread. Platform adapters execute the
 * resulting scroll decisions; they do not maintain a second follow policy.
 */

export const CODEX_FOLLOW_DISTANCE_THRESHOLD_PX = 24;
export const CODEX_LATEST_TURN_PLACEMENT_THRESHOLD_PX = 300;
export const CODEX_RESPONSE_SPACER_VIEWPORT_RATIO = 2 / 3;
export const CODEX_RESPONSE_SPACER_MIN_CONTENT_HEIGHT_PX = 240;

/**
 * Codex latest-Turn placement uses a 500ms, zero-bounce duration spring.
 * React Native cannot express duration springs directly, so the equivalent
 * unit-mass critical-damping coefficients are published with the semantics.
 */
export const CODEX_LATEST_TURN_PLACEMENT_SPRING = Object.freeze({
  bounce: 0,
  durationMs: 500,
  damping: 36.933653905806345,
  mass: 1,
  stiffness: 341.02369770847105,
});

export type LatestTurnPhase = "idle" | "prework" | "final_answer";
export type TurnFollowMode = "static" | "response_watch" | "prework_watch" | "prework_follow" | "user_follow";

export interface TurnFollowState {
  readonly followMode: TurnFollowMode;
}

export type TurnFollowEvent =
  | {
      readonly type: "latest_turn_follow_content_changed";
      readonly latestTurnPhase: LatestTurnPhase;
      readonly followContentOverflowPx: number;
    }
  | {
      readonly type: "latest_turn_phase_changed";
      readonly previousLatestTurnPhase: LatestTurnPhase;
      readonly latestTurnPhase: LatestTurnPhase;
    }
  | { readonly type: "latest_turn_placed"; readonly watchForOverflow?: boolean }
  | { readonly type: "latest_turn_removed" }
  | {
      readonly type: "scroll_distance_changed";
      readonly distanceFromBottomPx: number;
      readonly latestTurnPhase: LatestTurnPhase;
    }
  | {
      readonly type: "scroll_to_bottom";
      readonly latestTurnPhase: LatestTurnPhase;
    };

export interface LatestTurnPlacementSnapshot {
  readonly distanceFromBottomPx: number;
  readonly scrollHeightPx: number;
  readonly shouldPlaceLatestTurn: boolean;
}

export interface TurnFollowRestoreState {
  readonly turnKey: string;
  readonly isLatestTurnInProgress: boolean;
  readonly latestTurnPhase: LatestTurnPhase;
  readonly followMode: TurnFollowMode;
  readonly latestTurnHeightPx: number | null;
  readonly latestTurnFollowContentHeightPx: number | null;
}

function withFollowMode(state: TurnFollowState, followMode: TurnFollowMode): TurnFollowState {
  return state.followMode === followMode ? state : { ...state, followMode };
}

export function createTurnFollowState(followMode: TurnFollowMode = "static"): TurnFollowState {
  return { followMode };
}

export function createInitialTurnFollowState({
  distanceFromBottomPx,
  isLatestTurnInProgress,
  latestTurnPhase,
  restoredFollowMode,
}: {
  readonly distanceFromBottomPx: number;
  readonly isLatestTurnInProgress: boolean;
  readonly latestTurnPhase: LatestTurnPhase;
  readonly restoredFollowMode?: TurnFollowMode | null;
}): TurnFollowState {
  if (isLatestTurnInProgress && distanceFromBottomPx <= CODEX_FOLLOW_DISTANCE_THRESHOLD_PX) {
    return createTurnFollowState(latestTurnPhase === "prework" ? "prework_follow" : "user_follow");
  }
  // A local submit watch cannot take ownership after a route restore away
  // from the bottom; only the live submission is allowed to create it.
  return createTurnFollowState(restoredFollowMode === "response_watch" ? "static" : restoredFollowMode ?? "static");
}

/** Exact typed form of the recovered Codex OD reducer. */
export function reduceTurnFollowState(
  state: TurnFollowState,
  event: TurnFollowEvent,
): TurnFollowState {
  switch (event.type) {
    case "latest_turn_follow_content_changed":
      if (state.followMode === "response_watch"
        && event.latestTurnPhase !== "idle"
        && event.followContentOverflowPx > 0) {
        return withFollowMode(
          state,
          event.latestTurnPhase === "prework" ? "prework_follow" : "user_follow",
        );
      }
      return event.latestTurnPhase === "prework"
        && state.followMode === "prework_watch"
        && event.followContentOverflowPx > 0
        ? withFollowMode(state, "prework_follow")
        : state;

    case "latest_turn_phase_changed": {
      let next = state;
      if (event.previousLatestTurnPhase !== "prework" && event.latestTurnPhase === "prework") {
        if (next.followMode === "static") next = withFollowMode(next, "prework_watch");
        if (next.followMode === "user_follow") next = withFollowMode(next, "prework_follow");
      }
      if (event.previousLatestTurnPhase === "prework" && event.latestTurnPhase === "final_answer") {
        next = withFollowMode(next,
          next.followMode === "prework_follow" ? "user_follow"
            : next.followMode === "response_watch" ? "response_watch" : "static");
      }
      if (
        event.previousLatestTurnPhase !== "idle"
        && event.latestTurnPhase === "idle"
        && next.followMode !== "user_follow"
      ) {
        next = withFollowMode(next, "static");
      }
      return next;
    }

    case "latest_turn_placed":
      return withFollowMode(state, event.watchForOverflow ? "response_watch" : "static");
    case "latest_turn_removed":
      return withFollowMode(state, "static");

    case "scroll_distance_changed":
      if (event.distanceFromBottomPx <= CODEX_FOLLOW_DISTANCE_THRESHOLD_PX) return state;
      if (state.followMode === "response_watch") return withFollowMode(state, "static");
      if (state.followMode === "prework_follow") return withFollowMode(state, "prework_watch");
      if (state.followMode === "user_follow") {
        return withFollowMode(
          state,
          event.latestTurnPhase === "prework" ? "prework_watch" : "static",
        );
      }
      return state;

    case "scroll_to_bottom":
      return withFollowMode(
        state,
        event.latestTurnPhase === "prework" ? "prework_follow" : "user_follow",
      );
  }
}

/** Preserve the reading viewport until the response actually reaches its edge. */
export function isViewportPreservingTurnFollowMode(followMode: TurnFollowMode): boolean {
  return followMode === "static" || followMode === "response_watch" || followMode === "prework_watch";
}

export function shouldFollowLatestTurn(
  state: TurnFollowState,
  latestTurnPhase: LatestTurnPhase,
): boolean {
  return state.followMode === "user_follow"
    || (state.followMode === "prework_follow" && latestTurnPhase === "prework");
}

/** Exact typed form of the pending latest-Turn placement snapshot (recovered SD). */
export function createLatestTurnPlacementSnapshot({
  distanceFromBottomPx,
  responseSpacerHeightPx,
  scrollHeightPx,
}: {
  readonly distanceFromBottomPx: number;
  readonly responseSpacerHeightPx: number;
  readonly scrollHeightPx: number;
}): LatestTurnPlacementSnapshot {
  return {
    distanceFromBottomPx,
    scrollHeightPx,
    shouldPlaceLatestTurn:
      distanceFromBottomPx - responseSpacerHeightPx <= CODEX_LATEST_TURN_PLACEMENT_THRESHOLD_PX,
  };
}

/**
 * A latest Turn is placed only when the composer explicitly prepared a
 * submit snapshot. Resume, pagination and replica hydration also change the
 * latest Turn key, but must retain the restored viewport instead of behaving
 * like a local submission.
 */
export function shouldPlaceLatestTurnFromPendingSubmit(
  placement: LatestTurnPlacementSnapshot | null,
): boolean {
  return placement?.shouldPlaceLatestTurn === true;
}

/** Preserve the reading position when an unplaced submit changes content height. */
export function distanceAfterUnplacedLatestTurnContentResize({
  nextScrollHeightPx,
  placement,
}: {
  readonly nextScrollHeightPx: number;
  readonly placement: LatestTurnPlacementSnapshot;
}): number {
  return placement.distanceFromBottomPx
    + nextScrollHeightPx
    - placement.scrollHeightPx;
}

/** Exact typed form of the recovered response-spacer height clamp (recovered dO). */
export function maximumResponseSpacerHeightPx({
  scrollElementHeightPx,
  scrollPaddingBottomPx,
}: {
  readonly scrollElementHeightPx: number;
  readonly scrollPaddingBottomPx: number;
}): number {
  const available = Math.max(0, scrollElementHeightPx - scrollPaddingBottomPx);
  return Math.max(
    0,
    Math.min(
      available * CODEX_RESPONSE_SPACER_VIEWPORT_RATIO,
      available - CODEX_RESPONSE_SPACER_MIN_CONTENT_HEIGHT_PX,
    ),
  );
}

/** Remaining response spacer below the current viewport position (recovered pO). */
export function responseSpacerOverflowPx({
  distanceFromBottomPx,
  responseSpacerHeightPx,
  scrollPaddingBottomPx,
}: {
  readonly distanceFromBottomPx: number;
  readonly responseSpacerHeightPx: number;
  readonly scrollPaddingBottomPx: number;
}): number {
  return Math.max(0, responseSpacerHeightPx - distanceFromBottomPx - scrollPaddingBottomPx);
}

/** Recovered fO decision used before persisting/restoring a conversation viewport. */
export function normalizeFollowRestorePosition({
  distanceFromBottomPx,
  latestTurnPhase,
  responseSpacerHeightPx,
  scrollPaddingBottomPx,
  scrollState,
}: {
  readonly distanceFromBottomPx: number;
  readonly latestTurnPhase: LatestTurnPhase;
  readonly responseSpacerHeightPx: number;
  readonly scrollPaddingBottomPx: number;
  readonly scrollState: TurnFollowState;
}): { readonly distanceFromBottomPx: number; readonly scrollState: TurnFollowState } {
  if (responseSpacerOverflowPx({
    distanceFromBottomPx,
    responseSpacerHeightPx,
    scrollPaddingBottomPx,
  }) > CODEX_FOLLOW_DISTANCE_THRESHOLD_PX) {
    return {
      distanceFromBottomPx: 0,
      scrollState: reduceTurnFollowState(scrollState, {
        type: "scroll_to_bottom",
        latestTurnPhase,
      }),
    };
  }
  return {
    distanceFromBottomPx: Math.max(0, distanceFromBottomPx - responseSpacerHeightPx),
    scrollState,
  };
}
