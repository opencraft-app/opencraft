export interface SidebarResizeConstraints {
  collapseBelowPx: number;
  minWidthPx: number;
  maxWidthPx: number;
}

export interface SidebarResizeResolution {
  isSidebarVisible: boolean;
  proposedWidthPx: number;
  sidebarWidthPx: number;
  reason: "within_bounds" | "min_clamped" | "max_clamped" | "collapse_requested";
}

export const DEFAULT_SIDEBAR_RESIZE_CONSTRAINTS: SidebarResizeConstraints = {
  collapseBelowPx: 176,
  minWidthPx: 232,
  maxWidthPx: 420,
};

export function resolveSidebarResize(
  proposedWidthPx: number,
  constraints: SidebarResizeConstraints = DEFAULT_SIDEBAR_RESIZE_CONSTRAINTS,
): SidebarResizeResolution {
  const roundedWidthPx = Number.isFinite(proposedWidthPx)
    ? Math.round(proposedWidthPx)
    : constraints.minWidthPx;
  if (roundedWidthPx < constraints.collapseBelowPx) {
    return {
      isSidebarVisible: false,
      proposedWidthPx: roundedWidthPx,
      reason: "collapse_requested",
      sidebarWidthPx: constraints.minWidthPx,
    };
  }

  const sidebarWidthPx = Math.min(
    constraints.maxWidthPx,
    Math.max(constraints.minWidthPx, roundedWidthPx),
  );
  const reason =
    sidebarWidthPx === constraints.minWidthPx && roundedWidthPx < constraints.minWidthPx
      ? "min_clamped"
      : sidebarWidthPx === constraints.maxWidthPx && roundedWidthPx > constraints.maxWidthPx
        ? "max_clamped"
        : "within_bounds";

  return {
    isSidebarVisible: true,
    proposedWidthPx: roundedWidthPx,
    reason,
    sidebarWidthPx,
  };
}

export function sidebarWidthCssValue(resolution: SidebarResizeResolution) {
  return `${resolution.sidebarWidthPx}px`;
}
