/** A local scroller should own a horizontal stroke only when it can move. */
export function hasNativeHorizontalOverflow(viewportWidth: number | null, contentWidth: number | null): boolean {
  // Until both native measurements arrive, preserve the scroller's gesture.
  if (viewportWidth === null || contentWidth === null || viewportWidth <= 0 || contentWidth <= 0) return true;
  return Number.isFinite(viewportWidth) && Number.isFinite(contentWidth)
    && contentWidth > viewportWidth + 1;
}
