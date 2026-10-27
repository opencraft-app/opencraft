import { shellNavigationMetrics } from "@opencraft/workbench-runtime";

/** Header owns leading navigation/main chrome and trailing window actions.
 * The aperture between them belongs to the panel toolbar, including while
 * panes animate. Paint is derived from live pane geometry, never tab contents. */
export function headerSurfaceGeometry(windowWidth: number, mainViewportEnd: number,
  leadingMinimum: number, trailingWidth: number): { leadingWidth: number; trailingWidth: number } {
  const width = Math.max(0, windowWidth);
  const trailing = Math.min(width, Math.max(0, trailingWidth));
  return {
    leadingWidth: Math.min(width - trailing, Math.max(0, leadingMinimum, mainViewportEnd)),
    trailingWidth: trailing,
  };
}

/** Paint projection only. Window controls and content keep their own geometry.
 * The main surface's upper lip extends through the compact rail while the same
 * physical pane frames move; DOM retirement is never an animation clock.
 */
export function titlebarSurfaceGeometry(
  primaryWidth: number,
  contextWidth: number,
  contextProgress: number,
): { extensionLeft: number; extensionWidth: number; dividerProgress: number } {
  const primary = Math.max(0, primaryWidth);
  const context = Math.max(0, contextWidth);
  const progress = Math.max(0, Math.min(1, contextProgress));
  const { compactWidth, expandedMinimumWidth } = shellNavigationMetrics;
  const compactProgress = Math.max(0, Math.min(1,
    (expandedMinimumWidth - primary) / (expandedMinimumWidth - compactWidth),
  ));
  const extensionWidth = primary * compactProgress * (1 - progress);
  return {
    extensionLeft: context + primary - extensionWidth,
    extensionWidth,
    dividerProgress: Math.min(1, extensionWidth / compactWidth),
  };
}
