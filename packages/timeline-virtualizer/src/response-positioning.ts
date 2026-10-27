import {
  createInitialTurnFollowState,
  isViewportPreservingTurnFollowMode,
  normalizeFollowRestorePosition,
  reduceTurnFollowState,
  shouldFollowLatestTurn,
  type LatestTurnPhase,
  type TurnFollowEvent,
  type TurnFollowMode,
  type TurnFollowRestoreState,
  type TurnFollowState,
} from "./follow";
import {
  createTurnRestoreState,
  pendingTurnRestoreDistance,
  reduceTurnRestoreState,
  type TurnRestoreState,
} from "./restoration";
import { distanceExcludingBottomPadding } from "./scroll";

export interface TurnResponsePositioningControllerOptions {
  readonly distanceFromBottomPx: number;
  readonly isLatestTurnInProgress: boolean;
  readonly latestTurnPhase: LatestTurnPhase;
  readonly restoredLatestTurn?: TurnFollowRestoreState | null;
}

export interface TurnResponsePhaseTransition {
  readonly previousFollowMode: TurnFollowMode;
  readonly followState: TurnFollowState;
  /** Only the prework-follow to final-answer handoff owns an explicit bottom transfer. */
  readonly transferFollowToFinalAnswer: boolean;
  /** Diagnostic fact only; completion itself never grants scroll ownership. */
  readonly completed: boolean;
}

/**
 * Renderer-neutral owner of the two state machines that decide whether the
 * latest response or route restoration may write the viewport.
 *
 * Web and Native adapters retain platform geometry and animation mechanics,
 * but must go through this controller for follow/restore ownership. Keeping
 * the states together makes user takeover atomic: a gesture cannot leave a
 * stale restore task alive while independently changing follow mode.
 */
export class TurnResponsePositioningController {
  #followState: TurnFollowState;
  #restoreState: TurnRestoreState;

  constructor({
    distanceFromBottomPx,
    isLatestTurnInProgress,
    latestTurnPhase,
    restoredLatestTurn = null,
  }: TurnResponsePositioningControllerOptions) {
    this.#followState = createInitialTurnFollowState({
      distanceFromBottomPx,
      isLatestTurnInProgress,
      latestTurnPhase,
      restoredFollowMode: restoredLatestTurn?.followMode,
    });
    this.#restoreState = createTurnRestoreState(distanceFromBottomPx);
  }

  getFollowState(): TurnFollowState {
    return this.#followState;
  }

  getRestoreState(): TurnRestoreState {
    return this.#restoreState;
  }

  reduceFollow(event: TurnFollowEvent): TurnFollowState {
    this.#followState = reduceTurnFollowState(this.#followState, event);
    return this.#followState;
  }

  /**
   * Sole phase-transition authority shared by Web and Native. Completion is
   * reported as a fact, never translated into a bottom command. A caller may
   * continue following only when the already-existing follow mode owns it.
   */
  transitionLatestTurnPhase(
    previousLatestTurnPhase: LatestTurnPhase,
    latestTurnPhase: LatestTurnPhase,
  ): TurnResponsePhaseTransition {
    const previousFollowMode = this.#followState.followMode;
    this.#followState = reduceTurnFollowState(this.#followState, {
      type: "latest_turn_phase_changed",
      previousLatestTurnPhase,
      latestTurnPhase,
    });
    return {
      previousFollowMode,
      followState: this.#followState,
      transferFollowToFinalAnswer:
        previousLatestTurnPhase === "prework"
        && latestTurnPhase === "final_answer"
        && previousFollowMode === "prework_follow",
      completed:
        previousLatestTurnPhase !== "idle"
        && latestTurnPhase === "idle",
    };
  }

  ownsFollowPosition(latestTurnPhase: LatestTurnPhase): boolean {
    return shouldFollowLatestTurn(this.#followState, latestTurnPhase);
  }

  /** A target-positioning command intentionally returns ownership to static reading. */
  resetFollowToStatic(): TurnFollowState {
    this.#followState = { followMode: "static" };
    return this.#followState;
  }

  /**
   * A real user gesture permanently settles pending route restoration before
   * changing follow state. Later measurements may not steal the viewport back.
   */
  userTakeover(): void {
    this.#restoreState = reduceTurnRestoreState(
      this.#restoreState,
      { type: "user_takeover" },
    ).state;
  }

  settleRestoreForFollowMode(): void {
    this.#restoreState = reduceTurnRestoreState(
      this.#restoreState,
      { type: "follow_mode_owned" },
    ).state;
  }

  adjustPendingRestoreForHeightDelta(heightDeltaPx: number): void {
    this.#restoreState = reduceTurnRestoreState(
      this.#restoreState,
      { type: "height_delta_below_viewport", heightDeltaPx },
    ).state;
  }

  attemptRestore(
    observedDistanceFromBottomPx: number,
    tolerancePx?: number,
  ): number | null {
    const transition = reduceTurnRestoreState(this.#restoreState, {
      type: "attempt",
      observedDistanceFromBottomPx,
      ...(tolerancePx === undefined ? {} : { tolerancePx }),
    });
    this.#restoreState = transition.state;
    return transition.scrollToDistanceFromBottomPx;
  }

  getPendingRestoreDistanceFromBottomPx(bottomPaddingPx = 0): number | null {
    if (this.#followState.followMode === "prework_follow") return null;
    const distance = pendingTurnRestoreDistance(this.#restoreState);
    return distance === null
      ? null
      : distanceExcludingBottomPadding(distance, bottomPaddingPx);
  }

  isRestorePending(): boolean {
    return this.#restoreState.phase === "pending";
  }

  shouldPreserveMeasuredViewport(): boolean {
    return isViewportPreservingTurnFollowMode(this.#followState.followMode);
  }

  captureRestorePosition({
    distanceFromBottomPx,
    latestTurnPhase,
    responseSpacerHeightPx,
    scrollPaddingBottomPx,
  }: {
    readonly distanceFromBottomPx: number;
    readonly latestTurnPhase: LatestTurnPhase;
    readonly responseSpacerHeightPx: number;
    readonly scrollPaddingBottomPx: number;
  }): { readonly distanceFromBottomPx: number; readonly scrollState: TurnFollowState } {
    // response spacer changes the checkpoint that will be restored later; it
    // must never grant follow ownership to the currently mounted viewport.
    // In particular, API cleanup can capture a checkpoint at the
    // prework -> final-answer render boundary. Mutating live state here would
    // turn prework_watch into prework_follow and make that boundary clear the
    // spacer/scroll to bottom even though no user or content overflow asked
    // for follow mode.
    return normalizeFollowRestorePosition({
      distanceFromBottomPx,
      latestTurnPhase,
      responseSpacerHeightPx,
      scrollPaddingBottomPx,
      scrollState: this.#followState,
    });
  }
}
