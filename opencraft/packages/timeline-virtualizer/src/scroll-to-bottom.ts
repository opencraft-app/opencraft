import { CODEX_SCROLL_NEAR_BOTTOM_PX } from "./scroll";

export interface ScrollToBottomActionVisibilityInput {
  /** Raw state published by the platform-neutral scroll controller. */
  readonly isScrolledFromBottom: boolean;
  /** The current physical distance, including any synthetic response spacer. */
  readonly scrollDistanceFromBottomPx: number;
  /** Null when the host is not using the response-spacer layout. */
  readonly responseSpacerHeightPx: number | null;
}

/**
 * Recovered Codex visibility invariant for the Composer's floating bottom action.
 *
 * A response spacer deliberately moves the physical bottom away while the latest
 * Turn is being placed. That synthetic distance must not make the action appear.
 */
export function shouldShowScrollToBottomAction({
  isScrolledFromBottom,
  responseSpacerHeightPx,
  scrollDistanceFromBottomPx,
}: ScrollToBottomActionVisibilityInput): boolean {
  return responseSpacerHeightPx === null
    ? isScrolledFromBottom
    : scrollDistanceFromBottomPx
      > responseSpacerHeightPx + CODEX_SCROLL_NEAR_BOTTOM_PX;
}
