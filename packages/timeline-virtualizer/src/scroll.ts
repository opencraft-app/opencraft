import type { TurnScrollOrigin } from "./ports";

export const OPENCRAFT_SCROLL_NEAR_BOTTOM_PX = 24;
export const OPENCRAFT_SCROLL_TOP_LOAD_THRESHOLD_PX = 64;
export const OPENCRAFT_SCROLL_TO_BOTTOM_DURATION_MS = 260;
export const OPENCRAFT_SCROLL_DIRECTION_TIMEOUT_MS = 1_000;
export const OPENCRAFT_TOUCH_DIRECTION_THRESHOLD_PX = 8;
export const OPENCRAFT_WHEEL_LINE_HEIGHT_PX = 16;
export const OPENCRAFT_FOOTER_GAP_PX = 16;

export type TurnUserScrollDirection = "away" | "toward";
export type WheelDeltaMode = 0 | 1 | 2;

export interface PreservedScrollLayout {
  readonly distanceFromBottomPx: number;
  readonly scrollHeightPx: number;
  readonly wheelDistanceFromBottomPx: number;
}

export interface ScrollDirectionSample {
  readonly direction: TurnUserScrollDirection;
  readonly lastAtMs: number;
}

export function clampScrollDistance(distanceFromBottomPx: number): number {
  return Number.isFinite(distanceFromBottomPx) ? Math.max(0, distanceFromBottomPx) : 0;
}

/** Near-bottom snapshots resume at exact bottom. */
export function normalizeInitialScrollDistance(distanceFromBottomPx: number | null | undefined): number {
  const distance = clampScrollDistance(distanceFromBottomPx ?? 0);
  return distance > OPENCRAFT_SCROLL_NEAR_BOTTOM_PX ? distance : 0;
}

export function isScrolledFromBottom(distanceFromBottomPx: number): boolean {
  return clampScrollDistance(distanceFromBottomPx) > OPENCRAFT_SCROLL_NEAR_BOTTOM_PX;
}

/** Virtualizer distance excludes the sticky footer/response bottom padding. */
export function distanceExcludingBottomPadding(
  distanceFromBottomPx: number,
  bottomPaddingPx: number,
): number {
  return Math.max(0, clampScrollDistance(distanceFromBottomPx) - clampScrollDistance(bottomPaddingPx));
}

/** With bottom padding, only literal zero counts as bottom. */
export function isAtVirtualizedBottom(
  distanceFromBottomPx: number,
  bottomPaddingPx: number,
): boolean {
  return clampScrollDistance(distanceFromBottomPx)
    <= (clampScrollDistance(bottomPaddingPx) > 0 ? 0 : OPENCRAFT_SCROLL_NEAR_BOTTOM_PX);
}

export function distanceFromTopPx({
  contentHeightPx,
  distanceFromBottomPx,
  viewportHeightPx,
}: {
  readonly contentHeightPx: number;
  readonly distanceFromBottomPx: number;
  readonly viewportHeightPx: number;
}): number {
  return Math.max(
    0,
    clampScrollDistance(contentHeightPx)
      - clampScrollDistance(viewportHeightPx)
      - clampScrollDistance(distanceFromBottomPx),
  );
}

export function shouldLoadOlderHistory(metrics: {
  readonly contentHeightPx: number;
  readonly distanceFromBottomPx: number;
  readonly viewportHeightPx: number;
}): boolean {
  return distanceFromTopPx(metrics) <= OPENCRAFT_SCROLL_TOP_LOAD_THRESHOLD_PX;
}

export function normalizeWheelDeltaPx(
  deltaY: number,
  deltaMode: WheelDeltaMode,
  viewportHeightPx: number,
): number {
  if (!Number.isFinite(deltaY)) return 0;
  if (deltaMode === 1) return deltaY * OPENCRAFT_WHEEL_LINE_HEIGHT_PX;
  if (deltaMode === 2) return deltaY * clampScrollDistance(viewportHeightPx);
  return deltaY;
}

export function directionForWheelDelta(deltaPx: number): TurnUserScrollDirection | null {
  return deltaPx === 0 ? null : deltaPx < 0 ? "away" : "toward";
}

export function directionForDistanceChange(
  previousDistanceFromBottomPx: number,
  nextDistanceFromBottomPx: number,
): TurnUserScrollDirection | null {
  const previous = clampScrollDistance(previousDistanceFromBottomPx);
  const next = clampScrollDistance(nextDistanceFromBottomPx);
  return next > previous ? "away" : next < previous ? "toward" : null;
}

export function keyboardScrollDirection({
  defaultPrevented,
  key,
  repeat,
  shiftKey,
}: {
  readonly defaultPrevented: boolean;
  readonly key: string;
  readonly repeat: boolean;
  readonly shiftKey: boolean;
}): TurnUserScrollDirection | null {
  if (defaultPrevented || repeat) return null;
  switch (key) {
    case "ArrowUp":
    case "Home":
    case "PageUp":
      return "away";
    case " ":
    case "Spacebar":
      return shiftKey ? "away" : "toward";
    case "ArrowDown":
    case "End":
    case "PageDown":
      return "toward";
    default:
      return null;
  }
}

export function directionForTouchDelta(
  deltaX: number,
  deltaY: number,
): TurnUserScrollDirection | null {
  if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < OPENCRAFT_TOUCH_DIRECTION_THRESHOLD_PX) return null;
  if (Math.abs(deltaY) <= Math.abs(deltaX)) return null;
  return deltaY > 0 ? "away" : "toward";
}

export function isDirectionSampleActive(sample: ScrollDirectionSample, nowMs: number): boolean {
  return nowMs - sample.lastAtMs <= OPENCRAFT_SCROLL_DIRECTION_TIMEOUT_MS;
}

export function scrollToBottomDistanceAtTime(
  initialDistanceFromBottomPx: number,
  elapsedMs: number,
): number {
  const progress = Math.min(1, Math.max(0, elapsedMs) / OPENCRAFT_SCROLL_TO_BOTTOM_DURATION_MS);
  const eased = 1 - (1 - progress) ** 3;
  return clampScrollDistance(initialDistanceFromBottomPx) * (1 - eased);
}

export function createPreservedScrollLayout(
  distanceFromBottomPx: number,
  scrollHeightPx: number,
): PreservedScrollLayout {
  return {
    distanceFromBottomPx: clampScrollDistance(distanceFromBottomPx),
    scrollHeightPx: clampScrollDistance(scrollHeightPx),
    wheelDistanceFromBottomPx: 0,
  };
}

export function accumulatePreservedWheelDelta(
  snapshot: PreservedScrollLayout,
  wheelDeltaPx: number,
): PreservedScrollLayout {
  return {
    ...snapshot,
    wheelDistanceFromBottomPx: snapshot.wheelDistanceFromBottomPx - wheelDeltaPx,
  };
}

export function restoredDistanceAfterLayout(
  snapshot: PreservedScrollLayout,
  nextScrollHeightPx: number,
): number | null {
  return clampScrollDistance(nextScrollHeightPx) === snapshot.scrollHeightPx
    ? null
    : Math.max(0, snapshot.distanceFromBottomPx + snapshot.wheelDistanceFromBottomPx);
}

export function footerResizeCompensation({
  currentDistanceFromBottomPx,
  footerResizeViewportPreserveDisabled,
  isScrollAnimationActive,
  nextFooterHeightPx,
  previousFooterHeightPx,
}: {
  readonly currentDistanceFromBottomPx: number;
  readonly footerResizeViewportPreserveDisabled: boolean;
  readonly isScrollAnimationActive: boolean;
  readonly nextFooterHeightPx: number;
  readonly previousFooterHeightPx: number | null;
}): number | null {
  if (
    previousFooterHeightPx === null
    || isScrollAnimationActive
    || footerResizeViewportPreserveDisabled
    || !isScrolledFromBottom(currentDistanceFromBottomPx)
  ) return null;
  return Math.max(
    0,
    currentDistanceFromBottomPx + nextFooterHeightPx - previousFooterHeightPx,
  );
}

export function footerScrollPaddingPx(footerHeightPx: number): number {
  return clampScrollDistance(footerHeightPx) + OPENCRAFT_FOOTER_GAP_PX;
}

export function resolveScrollOrigin(
  inputDirection: ScrollDirectionSample | null,
  previousDistanceFromBottomPx: number,
  nextDistanceFromBottomPx: number,
  nowMs: number,
): TurnScrollOrigin {
  if (inputDirection === null || !isDirectionSampleActive(inputDirection, nowMs)) return "system";
  return directionForDistanceChange(previousDistanceFromBottomPx, nextDistanceFromBottomPx)
    === inputDirection.direction
    ? "user"
    : "system";
}
