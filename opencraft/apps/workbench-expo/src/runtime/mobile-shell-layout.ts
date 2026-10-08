/** Presentation geometry only; never creates a Bot, View, Draft or navigation entry. */
export interface MobileShellLayoutMetrics {
  readonly sidebarWidth: number;
  readonly minimumContentWidth: number;
  readonly drawerWidthFraction: number;
  readonly drawerMaximumWidth: number;
  readonly panelMinimumWidth: number;
  readonly panelMaximumWidth: number;
  readonly panelInset: number;
}

export function resolveMobileShellLayout(width: number, metrics: MobileShellLayoutMetrics) {
  const availableWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const navigation = availableWidth >= metrics.sidebarWidth + metrics.minimumContentWidth ? "sidebar" : "drawer";
  const account = availableWidth >= metrics.panelMinimumWidth + metrics.panelInset * 2 ? "panel" : "page";
  return {
    navigation,
    navigationWidth: navigation === "sidebar" ? metrics.sidebarWidth
      : Math.min(availableWidth * metrics.drawerWidthFraction, metrics.drawerMaximumWidth),
    account,
    accountWidth: account === "panel" ? Math.min(metrics.panelMaximumWidth, availableWidth - metrics.panelInset * 2) : availableWidth,
  } as const;
}

/** A centered panel must clear its host's edge, not just move by its own width. */
export function resolveMobileSurfaceExitDistance(containerWidth: number, surfaceLeft: number) {
  const width = Number.isFinite(containerWidth) ? Math.max(0, containerWidth) : 0;
  const left = Number.isFinite(surfaceLeft) ? Math.min(width, Math.max(0, surfaceLeft)) : 0;
  return Math.max(1, width - left);
}
