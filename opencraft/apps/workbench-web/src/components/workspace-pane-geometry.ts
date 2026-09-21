/** Codex 26.908.40834 Wba mainPaneWidth calculation.
 * R is the ordinary split width, A is actual animated content occupancy.
 * The viewport can shrink past W-R; the text-layout Frame cannot.
 */
export function workspacePaneGeometry(workspaceWidth: number, splitWidth: number, visibility: number, fullWidthProgress: number) {
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const contentWidth = splitWidth + (workspaceWidth - splitWidth) * clamp(fullWidthProgress);
  const occupiedWidth = clamp(visibility) * contentWidth;
  return {
    contentWidth,
    occupiedWidth,
    viewportWidth: Math.max(0, workspaceWidth - occupiedWidth),
    frameWidth: Math.max(0, workspaceWidth - Math.min(splitWidth, occupiedWidth)),
  };
}

/** Source Wba: scope changes and explicit snaps do not inherit old motion. */
export function paneTransitionIntent(previous: {scope: string; open: boolean; fullWidth: boolean},
  next: {scope: string; open: boolean; fullWidth: boolean}, reducedMotion: boolean) {
  return {
    snap: previous.scope !== next.scope || reducedMotion,
    forceVisibility: next.open && previous.fullWidth !== next.fullWidth,
    visibilityTarget: next.open ? 1 : 0,
    fullWidthTarget: next.fullWidth ? 1 : 0,
  };
}
