/** Projects shell panes with a readable main-pane minimum.
 * One projection for tool occupancy, chat aperture and text layout.
 * Maximization shrinks the aperture, never the ordinary chat layout. Below the
 * main reserve, the chat keeps a viewport-sized floor and slides out to the left.
 */
export function workspacePaneGeometry(
  workspaceWidth: number,
  splitWidth: number,
  visibility: number,
  fullWidthProgress: number,
  mainMinimum: number,
) {
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const width = Math.max(0, workspaceWidth);
  const regular = Math.max(0, Math.min(width, splitWidth));
  const contentWidth = regular + (width - regular) * clamp(fullWidthProgress);
  const occupiedWidth = clamp(visibility) * contentWidth;
  const viewportWidth = Math.max(0, width - occupiedWidth);
  // An unoccluded narrow window remains usable without horizontal overflow.
  const minimum = Math.min(width, Math.max(0, mainMinimum));
  const frameWidth = Math.max(minimum, width - Math.min(regular, occupiedWidth));
  return {
    contentWidth,
    occupiedWidth,
    viewportWidth,
    frameWidth,
    // Native right alignment realizes this offset in the same layout pass.
    frameX: Math.min(0, viewportWidth - frameWidth),
  };
}

/** Scope changes and reduced motion snap directly to the target pane state. */
export function paneTransitionIntent(previous: {scope: string; open: boolean; fullWidth: boolean},
  next: {scope: string; open: boolean; fullWidth: boolean}, reducedMotion: boolean) {
  return {
    snap: previous.scope !== next.scope || reducedMotion,
    forceVisibility: next.open && previous.fullWidth !== next.fullWidth,
    visibilityTarget: next.open ? 1 : 0,
    fullWidthTarget: next.fullWidth ? 1 : 0,
  };
}
