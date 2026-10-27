import { OPENCRAFT_SCROLL_NEAR_BOTTOM_PX } from "./scroll";

export interface ScrollToBottomActionVisibilityInput {
  /** Raw state published by the platform-neutral scroll controller. */
  readonly isScrolledFromBottom: boolean;
  /** The current physical distance, including any synthetic response spacer. */
  readonly scrollDistanceFromBottomPx: number;
  /** Null when the host is not using the response-spacer layout. */
  readonly responseSpacerHeightPx: number | null;
}

export function shouldShowScrollToBottomAction({
  isScrolledFromBottom,
  responseSpacerHeightPx,
  scrollDistanceFromBottomPx,
}: ScrollToBottomActionVisibilityInput): boolean {
  return responseSpacerHeightPx === null
    ? isScrolledFromBottom
    : scrollDistanceFromBottomPx
      > responseSpacerHeightPx + OPENCRAFT_SCROLL_NEAR_BOTTOM_PX;
}
