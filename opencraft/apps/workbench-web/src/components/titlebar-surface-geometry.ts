import { shellNavigationMetrics } from "@opencraft/workbench-runtime";

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
