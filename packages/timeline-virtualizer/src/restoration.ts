export type TurnRestoreCompletionReason =
  | "already-positioned"
  | "follow-mode-owned"
  | "no-target"
  | "user-takeover";

export type TurnRestoreState =
  | {
      readonly phase: "pending";
      readonly distanceFromBottomPx: number;
      readonly attempts: number;
    }
  | {
      readonly phase: "settled";
      readonly reason: TurnRestoreCompletionReason;
    };

export type TurnRestoreEvent =
  | { readonly type: "attempt"; readonly observedDistanceFromBottomPx: number; readonly tolerancePx?: number }
  | { readonly type: "height_delta_below_viewport"; readonly heightDeltaPx: number }
  | { readonly type: "follow_mode_owned" }
  | { readonly type: "user_takeover" };

export interface TurnRestoreTransition {
  readonly state: TurnRestoreState;
  readonly scrollToDistanceFromBottomPx: number | null;
}

function finiteDistance(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function createTurnRestoreState(
  distanceFromBottomPx: number | null | undefined,
): TurnRestoreState {
  return distanceFromBottomPx === null || distanceFromBottomPx === undefined
    ? { phase: "settled", reason: "no-target" }
    : { phase: "pending", distanceFromBottomPx: finiteDistance(distanceFromBottomPx), attempts: 0 };
}

/**
 * Pure route-restoration reducer. Measurements may move the target while it
 * is pending; user input and follow-mode ownership permanently settle it so a
 * later layout effect cannot steal the viewport back.
 */
export function reduceTurnRestoreState(
  current: TurnRestoreState,
  event: TurnRestoreEvent,
): TurnRestoreTransition {
  if (current.phase === "settled") return { state: current, scrollToDistanceFromBottomPx: null };

  switch (event.type) {
    case "follow_mode_owned":
      return {
        state: { phase: "settled", reason: "follow-mode-owned" },
        scrollToDistanceFromBottomPx: null,
      };
    case "user_takeover":
      return {
        state: { phase: "settled", reason: "user-takeover" },
        scrollToDistanceFromBottomPx: null,
      };
    case "height_delta_below_viewport":
      return {
        state: {
          ...current,
          distanceFromBottomPx: finiteDistance(current.distanceFromBottomPx + event.heightDeltaPx),
        },
        scrollToDistanceFromBottomPx: null,
      };
    case "attempt": {
      const tolerance = Math.max(0, event.tolerancePx ?? 24);
      if (Math.abs(finiteDistance(event.observedDistanceFromBottomPx) - current.distanceFromBottomPx) <= tolerance) {
        return {
          state: { phase: "settled", reason: "already-positioned" },
          scrollToDistanceFromBottomPx: null,
        };
      }
      return {
        state: { ...current, attempts: current.attempts + 1 },
        scrollToDistanceFromBottomPx: current.distanceFromBottomPx,
      };
    }
  }
}

export function pendingTurnRestoreDistance(state: TurnRestoreState): number | null {
  return state.phase === "pending" ? state.distanceFromBottomPx : null;
}
