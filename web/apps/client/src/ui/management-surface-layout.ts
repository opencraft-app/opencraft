import { breakpoints } from "./tokens";
import { workspaceLayoutMode, type LayoutMode } from "./workspace-layout-mode";

export type ManagementDensity = "comfortable" | "compact" | "medium";

export interface ManagementSurfaceLayout {
  chromeMode: LayoutMode;
  density: ManagementDensity;
  phone: boolean;
  /**
   * Collection sits in the frame navigation slot when false. Matches chrome
   * compact (under 960): once the rail is visible, management sidebars go
   * vertical too — Computer already did; agents/members/tasks had lagged at 1180.
   */
  stackedCollection: boolean;
}

/** One layout answer for every management collection + detail density. */
export function managementSurfaceLayout(width: number): ManagementSurfaceLayout {
  const chromeMode = workspaceLayoutMode(width);
  const phone = width < breakpoints.medium;
  return {
    chromeMode,
    density: phone
      ? "compact"
      : chromeMode === "wide"
        ? "comfortable"
        : "medium",
    phone,
    stackedCollection: chromeMode === "compact",
  };
}
