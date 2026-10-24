

export const OPENCRAFT_FOLLOW_DISTANCE_THRESHOLD_PX = 24;
export const OPENCRAFT_LATEST_TURN_PLACEMENT_THRESHOLD_PX = 300;
export const OPENCRAFT_RESPONSE_SPACER_VIEWPORT_RATIO = 2 / 3;
export const OPENCRAFT_RESPONSE_SPACER_MIN_CONTENT_HEIGHT_PX = 240;
export const OPENCRAFT_LATEST_TURN_PLACEMENT_SPRING = Object.freeze({
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

/** Follow ownership for one mounted conversation, shared by every renderer. */
function activeFollowMode(phase: LatestTurnPhase): TurnFollowMode {
  return phase === "prework" ? "prework_follow" : "user_follow";
}

function setMode(state: TurnFollowState, mode: TurnFollowMode): TurnFollowState {
  if (state.followMode === mode) return state;
  return { ...state, followMode: mode };
}

export function createTurnFollowState(followMode: TurnFollowMode = "static"): TurnFollowState {
  return { followMode };
}

export function createInitialTurnFollowState(options: {
  readonly distanceFromBottomPx: number;
  readonly isLatestTurnInProgress: boolean;
  readonly latestTurnPhase: LatestTurnPhase;
  readonly restoredFollowMode?: TurnFollowMode | null;
}): TurnFollowState {
  const saved = options.restoredFollowMode;
  const initial = saved == null || saved === "response_watch" ? "static" : saved;
  const atBottom = options.distanceFromBottomPx <= OPENCRAFT_FOLLOW_DISTANCE_THRESHOLD_PX;
  return createTurnFollowState(options.isLatestTurnInProgress && atBottom
    ? activeFollowMode(options.latestTurnPhase)
    : initial);
}

export function reduceTurnFollowState(state: TurnFollowState, event: TurnFollowEvent): TurnFollowState {
  let mode = state.followMode;
  switch (event.type) {
    case "latest_turn_removed":
      mode = "static";
      break;
    case "latest_turn_placed":
      mode = event.watchForOverflow === true ? "response_watch" : "static";
      break;
    case "scroll_to_bottom":
      mode = activeFollowMode(event.latestTurnPhase);
      break;
    case "scroll_distance_changed":
      // Compare the attached side directly: NaN is not an attached distance.
      if (event.distanceFromBottomPx <= OPENCRAFT_FOLLOW_DISTANCE_THRESHOLD_PX) break;
      if (mode === "prework_follow" || (mode === "user_follow" && event.latestTurnPhase === "prework")) mode = "prework_watch";
      else if (mode === "user_follow" || mode === "response_watch") mode = "static";
      break;
    case "latest_turn_follow_content_changed":
      if (!(event.followContentOverflowPx > 0)) break;
      if (mode === "response_watch" && event.latestTurnPhase !== "idle") mode = activeFollowMode(event.latestTurnPhase);
      else if (mode === "prework_watch" && event.latestTurnPhase === "prework") mode = "prework_follow";
      break;
    case "latest_turn_phase_changed": {
      const previous = event.previousLatestTurnPhase;
      const phase = event.latestTurnPhase;
      if (previous === phase) break;
      if (phase === "idle") {
        if (mode !== "user_follow") mode = "static";
      } else if (phase === "prework") {
        if (mode === "static") mode = "prework_watch";
        else if (mode === "user_follow") mode = "prework_follow";
      } else if (previous === "prework") {
        if (mode === "prework_follow") mode = "user_follow";
        else if (mode === "prework_watch" || mode === "user_follow") mode = "static";
      }
      break;
    }
  }
  return setMode(state, mode);
}

export function isViewportPreservingTurnFollowMode(followMode: TurnFollowMode): boolean {
  return followMode === "static" || followMode === "response_watch" || followMode === "prework_watch";
}

export function shouldFollowLatestTurn(state: TurnFollowState, latestTurnPhase: LatestTurnPhase): boolean {
  return state.followMode === "user_follow"
    || (state.followMode === "prework_follow" && latestTurnPhase === "prework");
}

export function createLatestTurnPlacementSnapshot(input: {
  readonly distanceFromBottomPx: number;
  readonly responseSpacerHeightPx: number;
  readonly scrollHeightPx: number;
}): LatestTurnPlacementSnapshot {
  return {
    distanceFromBottomPx: input.distanceFromBottomPx,
    scrollHeightPx: input.scrollHeightPx,
    shouldPlaceLatestTurn: input.distanceFromBottomPx - input.responseSpacerHeightPx <= OPENCRAFT_LATEST_TURN_PLACEMENT_THRESHOLD_PX,
  };
}

export function shouldPlaceLatestTurnFromPendingSubmit(placement: LatestTurnPlacementSnapshot | null): boolean {
  return placement?.shouldPlaceLatestTurn === true;
}

export function distanceAfterUnplacedLatestTurnContentResize(input: {
  readonly nextScrollHeightPx: number;
  readonly placement: LatestTurnPlacementSnapshot;
}): number {
  return input.placement.distanceFromBottomPx + (input.nextScrollHeightPx - input.placement.scrollHeightPx);
}

export function maximumResponseSpacerHeightPx(input: {
  readonly scrollElementHeightPx: number;
  readonly scrollPaddingBottomPx: number;
}): number {
  const available = input.scrollElementHeightPx - input.scrollPaddingBottomPx;
  return Math.max(0, Math.min(
    available * OPENCRAFT_RESPONSE_SPACER_VIEWPORT_RATIO,
    available - OPENCRAFT_RESPONSE_SPACER_MIN_CONTENT_HEIGHT_PX,
  ));
}

export function responseSpacerOverflowPx(input: {
  readonly distanceFromBottomPx: number;
  readonly responseSpacerHeightPx: number;
  readonly scrollPaddingBottomPx: number;
}): number {
  return Math.max(0, input.responseSpacerHeightPx - input.distanceFromBottomPx - input.scrollPaddingBottomPx);
}

export function normalizeFollowRestorePosition(input: {
  readonly distanceFromBottomPx: number;
  readonly latestTurnPhase: LatestTurnPhase;
  readonly responseSpacerHeightPx: number;
  readonly scrollPaddingBottomPx: number;
  readonly scrollState: TurnFollowState;
}): { readonly distanceFromBottomPx: number; readonly scrollState: TurnFollowState } {
  // This is a checkpoint projection; changing its saved mode never changes the
  // live state retained by the response-positioning controller.
  const insideSpacer = responseSpacerOverflowPx(input) > OPENCRAFT_FOLLOW_DISTANCE_THRESHOLD_PX;
  return {
    distanceFromBottomPx: insideSpacer ? 0 : Math.max(0, input.distanceFromBottomPx - input.responseSpacerHeightPx),
    scrollState: insideSpacer ? setMode(input.scrollState, activeFollowMode(input.latestTurnPhase)) : input.scrollState,
  };
}
